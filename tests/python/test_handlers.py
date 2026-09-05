import io
import json
import tarfile
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest


async def test_platform_endpoint_reports_the_server_environment(jp_fetch, jp_root_dir):
    response = await jp_fetch("educates-workshop", "platform")

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
    }
    assert payload["os"] in {"linux", "macos", "windows"}
    assert payload["root_dir"] == str(jp_root_dir)


MANIFEST = (
    "apiVersion: workshop.educates.dev/v1alpha1\n"
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
        "educates-workshop",
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
            "educates-workshop",
            "fetch",
            method="POST",
            body=json.dumps({"source": {"archive": archive_url}}),
        )

    assert conflict.value.code == 409

    response = await jp_fetch(
        "educates-workshop",
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
            "educates-workshop",
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
        "educates-workshop",
        "verify",
        method="POST",
        body=json.dumps({"workshop": "ws", "script": "verify/ok.py"}),
    )

    assert json.loads(response.body) == {"code": 0, "stdout": "fine\n", "stderr": ""}

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch(
            "educates-workshop",
            "verify",
            method="POST",
            body=json.dumps({"workshop": "ws", "script": "../outside.py"}),
        )

    assert error.value.code == 400

    response = await jp_fetch(
        "educates-workshop",
        "checkpoints",
        method="POST",
        body=json.dumps({"workshop": "ws", "name": "start", "variables": {"x": "1"}}),
    )

    assert json.loads(response.body)["name"] == "start"

    (workshop / "data.txt").write_text("two\n")

    response = await jp_fetch(
        "educates-workshop",
        "checkpoints",
        method="POST",
        body=json.dumps({"workshop": "ws", "name": "start", "action": "restore"}),
    )

    assert json.loads(response.body)["variables"] == {"x": "1"}
    assert (workshop / "data.txt").read_text() == "one\n"

    response = await jp_fetch(
        "educates-workshop", "checkpoints", params={"workshop": "ws"}
    )

    assert [item["name"] for item in json.loads(response.body)["checkpoints"]] == [
        "start"
    ]


async def test_preflight_endpoint(jp_fetch):
    response = await jp_fetch(
        "educates-workshop",
        "preflight",
        method="POST",
        body=json.dumps({"tools": [{"name": "python3"}], "versions": False}),
    )
    payload = json.loads(response.body)

    assert payload["tools"][0]["name"] == "python3"
    assert payload["tools"][0]["found"] is True
    assert payload["tools"][0]["version"] == ""


async def test_workshops_listing_registry_and_events_endpoints(jp_fetch, jp_root_dir):
    from tornado.httpclient import HTTPClientError

    workshop = jp_root_dir / "workshops" / "demo"

    workshop.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (jp_root_dir / "registry.json").write_text(
        json.dumps(
            {
                "version": 1,
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

    response = await jp_fetch("educates-workshop", "workshops")
    listed = json.loads(response.body)["workshops"]

    assert [item["path"] for item in listed] == ["workshops/demo"]
    assert listed[0]["pages"] == 1
    assert listed[0]["started"] is False

    response = await jp_fetch(
        "educates-workshop", "registry", params={"url": "registry.json"}
    )
    payload = json.loads(response.body)

    assert payload["url"] == "registry.json"
    assert payload["index"]["workshops"][0]["name"] == "demo"

    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("educates-workshop", "registry", params={"url": "nope.json"})

    assert error.value.code == 400

    response = await jp_fetch(
        "educates-workshop",
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
        "educates-workshop",
        "environment",
        params={"workshop": "workshops/demo", "kernel": "workshop-demo"},
    )

    assert json.loads(response.body)["ready"] is False
