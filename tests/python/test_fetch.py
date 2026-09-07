import io
import json
import tarfile
import zipfile
from pathlib import Path

import pytest

from jupyterlab_workshop.fetch import (
    FetchError,
    Source,
    archive_url,
    fetch_workshop,
    parse_source,
    remove_tree,
    remove_workshop,
    unpack_archive,
)

MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\n"
    "name: demo\ntitle: Demo\npages: [pages/01.md]\n"
)


def make_tar(files: dict[str, str], prefix: str = "repo-main/") -> bytes:
    stream = io.BytesIO()

    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(prefix + name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))

    return stream.getvalue()


def make_zip(files: dict[str, str], prefix: str = "repo-main/") -> bytes:
    stream = io.BytesIO()

    with zipfile.ZipFile(stream, "w") as archive:
        for name, content in files.items():
            archive.writestr(prefix + name, content)

    return stream.getvalue()


class TestParseSource:
    def test_github_tree_url_gives_ref_and_subdir(self) -> None:
        source = parse_source(
            {
                "url": "https://github.com/GrahamDumpleton/workshops/tree/v1.2.0/git-basics"
            }
        )

        assert source == Source(
            kind="git",
            url="https://github.com/GrahamDumpleton/workshops",
            ref="v1.2.0",
            subdir="git-basics",
        )
        assert (
            source.key()
            == "git:https://github.com/GrahamDumpleton/workshops@v1.2.0/git-basics"
        )

    def test_explicit_fields_win_over_the_url(self) -> None:
        source = parse_source(
            {"git": "https://gitlab.com/group/repo.git", "ref": "main", "subdir": "ws"}
        )

        assert source.url == "https://gitlab.com/group/repo"
        assert source.ref == "main"
        assert source.subdir == "ws"

    def test_archive_suffix_is_an_archive(self) -> None:
        source = parse_source({"url": "https://example.org/ws.tar.gz", "sha256": "AB"})

        assert source == Source(
            kind="archive", url="https://example.org/ws.tar.gz", sha256="ab"
        )
        assert source.key() == "archive:https://example.org/ws.tar.gz"

    def test_rejects_non_http_and_dotdot(self) -> None:
        with pytest.raises(FetchError):
            parse_source({"url": "file:///etc/passwd"})

        with pytest.raises(FetchError):
            parse_source({"git": "https://github.com/o/r", "subdir": "../x"})

        with pytest.raises(FetchError):
            parse_source({})


class TestArchiveUrl:
    def test_forges(self) -> None:
        assert (
            archive_url(Source("git", "https://github.com/o/r", ref="v1"))
            == "https://github.com/o/r/archive/v1.tar.gz"
        )
        assert (
            archive_url(Source("git", "https://gitlab.com/g/sub/r", ref="main"))
            == "https://gitlab.com/g/sub/r/-/archive/main/r-main.tar.gz"
        )
        assert (
            archive_url(Source("git", "https://codeberg.org/o/r"))
            == "https://codeberg.org/o/r/archive/HEAD.tar.gz"
        )
        assert archive_url(Source("archive", "https://x/y.zip")) == "https://x/y.zip"

    def test_needs_owner_and_repo(self) -> None:
        with pytest.raises(FetchError):
            archive_url(Source("git", "https://github.com/only"))


class TestUnpack:
    def test_strips_the_top_directory_from_tar_and_zip(self, tmp_path: Path) -> None:
        files = {"workshop.yaml": MANIFEST, "pages/01.md": "# Hi\n"}

        for index, data in enumerate([make_tar(files), make_zip(files)]):
            target = tmp_path / f"out{index}"

            unpack_archive(data, "https://x/a", target)

            assert (target / "workshop.yaml").read_text() == MANIFEST
            assert (target / "pages" / "01.md").read_text() == "# Hi\n"

    def test_keeps_only_the_subdirectory(self, tmp_path: Path) -> None:
        data = make_tar(
            {
                "README.md": "top\n",
                "ws/workshop.yaml": MANIFEST,
                "ws/pages/01.md": "page\n",
                "other/workshop.yaml": "nope\n",
            }
        )
        target = tmp_path / "out"

        unpack_archive(data, "https://x/a", target, "ws")

        assert (target / "workshop.yaml").read_text() == MANIFEST
        assert not (target / "README.md").exists()
        assert not (target / "other").exists()

    def test_missing_subdirectory_or_manifest_fails(self, tmp_path: Path) -> None:
        data = make_tar({"workshop.yaml": MANIFEST})

        with pytest.raises(FetchError, match="no directory named missing"):
            unpack_archive(data, "https://x/a", tmp_path / "a", "missing")

        with pytest.raises(FetchError, match="does not contain"):
            unpack_archive(make_tar({"README.md": "x"}), "https://x/a", tmp_path / "b")

    def test_ignores_members_that_escape(self, tmp_path: Path) -> None:
        stream = io.BytesIO()

        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            for name, content in {
                "repo/workshop.yaml": MANIFEST,
                "repo/../../escape.txt": "bad",
                "/abs.txt": "bad",
            }.items():
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content.encode()))

            link = tarfile.TarInfo("repo/link")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            archive.addfile(link)

        target = tmp_path / "out"

        unpack_archive(stream.getvalue(), "https://x/a", target)

        assert (target / "workshop.yaml").exists()
        assert not (target / "link").exists()
        assert not (tmp_path / "escape.txt").exists()
        assert not list(tmp_path.glob("**/abs.txt"))

    def test_not_an_archive(self, tmp_path: Path) -> None:
        with pytest.raises(FetchError, match="not a zip or tar"):
            unpack_archive(b"<html>", "https://x/a", tmp_path / "out")


class TestFetchWorkshop:
    def test_downloads_unpacks_and_records_the_source(self, tmp_path: Path) -> None:
        data = make_tar({"workshop.yaml": MANIFEST, "pages/01.md": "page\n"})
        calls: list[str] = []

        def fake_download(url: str) -> bytes:
            calls.append(url)

            return data

        source = Source("git", "https://github.com/o/r", ref="v1")
        result = fetch_workshop(source, tmp_path, "workshops", downloader=fake_download)

        assert calls == ["https://github.com/o/r/archive/v1.tar.gz"]
        assert result.path == "workshops/demo"
        assert result.name == "demo"
        assert len(result.sha256) == 64
        assert (tmp_path / "workshops" / "demo" / "workshop.yaml").exists()

        record = json.loads(
            (tmp_path / "workshops" / "demo" / "_workshop" / "source.json").read_text()
        )

        assert record["source"] == {
            "kind": "git",
            "url": "https://github.com/o/r",
            "ref": "v1",
            "sha256": result.sha256,
        }
        assert record["sha256"] == result.sha256
        assert "collection" not in record

    def test_records_the_collection_and_the_given_name(self, tmp_path: Path) -> None:
        data = make_tar({"workshop.yaml": MANIFEST})
        source = Source("archive", "https://x/ws.tar.gz")
        result = fetch_workshop(
            source,
            tmp_path,
            "workshops",
            name="demo-1a2b3c4",
            downloader=lambda _: data,
            collection="https://x/collection.json",
        )

        assert result.path == "workshops/demo-1a2b3c4"

        record = json.loads(
            (tmp_path / result.path / "_workshop" / "source.json").read_text()
        )

        assert record["collection"] == "https://x/collection.json"

    def test_refuses_existing_unless_overwrite(self, tmp_path: Path) -> None:
        data = make_tar({"workshop.yaml": MANIFEST})
        source = Source("archive", "https://x/ws.tar.gz")

        fetch_workshop(source, tmp_path, "workshops", downloader=lambda _: data)

        with pytest.raises(FetchError, match="already exists"):
            fetch_workshop(source, tmp_path, "workshops", downloader=lambda _: data)

        (tmp_path / "workshops" / "demo" / "stale.txt").write_text("old")
        fetch_workshop(
            source, tmp_path, "workshops", overwrite=True, downloader=lambda _: data
        )

        assert not (tmp_path / "workshops" / "demo" / "stale.txt").exists()

    def test_checks_the_expected_hash(self, tmp_path: Path) -> None:
        data = make_tar({"workshop.yaml": MANIFEST})
        source = Source("archive", "https://x/ws.tar.gz", sha256="0" * 64)

        with pytest.raises(FetchError, match="does not match"):
            fetch_workshop(source, tmp_path, "workshops", downloader=lambda _: data)

    def test_directory_must_stay_inside_root(self, tmp_path: Path) -> None:
        data = make_tar({"workshop.yaml": MANIFEST})

        with pytest.raises(FetchError, match="outside"):
            fetch_workshop(
                Source("archive", "https://x/a.zip"),
                tmp_path,
                "../elsewhere",
                downloader=lambda _: data,
            )


class TestRemoveWorkshop:
    def test_removes_only_workshop_directories(self, tmp_path: Path) -> None:
        workshop = tmp_path / "workshops" / "demo"
        workshop.mkdir(parents=True)
        (workshop / "workshop.yaml").write_text(MANIFEST)
        (tmp_path / "notes").mkdir()

        assert remove_workshop(tmp_path, "workshops/demo") == "workshops/demo"
        assert not workshop.exists()

        with pytest.raises(FetchError, match="not a workshop"):
            remove_workshop(tmp_path, "notes")

        with pytest.raises(FetchError, match="outside"):
            remove_workshop(tmp_path, "../x")

        with pytest.raises(FetchError, match="server root"):
            remove_workshop(tmp_path, "")


def test_remove_tree_clears_read_only_files(tmp_path: Path) -> None:
    # Git object files are read-only, which blocks deletion on Windows.
    tree = tmp_path / "repo"
    objects = tree / ".git" / "objects"
    objects.mkdir(parents=True)
    blob = objects / "abc"
    blob.write_text("data")
    blob.chmod(0o444)

    remove_tree(tree)

    assert not tree.exists()
