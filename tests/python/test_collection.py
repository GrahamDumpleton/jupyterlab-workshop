import json
import shutil
import subprocess
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

from jupyterlab_workshop.collection import (
    CollectionError,
    CollectionMetadata,
    build_collection,
    collection_metadata,
    describe_installed,
    find_workshops,
    guess_repository,
    https_remote,
    index_repository,
    list_installed,
    load_collection,
    parse_collection,
)

INDEX = {
    "version": 1,
    "title": "Test collection",
    "workshops": [
        {
            "name": "demo",
            "title": "Demo",
            "versions": [{"version": "1.0", "source": {"archive": "https://h/d.tgz"}}],
        }
    ],
}


@pytest.fixture
def index_url() -> Iterator[str]:
    """Serve the index from a local HTTP server."""

    body = json.dumps(INDEX).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)

    thread.start()

    try:
        yield f"http://127.0.0.1:{server.server_port}/index.json"
    finally:
        server.shutdown()
        server.server_close()


def test_load_collection_from_a_url(tmp_path: Path, index_url: str) -> None:
    index = load_collection(index_url, tmp_path)

    assert index["title"] == "Test collection"
    assert [item["name"] for item in index["workshops"]] == ["demo"]


def test_load_collection_from_a_file_under_the_root(tmp_path: Path) -> None:
    (tmp_path / "registry").mkdir()
    (tmp_path / "registry" / "index.json").write_text(json.dumps(INDEX))

    assert load_collection("registry/index.json", tmp_path)["version"] == 1

    with pytest.raises(CollectionError, match="outside"):
        load_collection("../elsewhere.json", tmp_path)

    with pytest.raises(CollectionError, match="no collection file"):
        load_collection("missing.json", tmp_path)

    with pytest.raises(CollectionError, match="Unsupported"):
        load_collection("ftp://host/index.json", tmp_path)


def test_parse_collection_checks_the_shape() -> None:
    with pytest.raises(CollectionError, match="not valid JSON"):
        parse_collection("{")

    with pytest.raises(CollectionError, match="version"):
        parse_collection(json.dumps({"version": 2, "workshops": []}))

    with pytest.raises(CollectionError, match="list of workshops"):
        parse_collection(json.dumps({"version": 1, "workshops": "none"}))


def test_build_collection_merges_entries_and_versions() -> None:
    first = {
        "name": "demo",
        "title": "Demo",
        "versions": [{"version": "1.0", "source": {"archive": "https://h/1.tgz"}}],
    }
    second = {
        "name": "demo",
        "title": "Demo again",
        "versions": [
            {"version": "1.10", "source": {"archive": "https://h/110.tgz"}},
            {"version": "1.9", "source": {"archive": "https://h/19.tgz"}},
        ],
    }
    other = {
        "name": "alpha",
        "title": "Alpha",
        "versions": [{"version": "0.1", "source": {"git": "https://g/a/b"}}],
    }

    index = build_collection(None, [first], CollectionMetadata(title="Mine"))
    index = build_collection(index, [second, other])

    # The existing entry keeps its place and the new one is appended.
    assert index["title"] == "Mine"
    assert [item["name"] for item in index["workshops"]] == ["demo", "alpha"]

    demo = index["workshops"][0]

    assert demo["title"] == "Demo again"
    assert [item["version"] for item in demo["versions"]] == ["1.10", "1.9", "1.0"]

    with pytest.raises(CollectionError, match="needs a name"):
        build_collection(None, [{"title": "Nameless"}])

    with pytest.raises(CollectionError, match="at least one version"):
        build_collection(None, [{"name": "x", "versions": []}])


def test_build_collection_keeps_and_updates_metadata() -> None:
    entry = {
        "name": "demo",
        "title": "Demo",
        "versions": [{"version": "1.0", "source": {"archive": "https://h/1.tgz"}}],
    }
    metadata = CollectionMetadata(
        title="Mine",
        description="About mine.",
        publisher="Me",
        publisher_url="https://me.example",
        homepage="https://mine.example",
        icon="icon.svg",
        tags=("a", "b"),
        ordered=True,
    )
    index = build_collection(None, [entry], metadata)

    assert index["ordered"] is True

    assert collection_metadata(index) == {
        "title": "Mine",
        "description": "About mine.",
        "publisher": {"name": "Me", "url": "https://me.example"},
        "homepage": "https://mine.example",
        "icon": "icon.svg",
        "tags": ["a", "b"],
    }

    # A later build without metadata keeps it; a given field replaces it.
    again = build_collection(index, [], CollectionMetadata(description="Changed."))

    assert again["title"] == "Mine"
    assert again["description"] == "Changed."
    assert again["publisher"] == {"name": "Me", "url": "https://me.example"}
    assert again["tags"] == ["a", "b"]
    assert again["ordered"] is True

    # Saying the workshops are unordered drops the flag; an index that
    # never had it stays without one.
    unordered = build_collection(again, [], CollectionMetadata(ordered=False))

    assert "ordered" not in unordered
    assert "ordered" not in build_collection(None, [entry])


def _write_workshop(directory: Path, name: str, done: int = 0) -> None:
    directory.mkdir(parents=True)
    (directory / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\n"
        f"name: {name}\ntitle: {name.title()}\nversion: 2.0\n"
        "pages: [pages/01.md, pages/02.md]\n"
    )

    if done:
        state = directory / "_workshop"

        state.mkdir()
        (state / "state.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "currentPage": "02",
                    "trust": "trusted",
                    "pages": {"01": {"done": True}, "02": {"done": False}},
                }
            )
        )
        (state / "source.json").write_text(
            json.dumps(
                {
                    "source": {"kind": "git", "url": "https://g/a/b"},
                    "sha256": "abc",
                    "collection": "https://g/collection.json",
                }
            )
        )


def test_list_installed_describes_workshops_with_progress(tmp_path: Path) -> None:
    _write_workshop(tmp_path / "workshops" / "beta", "beta", done=1)
    _write_workshop(tmp_path / "workshops" / "alpha", "alpha")
    (tmp_path / "workshops" / "notes").mkdir()

    records = list_installed(tmp_path, "workshops")

    assert [record["name"] for record in records] == ["alpha", "beta"]

    beta = records[1]

    assert beta["path"] == "workshops/beta"
    assert beta["version"] == "2.0"
    assert beta["pages"] == 2
    assert beta["done"] == 1
    assert beta["currentPage"] == "02"
    assert beta["trust"] == "trusted"
    assert beta["started"] is True
    assert beta["source"] == {"kind": "git", "url": "https://g/a/b"}
    assert beta["sha256"] == "abc"
    assert beta["collection"] == "https://g/collection.json"

    alpha = records[0]

    assert alpha["started"] is False
    assert alpha["source"] is None
    assert alpha["collection"] is None

    assert list_installed(tmp_path, "nowhere") == []

    with pytest.raises(CollectionError, match="outside"):
        list_installed(tmp_path, "../up")


def test_describe_installed_counts_only_the_visible_pages(tmp_path: Path) -> None:
    workshop = tmp_path / "ws"
    state = workshop / "_workshop"

    state.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: ws\ntitle: Ws\n"
        "pages: [pages/01.md, pages/02.md, pages/03.md]\n"
    )
    (state / "state.json").write_text(
        json.dumps(
            {
                "version": 1,
                "visiblePages": ["01", "03"],
                "pages": {"01": {"done": True}, "02": {"done": True}},
            }
        )
    )

    record = describe_installed(tmp_path, workshop)

    assert record is not None
    assert record["pages"] == 2
    assert record["done"] == 1


def test_describe_installed_ignores_broken_manifests(tmp_path: Path) -> None:
    broken = tmp_path / "broken"

    broken.mkdir()
    (broken / "workshop.yaml").write_text("- not: [a mapping")

    assert describe_installed(tmp_path, broken) is None


def test_find_workshops_skips_hidden_state_and_nested_directories(
    tmp_path: Path,
) -> None:
    for name in ["workshops/a", "workshops/b", "extra/deep/c"]:
        (tmp_path / name).mkdir(parents=True)
        (tmp_path / name / "workshop.yaml").write_text("name: x\n")

    (tmp_path / "workshops/a/nested").mkdir()
    (tmp_path / "workshops/a/nested/workshop.yaml").write_text("name: n\n")
    (tmp_path / ".hidden").mkdir()
    (tmp_path / ".hidden/workshop.yaml").write_text("name: h\n")
    (tmp_path / "node_modules/pkg").mkdir(parents=True)
    (tmp_path / "node_modules/pkg/workshop.yaml").write_text("name: m\n")

    found = [path.relative_to(tmp_path).as_posix() for path in find_workshops(tmp_path)]

    assert found == ["extra/deep/c", "workshops/a", "workshops/b"]


def test_index_repository_builds_git_sources(tmp_path: Path) -> None:
    workshop = tmp_path / "workshops" / "git-basics"
    workshop.mkdir(parents=True)
    workshop.joinpath("workshop.yaml").write_text(
        "name: git-basics\ntitle: Git\nversion: 1.2.0\ntags: [git]\n"
        "capabilities:\n  - terminal\n  - write-files: [workspace]\n"
        "homepage: https://example.org/git\n"
        "issues: https://example.org/git/issues\n"
        "pages: [pages/01.md]\n"
    )

    index = index_repository(
        tmp_path,
        [tmp_path / "workshops"],
        "https://github.com/org/repo",
        "main",
        metadata=CollectionMetadata(title="Mine"),
    )
    entry = index["workshops"][0]

    assert index["title"] == "Mine"
    assert entry["name"] == "git-basics"
    assert entry["capabilities"] == ["terminal", "write-files:workspace"]
    assert entry["homepage"] == "https://example.org/git"
    assert entry["issues"] == "https://example.org/git/issues"
    assert entry["versions"] == [
        {
            "version": "1.2.0",
            "source": {
                "git": "https://github.com/org/repo",
                "ref": "main",
                "subdir": "workshops/git-basics",
            },
        }
    ]

    # A workshop at the root has no subdir, and re-indexing at another ref
    # keeps the earlier version.
    (tmp_path / "workshops").rename(tmp_path / "old")
    shutil.rmtree(tmp_path / "old")
    (tmp_path / "workshop.yaml").write_text(
        "name: git-basics\ntitle: Git\nversion: 1.3.0\npages: [pages/01.md]\n"
    )

    again = index_repository(
        tmp_path, [tmp_path], "https://github.com/org/repo", "v1.3", index
    )
    versions = again["workshops"][0]["versions"]

    assert [item["version"] for item in versions] == ["1.3.0", "1.2.0"]
    assert versions[0]["source"] == {
        "git": "https://github.com/org/repo",
        "ref": "v1.3",
    }

    with pytest.raises(CollectionError):
        index_repository(tmp_path, [tmp_path / "missing"], "https://x", "main")

    with pytest.raises(CollectionError):
        index_repository(tmp_path / "sub", [tmp_path], "https://x", "main")


def test_https_remote_rewrites_ssh_forms() -> None:
    assert https_remote("git@github.com:org/repo.git") == "https://github.com/org/repo"
    assert (
        https_remote("ssh://git@gitlab.com/org/repo.git")
        == "https://gitlab.com/org/repo"
    )
    assert (
        https_remote("https://github.com/org/repo.git") == "https://github.com/org/repo"
    )
    assert https_remote("https://github.com/org/repo/") == "https://github.com/org/repo"
    assert https_remote("") == ""


def test_guess_repository_reads_the_checkout(tmp_path: Path) -> None:
    if shutil.which("git") is None:
        pytest.skip("needs git")

    assert guess_repository(tmp_path) == ("", "")

    subprocess.run(["git", "init", "-q", "-b", "main", str(tmp_path)], check=True)
    remote = "git@github.com:o/r.git"

    subprocess.run(
        ["git", "-C", str(tmp_path), "remote", "add", "origin", remote], check=True
    )

    assert guess_repository(tmp_path) == ("https://github.com/o/r", "main")
