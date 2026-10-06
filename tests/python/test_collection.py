import json
import shutil
import subprocess
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

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
    list_projects,
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


def test_list_installed_records_keep_their_fields_outside_a_library(
    tmp_path: Path,
) -> None:
    # The records the browser, the CLI and the MCP tools read today; a
    # directory that is not a workshop library must keep giving exactly
    # these, with nothing added.
    _write_workshop(tmp_path / "workshops" / "beta", "beta", done=1)

    (record,) = list_installed(tmp_path, "workshops")

    assert sorted(record) == [
        "collection",
        "currentPage",
        "description",
        "done",
        "frontends",
        "instanceId",
        "name",
        "pages",
        "path",
        "platforms",
        "resumable",
        "sha256",
        "source",
        "started",
        "tags",
        "title",
        "trust",
        "version",
    ]


def _write_library(root: Path, registry: dict[str, Any]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "library.json").write_text(json.dumps(registry))


def test_list_installed_scans_a_library_only_when_asked(tmp_path: Path) -> None:
    library = tmp_path / "lib"

    _write_library(library, {"version": 1})
    _write_workshop(library / "flat-download", "flat-download", done=1)
    _write_workshop(library / "flat-local", "flat-local")
    _write_workshop(library / "installed" / "example.org-c" / "alpha", "alpha")
    _write_workshop(library / "personal" / "mine", "mine")
    _write_workshop(library / "projects" / "repo" / "workshops" / "draft", "draft")

    # The endpoint's call sees a plain workshops directory, as before.
    plain = list_installed(tmp_path, "lib")

    assert [record["name"] for record in plain] == ["flat-download", "flat-local"]
    assert all("kind" not in record for record in plain)

    scanned = {
        record["name"]: record for record in list_installed(tmp_path, "lib", True)
    }

    assert {name: record["kind"] for name, record in scanned.items()} == {
        "alpha": "installed",
        "draft": "project",
        "flat-download": "installed",
        "flat-local": None,
        "mine": "personal",
    }
    assert scanned["draft"]["project"] == "repo"
    assert scanned["draft"]["path"] == "lib/projects/repo/workshops/draft"
    assert scanned["alpha"]["path"] == "lib/installed/example.org-c/alpha"

    # Asking for the layout of a directory with no registry changes nothing.
    assert list_installed(tmp_path, "lib/personal", True)[0].keys() == (plain[0].keys())


def test_list_installed_follows_the_project_workshops_directory(
    tmp_path: Path,
) -> None:
    _write_library(
        tmp_path,
        {"version": 1, "projects": [{"name": "repo", "workshops": "examples"}]},
    )
    _write_workshop(tmp_path / "projects" / "repo" / "examples" / "one", "one")
    _write_workshop(tmp_path / "projects" / "repo" / "workshops" / "not", "not")

    records = list_installed(tmp_path, ".", True)

    assert [(record["name"], record["path"]) for record in records] == [
        ("one", "projects/repo/examples/one")
    ]


def test_list_installed_does_not_look_inside_a_workshop(tmp_path: Path) -> None:
    _write_library(tmp_path, {"version": 1})

    # A workshop that happens to be called "personal" is listed once at
    # the top, not treated as the personal tree.
    _write_workshop(tmp_path / "personal", "personal")
    _write_workshop(tmp_path / "personal" / "inner", "inner")

    assert [record["name"] for record in list_installed(tmp_path, "", True)] == [
        "personal"
    ]


def test_list_installed_reports_a_broken_registry(tmp_path: Path) -> None:
    (tmp_path / "library.json").write_text('{"version": 9}')

    # The plain listing never reads the registry.
    assert list_installed(tmp_path, ".") == []

    with pytest.raises(CollectionError, match="unsupported version"):
        list_installed(tmp_path, ".", True)


def test_list_projects_lists_directories_links_and_missing_links(
    tmp_path: Path,
) -> None:
    library = tmp_path / "lib"
    outside = tmp_path / "elsewhere" / "linked-repo"
    gone = tmp_path / "elsewhere" / "gone-repo"

    outside.mkdir(parents=True)
    gone.mkdir(parents=True)
    (library / "projects" / "cloned").mkdir(parents=True)
    (library / "projects" / "linked").symlink_to(outside, target_is_directory=True)
    (library / "projects" / "dangling").symlink_to(gone, target_is_directory=True)
    gone.rmdir()

    _write_library(
        library,
        {
            "version": 1,
            "projects": [
                {"name": "linked", "target": outside.as_posix()},
                {"name": "dangling", "target": gone.as_posix()},
                {"name": "unmade", "target": (tmp_path / "x").as_posix()},
                {"name": "cloned", "workshops": "examples"},
            ],
        },
    )

    projects = {project["name"]: project for project in list_projects(tmp_path, "lib")}

    assert sorted(projects) == ["cloned", "dangling", "linked", "unmade"]
    assert projects["cloned"] == {
        "name": "cloned",
        "path": "lib/projects/cloned",
        "workshops": "examples",
        "target": None,
        "linked": False,
        "missing": False,
    }
    assert projects["linked"]["linked"] is True
    assert projects["linked"]["missing"] is False
    assert projects["dangling"]["missing"] is True
    assert projects["unmade"]["missing"] is True

    assert list_projects(tmp_path, "elsewhere") == []


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
        "capabilities:\n  - terminal\n  - write-files\n"
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
    assert entry["capabilities"] == ["terminal", "write-files"]
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


def test_index_repository_follows_an_order_that_is_spelled_out(tmp_path: Path) -> None:
    def workshop(name: str) -> Path:
        directory = tmp_path / "workshops" / name
        directory.mkdir(parents=True)
        directory.joinpath("workshop.yaml").write_text(
            f"name: {name}\ntitle: {name}\nversion: 1.0.0\npages: [pages/01.md]\n"
        )

        return directory

    def names(index: dict[str, Any]) -> list[str]:
        return [item["name"] for item in index["workshops"]]

    first, third = workshop("what-it-does"), workshop("how-it-remembers")

    # Named one by one, the workshops are listed as named, not by path.
    index = index_repository(tmp_path, [first, third], "https://x/y", "main")

    assert names(index) == ["what-it-does", "how-it-remembers"]

    # A workshop added later goes where the order given puts it, and the
    # versions already listed stay with their entries.
    second = workshop("a-first-one")
    index = index_repository(
        tmp_path, [first, second, third], "https://x/y", "v2", index
    )

    assert names(index) == ["what-it-does", "a-first-one", "how-it-remembers"]
    assert [item["source"]["ref"] for item in index["workshops"][0]["versions"]] == [
        "v2"
    ]

    # Searching a directory says nothing about order: what is listed keeps
    # its place, and only something new is added, at the end.
    fourth = workshop("b-last-one")
    searched = index_repository(
        tmp_path, [tmp_path / "workshops"], "https://x/y", "v2", index
    )

    assert names(searched) == [
        "what-it-does",
        "a-first-one",
        "how-it-remembers",
        "b-last-one",
    ]

    # Naming only some of what is listed gives the rest no place, so the
    # order is left alone.
    partial = index_repository(tmp_path, [fourth, first], "https://x/y", "v2", searched)

    assert names(partial) == names(searched)


def test_index_repository_carries_the_analytics_block(tmp_path: Path) -> None:
    workshop = tmp_path / "workshops" / "one"
    workshop.mkdir(parents=True)
    workshop.joinpath("workshop.yaml").write_text(
        "name: one\ntitle: One\nversion: 1.0.0\n"
        "frontends: [jupyterlab, jupyterlite]\npages: [pages/01.md]\n"
    )

    # Without collection.yaml there is no block; the entry carries the
    # manifest's frontends either way.
    index = index_repository(tmp_path, [tmp_path], "https://x/y", "main")

    assert "analytics" not in index
    assert index["workshops"][0]["frontends"] == ["jupyterlab", "jupyterlite"]

    (tmp_path / "collection.yaml").write_text(
        "analytics:\n  sink: https://a.example.org/events\n  token: t.o.k\n"
        "  labels:\n    course: intro\n    year: 2026\n"
    )

    index = index_repository(tmp_path, [tmp_path], "https://x/y", "main")

    assert list(index) == ["version", "analytics", "workshops"]
    assert index["analytics"] == {
        "sink": "https://a.example.org/events",
        "token": "t.o.k",
        "labels": {"course": "intro", "year": "2026"},
    }

    # Regenerating without the file keeps the block the index already had.
    (tmp_path / "collection.yaml").unlink()

    again = index_repository(tmp_path, [tmp_path], "https://x/y", "main", index)

    assert again["analytics"] == index["analytics"]

    # Mistakes are refused rather than published: unknown keys, a bad
    # sink, and labels outside the rules.
    for text in [
        "analytic:\n  sink: https://a\n",
        "analytics:\n  sink: ftp://a\n",
        "analytics:\n  colour: red\n",
        "analytics:\n  labels:\n    Course: x\n",
        "analytics:\n  labels:\n    a: " + "x" * 129 + "\n",
        "analytics:\n  labels:\n" + "".join(f"    k{i}: v\n" for i in range(17)),
        "- a list\n",
    ]:
        (tmp_path / "collection.yaml").write_text(text)

        with pytest.raises(CollectionError):
            index_repository(tmp_path, [tmp_path], "https://x/y", "main")


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
