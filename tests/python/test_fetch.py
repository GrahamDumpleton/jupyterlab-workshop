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
    read_limited,
    remove_tree,
    remove_workshop,
    unpack_archive,
)
from jupyterlab_workshop.library import standalone_directory

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

    def test_gist_url_and_revision_permalink(self) -> None:
        gist = "https://gist.github.com/ada/fee514f3051b532e3f790c2ae7068ed7"
        commit = "fd3e2455602748479661e24b710610cf6f3786ee"

        assert parse_source({"url": gist}) == Source(kind="git", url=gist)
        assert parse_source({"url": f"{gist}/{commit}/"}) == Source(
            kind="git", url=gist, ref=commit
        )
        assert parse_source({"url": f"{gist}/{commit}", "ref": "other"}).ref == "other"

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

    def test_gist(self) -> None:
        assert (
            archive_url(Source("git", "https://gist.github.com/ada/abc123"))
            == "https://gist.github.com/ada/abc123/archive/HEAD.tar.gz"
        )
        assert (
            archive_url(Source("git", "https://gist.github.com/ada/abc123", ref="def"))
            == "https://gist.github.com/ada/abc123/archive/def.tar.gz"
        )

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

    def test_unpacks_a_flat_gist(self, tmp_path: Path) -> None:
        # A gist archive wraps its files in `<id>-<ref>/`, like a forge
        # archive, and holds no directories, so the pages sit beside the
        # manifest.
        manifest = MANIFEST.replace("pages/01.md", "01.md")
        data = make_tar({"workshop.yaml": manifest, "01.md": "# One"}, "abc123-HEAD/")

        url = "https://gist.github.com/ada/abc123/archive/HEAD.tar.gz"

        unpack_archive(data, url, tmp_path)

        assert (tmp_path / "workshop.yaml").read_text() == manifest
        assert (tmp_path / "01.md").read_text() == "# One"

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

    def test_never_replaces_what_is_not_a_download_of_the_workshop(
        self, tmp_path: Path
    ) -> None:
        data = make_tar({"workshop.yaml": MANIFEST})
        mine = tmp_path / "workshops" / "demo"

        # A local workshop of the same name is left alone, whatever the
        # browser asks.
        mine.mkdir(parents=True)
        (mine / "workshop.yaml").write_text(MANIFEST)

        with pytest.raises(FetchError, match="not a download of this workshop"):
            fetch_workshop(
                Source("archive", "https://x/ws.tar.gz"),
                tmp_path,
                "workshops",
                overwrite=True,
                downloader=lambda _: data,
            )

        assert (mine / "workshop.yaml").read_text() == MANIFEST
        assert not (mine / "_workshop").exists()

        # So is a download from elsewhere.
        (mine / "_workshop").mkdir()
        (mine / "_workshop" / "source.json").write_text(
            json.dumps({"source": {"kind": "git", "url": "https://github.com/a/b"}})
        )

        with pytest.raises(FetchError, match="not a download of this workshop"):
            fetch_workshop(
                Source("git", "https://github.com/o/r"),
                tmp_path,
                "workshops",
                overwrite=True,
                downloader=lambda _: data,
            )

    def test_a_standalone_download_is_named_for_its_source(
        self, tmp_path: Path
    ) -> None:
        data = make_tar({"workshop.yaml": MANIFEST})
        source = Source("git", "https://github.com/o/r", ref="v1")
        result = fetch_workshop(
            source,
            tmp_path,
            "workshops/standalone",
            downloader=lambda _: data,
            standalone=True,
        )

        assert result.path == (
            "workshops/standalone/"
            + standalone_directory("demo", "git", "https://github.com/o/r")
        )

        # Another revision of the same source replaces it in place.
        again = fetch_workshop(
            Source("git", "https://github.com/o/r", ref="v2"),
            tmp_path,
            "workshops/standalone",
            overwrite=True,
            downloader=lambda _: data,
            standalone=True,
        )

        assert again.path == result.path

    def test_a_download_named_like_a_library_directory_cannot_replace_it(
        self, tmp_path: Path
    ) -> None:
        library = tmp_path / "workshops"
        own = library / "personal" / "mine"

        own.mkdir(parents=True)
        (own / "workshop.yaml").write_text(MANIFEST)
        (library / "library.json").write_text('{"version": 1}\n')

        # Sent to the top of the library, as where libraries are switched
        # off, a workshop called personal still cannot take its place.
        named = MANIFEST.replace("name: demo", "name: personal")
        data = make_tar({"workshop.yaml": named})

        with pytest.raises(FetchError, match="not a download of this workshop"):
            fetch_workshop(
                Source("git", "https://github.com/o/r"),
                tmp_path,
                "workshops",
                overwrite=True,
                downloader=lambda _: data,
            )

        assert (own / "workshop.yaml").is_file()

    def test_puts_a_gist_with_a_tree_file_back_together(self, tmp_path: Path) -> None:
        tree = {
            "version": 1,
            "files": [
                {"path": "workshop.yaml", "name": "workshop.yaml"},
                {"path": "pages/01.md", "name": "pages--01.md"},
                {
                    "path": "files/logo.png",
                    "name": "files--logo.png.base64",
                    "encoding": "base64",
                },
                {"path": "files/pkg/__init__.py", "empty": True},
            ],
        }
        files = {
            "workshop.yaml": MANIFEST,
            "pages--01.md": "# One\n",
            "files--logo.png.base64": "iVBO\nRw0K\n",
            "README.md": "# Generated\n",
            "workshop-tree.json": json.dumps(tree),
        }
        data = make_tar(files, "abc123-HEAD/")
        gist = Source("git", "https://gist.github.com/ada/abc123")

        result = fetch_workshop(gist, tmp_path, "workshops", downloader=lambda _: data)
        target = tmp_path / result.path

        # Each file is back at its path, the generated README and the tree
        # file are gone, and the source is recorded as usual.
        assert sorted(
            path.relative_to(target).as_posix()
            for path in target.rglob("*")
            if path.is_file()
        ) == [
            "_workshop/source.json",
            "files/logo.png",
            "files/pkg/__init__.py",
            "pages/01.md",
            "workshop.yaml",
        ]
        assert (target / "pages" / "01.md").read_text() == "# One\n"
        assert (target / "files" / "logo.png").read_bytes() == b"\x89PNG\r\n"
        assert (target / "files" / "pkg" / "__init__.py").read_bytes() == b""

        # The same files from a repository are taken as they are.
        repo = Source("git", "https://github.com/ada/flat")
        plain = fetch_workshop(
            repo, tmp_path, "plain", downloader=lambda _: make_tar(files)
        )

        assert (tmp_path / plain.path / "workshop-tree.json").is_file()
        assert (tmp_path / plain.path / "pages--01.md").is_file()

    def test_refuses_a_gist_tree_that_escapes(self, tmp_path: Path) -> None:
        tree = {
            "version": 1,
            "files": [
                {"path": "workshop.yaml", "name": "workshop.yaml"},
                {"path": "../outside.md", "name": "pages--01.md"},
            ],
        }
        data = make_tar(
            {
                "workshop.yaml": MANIFEST,
                "pages--01.md": "# One\n",
                "workshop-tree.json": json.dumps(tree),
            },
            "abc123-HEAD/",
        )
        gist = Source("git", "https://gist.github.com/ada/abc123")

        with pytest.raises(FetchError, match="not a file inside the workshop"):
            fetch_workshop(gist, tmp_path, "workshops", downloader=lambda _: data)

        assert not (tmp_path / "workshops").exists() or not any(
            (tmp_path / "workshops").iterdir()
        )
        assert not (tmp_path / "outside.md").exists()

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


class SlowResponse:
    """A response handing out fixed chunks, with a clock that moves per read."""

    def __init__(self, chunks: list[bytes], seconds_per_read: float = 0.0) -> None:
        self.chunks = list(chunks)
        self.seconds_per_read = seconds_per_read
        self.now = 0.0

    def read(self, size: int = -1, /) -> bytes:
        self.now += self.seconds_per_read

        return self.chunks.pop(0) if self.chunks else b""

    def clock(self) -> float:
        return self.now


def test_read_limited_joins_the_chunks() -> None:
    response = SlowResponse([b"abc", b"def", b"g"])

    assert read_limited(response, "https://x/a.tgz", clock=response.clock) == b"abcdefg"


def test_read_limited_stops_past_the_size_limit() -> None:
    response = SlowResponse([b"abcd", b"efgh", b"ijkl"])

    with pytest.raises(FetchError, match="larger than the limit"):
        read_limited(response, "https://x/a.tgz", limit=6, clock=response.clock)


def test_read_limited_stops_past_the_deadline() -> None:
    # Each read takes a second; the transfer as a whole may take two.
    response = SlowResponse([b"a"] * 10, seconds_per_read=1.0)

    with pytest.raises(FetchError, match="timed out after 2 seconds"):
        read_limited(response, "https://x/a.tgz", timeout=2.0, clock=response.clock)
