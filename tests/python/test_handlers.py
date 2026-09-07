import io
import json
import tarfile
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest


async def test_platform_endpoint_reports_the_server_environment(jp_fetch, jp_root_dir):
    response = await jp_fetch("jupyterlab-workshop", "platform")

    assert response.code == 200

    payload = json.loads(response.body)

    assert set(payload) == {
        "os",
        "shell",
        "home",
        "user",
        "path_sep",
        "root_dir",
        "hub_user",
        "host",
        "container",
    }
    assert payload["os"] in {"linux", "macos", "windows"}
    assert payload["root_dir"] == str(jp_root_dir)


MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\n"
    "name: demo\ntitle: Demo\npages: [pages/01.md]\n"
)


def _make_tar() -> bytes:
    stream = io.BytesIO()

    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for name, content in {
            "repo-main/workshop.yaml": MANIFEST,
            "repo-main/pages/01.md": "# Page\n",
        }.items():
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))

    return stream.getvalue()


@pytest.fixture
def archive_url() -> Iterator[str]:
    """Serve a workshop archive from a local HTTP server."""

    archive = _make_tar()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Length", str(len(archive)))
            self.end_headers()
            self.wfile.write(archive)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)

    thread.start()

    try:
        yield f"http://127.0.0.1:{server.server_port}/repo.tar.gz"
    finally:
        server.shutdown()
        server.server_close()


async def test_fetch_and_remove_a_workshop(jp_fetch, jp_root_dir, archive_url):
    from tornado.httpclient import HTTPClientError

    response = await jp_fetch(
        "jupyterlab-workshop",
        "fetch",
        method="POST",
        body=json.dumps({"source": {"archive": archive_url}}),
    )
    payload = json.loads(response.body)

    assert payload["path"] == "workshops/demo"
    assert payload["source"] == {
        "kind": "archive",
        "url": archive_url,
        "sha256": payload["sha256"],
    }
    assert (jp_root_dir / "workshops" / "demo" / "workshop.yaml").exists()
    assert (jp_root_dir / "workshops" / "demo" / "_workshop" / "source.json").exists()

    # A second fetch without overwrite conflicts.
    with pytest.raises(HTTPClientError) as conflict:
        await jp_fetch(
            "jupyterlab-workshop",
            "fetch",
            method="POST",
            body=json.dumps({"source": {"archive": archive_url}}),
        )

    assert conflict.value.code == 409

    response = await jp_fetch(
        "jupyterlab-workshop",
        "workshops",
        method="DELETE",
        params={"path": "workshops/demo"},
    )

    assert json.loads(response.body) == {"removed": "workshops/demo"}
    assert not (jp_root_dir / "workshops" / "demo").exists()


async def test_fetch_rejects_bad_sources(jp_fetch):
    from tornado.httpclient import HTTPClientError

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "fetch",
            method="POST",
            body=json.dumps({"source": {"url": "file:///etc"}}),
        )

    assert error.value.code == 400


async def test_verify_and_checkpoint_endpoints(jp_fetch, jp_root_dir):
    from tornado.httpclient import HTTPClientError

    workshop = jp_root_dir / "ws"

    (workshop / "verify").mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (workshop / "verify" / "ok.py").write_text("print('fine')\n")
    (workshop / "data.txt").write_text("one\n")

    response = await jp_fetch(
        "jupyterlab-workshop",
        "verify",
        method="POST",
        body=json.dumps({"workshop": "ws", "script": "verify/ok.py"}),
    )

    assert json.loads(response.body) == {"code": 0, "stdout": "fine\n", "stderr": ""}

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "jupyterlab-workshop",
            "verify",
            method="POST",
            body=json.dumps({"workshop": "ws", "script": "../outside.py"}),
        )

    assert error.value.code == 400

    response = await jp_fetch(
        "jupyterlab-workshop",
        "checkpoints",
        method="POST",
        body=json.dumps({"workshop": "ws", "name": "start", "variables": {"x": "1"}}),
    )

    assert json.loads(response.body)["name"] == "start"

    (workshop / "data.txt").write_text("two\n")

    response = await jp_fetch(
        "jupyterlab-workshop",
        "checkpoints",
        method="POST",
        body=json.dumps({"workshop": "ws", "name": "start", "action": "restore"}),
    )

    assert json.loads(response.body)["variables"] == {"x": "1"}
    assert (workshop / "data.txt").read_text() == "one\n"

    response = await jp_fetch(
        "jupyterlab-workshop", "checkpoints", params={"workshop": "ws"}
    )

    assert [item["name"] for item in json.loads(response.body)["checkpoints"]] == [
        "start"
    ]


async def test_preflight_endpoint(jp_fetch):
    response = await jp_fetch(
        "jupyterlab-workshop",
        "preflight",
        method="POST",
        body=json.dumps({"tools": [{"name": "python3"}], "versions": False}),
    )
    payload = json.loads(response.body)

    assert payload["tools"][0]["name"] == "python3"
    assert payload["tools"][0]["found"] is True
    assert payload["tools"][0]["version"] == ""


async def test_workshops_listing_collection_and_events_endpoints(jp_fetch, jp_root_dir):
    from tornado.httpclient import HTTPClientError

    workshop = jp_root_dir / "workshops" / "demo"

    workshop.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (jp_root_dir / "collection.json").write_text(
        json.dumps(
            {
                "version": 1,
                "title": "Demo collection",
                "icon": "icon.svg",
                "workshops": [
                    {
                        "name": "demo",
                        "title": "Demo",
                        "versions": [
                            {"version": "1", "source": {"archive": "https://h/d.tgz"}}
                        ],
                    }
                ],
            }
        )
    )
    (jp_root_dir / "catalog.json").write_text(
        json.dumps(
            {
                "version": 1,
                "title": "Demo catalog",
                "collections": [{"url": "collection.json", "title": "Demo collection"}],
            }
        )
    )

    response = await jp_fetch("jupyterlab-workshop", "workshops")
    listed = json.loads(response.body)["workshops"]

    assert [item["path"] for item in listed] == ["workshops/demo"]
    assert listed[0]["pages"] == 1
    assert listed[0]["started"] is False

    response = await jp_fetch(
        "jupyterlab-workshop", "collection", params={"url": "collection.json"}
    )
    payload = json.loads(response.body)

    assert payload["url"] == "collection.json"
    assert payload["index"]["workshops"][0]["name"] == "demo"

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("jupyterlab-workshop", "collection", params={"url": "nope.json"})

    assert error.value.code == 400

    # A catalog comes back with its relative locations resolved against it.
    response = await jp_fetch(
        "jupyterlab-workshop", "catalog", params={"url": "catalog.json"}
    )
    payload = json.loads(response.body)

    assert payload["catalog"]["title"] == "Demo catalog"
    assert payload["catalog"]["collections"][0]["url"] == "collection.json"

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("jupyterlab-workshop", "catalog", params={"url": "nope.json"})

    assert error.value.code == 400

    response = await jp_fetch(
        "jupyterlab-workshop",
        "events",
        method="POST",
        body=json.dumps(
            {
                "workshop": "workshops/demo",
                "events": [{"kind": "workshop-start"}, {"kind": "page-enter"}],
            }
        ),
    )

    assert json.loads(response.body) == {
        "written": 2,
        "forwarded": False,
        "problem": "",
    }
    assert (workshop / "_workshop" / "events.jsonl").read_text().count("\n") == 2

    response = await jp_fetch(
        "jupyterlab-workshop",
        "environment",
        params={"workshop": "workshops/demo", "kernel": "workshop-demo"},
    )

    assert json.loads(response.body)["ready"] is False


async def test_init_and_publish_endpoints(jp_fetch, jp_root_dir):
    response = await jp_fetch(
        "jupyterlab-workshop",
        "init",
        method="POST",
        body=json.dumps(
            {
                "directory": "authored/my-workshop",
                "title": "My Workshop",
                "template": "notebook",
                "platforms": ["linux", "windows"],
                "gating": "strict",
            }
        ),
    )
    payload = json.loads(response.body)

    assert payload["path"] == "authored/my-workshop"
    assert "authored/my-workshop/pages/01-welcome.md" in payload["files"]

    manifest = (jp_root_dir / "authored" / "my-workshop" / "workshop.yaml").read_text()

    assert "name: my-workshop\ntitle: My Workshop\n" in manifest
    assert "platforms: [linux, windows]" in manifest
    assert "gating: strict" in manifest
    assert (
        "notebook-create"
        in (
            jp_root_dir / "authored" / "my-workshop" / "pages" / "01-welcome.md"
        ).read_text()
    )

    # A second init of the same directory is a conflict, and a directory
    # outside the root is refused.
    with pytest.raises(Exception) as conflict:
        await jp_fetch(
            "jupyterlab-workshop",
            "init",
            method="POST",
            body=json.dumps({"directory": "authored/my-workshop"}),
        )

    assert conflict.value.code == 409

    with pytest.raises(Exception) as outside:
        await jp_fetch(
            "jupyterlab-workshop",
            "init",
            method="POST",
            body=json.dumps({"directory": "../elsewhere"}),
        )

    assert outside.value.code == 400

    response = await jp_fetch(
        "jupyterlab-workshop",
        "publish",
        method="POST",
        body=json.dumps(
            {"workshop": "authored/my-workshop", "url": "https://h/mw.tar.gz"}
        ),
    )
    published = json.loads(response.body)

    assert published["archive"] == "authored/my-workshop/dist/my-workshop-0.1.0.tar.gz"
    assert (jp_root_dir / published["archive"]).is_file()
    assert published["entry"]["versions"][0]["source"] == {
        "archive": "https://h/mw.tar.gz"
    }
    assert len(published["sha256"]) == 64


async def test_bridge_round_trip_and_timeout(jp_fetch):
    import asyncio

    # Nothing is listening, so the request appears as pending until a
    # result is posted for it, as the frontend would do.
    request = asyncio.ensure_future(
        jp_fetch(
            "jupyterlab-workshop",
            "bridge",
            method="POST",
            body=json.dumps(
                {"command": "workshop:bridge-status", "args": {}, "timeout": 5}
            ),
        )
    )

    pending: list[dict] = []

    for _ in range(50):
        listing = await jp_fetch("jupyterlab-workshop", "bridge")
        pending = json.loads(listing.body)["pending"]

        if pending:
            break

        await asyncio.sleep(0.05)

    assert pending and pending[0]["command"] == "workshop:bridge-status"

    answer = await jp_fetch(
        "jupyterlab-workshop",
        "bridge",
        "result",
        method="POST",
        body=json.dumps({"request_id": pending[0]["request_id"], "result": {"ok": 1}}),
    )

    assert json.loads(answer.body) == {"resolved": True}
    assert json.loads((await request).body) == {"result": {"ok": 1}}

    # Answering again finds nothing to resolve.
    again = await jp_fetch(
        "jupyterlab-workshop",
        "bridge",
        "result",
        method="POST",
        body=json.dumps({"request_id": pending[0]["request_id"], "result": 2}),
    )

    assert json.loads(again.body) == {"resolved": False}

    with pytest.raises(Exception) as timeout:
        await jp_fetch(
            "jupyterlab-workshop",
            "bridge",
            method="POST",
            body=json.dumps({"command": "workshop:x", "args": {}, "timeout": 0.2}),
        )

    assert timeout.value.code == 504

    with pytest.raises(Exception) as refused:
        await jp_fetch(
            "jupyterlab-workshop",
            "bridge",
            method="POST",
            body=json.dumps({"command": "filebrowser:delete", "args": {}}),
        )

    assert refused.value.code == 400
