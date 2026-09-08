import io
import json
import tarfile
from pathlib import Path

import pytest

from jupyterlab_workshop import cli
from jupyterlab_workshop.fetch import FetchError
from jupyterlab_workshop.install import (
    collection_hash,
    collection_location,
    install_collection,
    install_name,
    is_installed_from,
    normalize_location,
)

MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\n"
    "name: {name}\ntitle: {title}\npages: [pages/01.md]\n"
)


def archive_for(name: str, title: str) -> bytes:
    files = {
        "workshop.yaml": MANIFEST.format(name=name, title=title),
        "pages/01.md": f"---\ntitle: Start\n---\n\n# {title}\n",
    }
    stream = io.BytesIO()

    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for path, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(f"{name}-1.0/{path}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))

    return stream.getvalue()


def write_collection(root: Path, workshops: list[dict[str, object]]) -> Path:
    index = root / "collections" / "collection.json"

    index.parent.mkdir(parents=True)
    index.write_text(
        json.dumps({"version": 1, "title": "Course", "workshops": workshops})
    )

    return index


def entry(name: str, title: str, url: str, **extra: object) -> dict[str, object]:
    return {
        "name": name,
        "title": title,
        "versions": [{"version": "1.0", "source": {"archive": url}}],
        **extra,
    }


def test_locations_normalise_the_way_the_browser_does() -> None:
    assert normalize_location(" HTTPS://Example.ORG/c/collection.json/ ") == (
        "https://example.org/c/collection.json"
    )
    assert normalize_location("collections/collection.json/") == (
        "collections/collection.json"
    )
    assert collection_hash("https://example.org/c.json") == collection_hash(
        "HTTPS://EXAMPLE.org/c.json"
    )
    assert len(collection_hash("x")) == 7


def test_installed_records_match_by_collection_then_by_name() -> None:
    mine = "https://example.org/mine.json"
    theirs = "https://example.org/theirs.json"

    assert is_installed_from({"name": "a", "collection": mine}, mine, "a")
    assert is_installed_from({"name": "a", "collection": None}, mine, "a")
    assert not is_installed_from({"name": "a", "collection": theirs}, mine, "a")
    assert not is_installed_from({"name": "b", "collection": mine}, mine, "a")

    # Only another collection's install of the same name forces the suffix.
    assert install_name("a", mine, [{"name": "a", "collection": mine}]) == "a"
    assert install_name("a", mine, [{"name": "a", "collection": None}]) == "a"
    assert install_name("a", mine, [{"name": "a", "collection": theirs}]) == (
        f"a-{collection_hash(mine)}"
    )


def test_collection_location_records_files_relative_to_the_root(
    tmp_path: Path,
) -> None:
    inside = tmp_path / "collections" / "collection.json"
    outside = tmp_path.parent / "elsewhere.json"

    assert collection_location("https://h/c.json", tmp_path) == (
        "https://h/c.json",
        "https://h/c.json",
        tmp_path,
    )
    assert collection_location(str(inside), tmp_path) == (
        "collection.json",
        "collections/collection.json",
        inside.parent,
    )
    assert (
        collection_location(str(outside), tmp_path)[1] == outside.resolve().as_posix()
    )


def test_install_collection_downloads_what_is_missing_and_records_it(
    tmp_path: Path,
) -> None:
    index = write_collection(
        tmp_path,
        [
            entry("alpha", "Alpha", "https://h/alpha.tgz"),
            entry("beta", "Beta", "https://h/beta.tgz", platforms=["windows"]),
            entry("gamma", "Gamma", "https://h/gamma.tgz"),
        ],
    )
    archives = {
        "https://h/alpha.tgz": archive_for("alpha", "Alpha"),
        "https://h/beta.tgz": archive_for("beta", "Beta"),
    }
    lines: list[str] = []

    def downloader(url: str) -> bytes:
        if url not in archives:
            raise FetchError(f"Unable to download {url}: no such file")

        return archives[url]

    outcomes = install_collection(
        str(index),
        tmp_path,
        platform="linux",
        downloader=downloader,
        report=lines.append,
    )

    assert [(item.name, item.status) for item in outcomes] == [
        ("alpha", "installed"),
        ("beta", "skipped"),
        ("gamma", "failed"),
    ]
    assert outcomes[0].detail == "workshops/alpha"
    assert outcomes[1].detail == "not for linux"
    assert "no such file" in outcomes[2].detail
    assert lines[0] == "installed alpha: workshops/alpha"

    # The install records the collection by its path under the root, so a
    # browser subscribed to that file matches it, and a second run skips it.
    source = json.loads(
        (tmp_path / "workshops" / "alpha" / "_workshop" / "source.json").read_text()
    )

    assert source["collection"] == "collections/collection.json"

    again = install_collection(
        str(index), tmp_path, only=["alpha"], downloader=downloader
    )

    assert [(item.name, item.status, item.detail) for item in again] == [
        ("alpha", "skipped", "installed already")
    ]

    with pytest.raises(FetchError, match="does not list delta"):
        install_collection(str(index), tmp_path, only=["delta"], downloader=downloader)


def test_install_collection_suffixes_a_clash_with_another_collection(
    tmp_path: Path,
) -> None:
    index = write_collection(tmp_path, [entry("alpha", "Alpha", "https://h/a.tgz")])
    other = "https://example.org/other.json"

    # Something else already installed an alpha from another collection.
    theirs = tmp_path / "workshops" / "alpha"

    theirs.mkdir(parents=True)
    (theirs / "workshop.yaml").write_text(MANIFEST.format(name="alpha", title="Theirs"))
    (theirs / "_workshop").mkdir()
    (theirs / "_workshop" / "source.json").write_text(
        json.dumps({"collection": other, "source": {"kind": "archive", "url": "x"}})
    )

    outcomes = install_collection(
        str(index), tmp_path, downloader=lambda _: archive_for("alpha", "Alpha")
    )
    expected = f"workshops/alpha-{collection_hash('collections/collection.json')}"

    assert [(item.status, item.detail) for item in outcomes] == [
        ("installed", expected)
    ]
    assert (tmp_path / expected / "workshop.yaml").is_file()


def test_install_command_reports_and_fails_on_a_bad_source(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # An ftp archive is refused before any network is touched, so the run
    # reports a failure and exits non-zero without a download.
    index = write_collection(tmp_path, [entry("alpha", "Alpha", "ftp://h/alpha.tgz")])

    assert (
        cli.main(
            ["install", str(index), "--root", str(tmp_path), "--platform", "linux"]
        )
        == 1
    )

    out = capsys.readouterr().out

    assert "failed alpha: Only http and https sources are supported" in out
    assert out.rstrip().endswith("0 installed, 0 skipped, 1 failed")

    assert (
        cli.main(["install", str(tmp_path / "missing.json"), "--root", str(tmp_path)])
        == 2
    )
    assert "There is no collection file" in capsys.readouterr().err
