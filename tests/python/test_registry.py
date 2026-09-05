import json
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

from jupyterlab_workshop.registry import (
    RegistryError,
    build_registry,
    describe_installed,
    list_installed,
    load_registry,
    parse_registry,
)

INDEX = {
    "version": 1,
    "title": "Test registry",
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


def test_load_registry_from_a_url(tmp_path: Path, index_url: str) -> None:
    index = load_registry(index_url, tmp_path)

    assert index["title"] == "Test registry"
    assert [item["name"] for item in index["workshops"]] == ["demo"]


def test_load_registry_from_a_file_under_the_root(tmp_path: Path) -> None:
    (tmp_path / "registry").mkdir()
    (tmp_path / "registry" / "index.json").write_text(json.dumps(INDEX))

    assert load_registry("registry/index.json", tmp_path)["version"] == 1

    with pytest.raises(RegistryError, match="outside"):
        load_registry("../elsewhere.json", tmp_path)

    with pytest.raises(RegistryError, match="no registry file"):
        load_registry("missing.json", tmp_path)

    with pytest.raises(RegistryError, match="Unsupported"):
        load_registry("ftp://host/index.json", tmp_path)


def test_parse_registry_checks_the_shape() -> None:
    with pytest.raises(RegistryError, match="not valid JSON"):
        parse_registry("{")

    with pytest.raises(RegistryError, match="version"):
        parse_registry(json.dumps({"version": 2, "workshops": []}))

    with pytest.raises(RegistryError, match="list of workshops"):
        parse_registry(json.dumps({"version": 1, "workshops": "none"}))


def test_build_registry_merges_entries_and_versions() -> None:
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

    index = build_registry(None, [first], title="Mine")
    index = build_registry(index, [second, other])

    assert index["title"] == "Mine"
    assert [item["name"] for item in index["workshops"]] == ["alpha", "demo"]

    demo = index["workshops"][1]

    assert demo["title"] == "Demo again"
    assert [item["version"] for item in demo["versions"]] == ["1.10", "1.9", "1.0"]

    with pytest.raises(RegistryError, match="needs a name"):
        build_registry(None, [{"title": "Nameless"}])

    with pytest.raises(RegistryError, match="at least one version"):
        build_registry(None, [{"name": "x", "versions": []}])


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

    alpha = records[0]

    assert alpha["started"] is False
    assert alpha["source"] is None

    assert list_installed(tmp_path, "nowhere") == []

    with pytest.raises(RegistryError, match="outside"):
        list_installed(tmp_path, "../up")


def test_describe_installed_ignores_broken_manifests(tmp_path: Path) -> None:
    broken = tmp_path / "broken"

    broken.mkdir()
    (broken / "workshop.yaml").write_text("- not: [a mapping")

    assert describe_installed(tmp_path, broken) is None
