import json
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

from jupyterlab_workshop.analytics import (
    AnalyticsError,
    append_events,
    forward_events,
    identity_from_environment,
    read_events,
)

MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\nname: demo\ntitle: Demo\npages: [a.md]\n"
)


@pytest.fixture
def sink() -> Iterator[tuple[str, list[bytes]]]:
    """A local HTTP server that records what is posted to it.

    Each request is recorded as its Authorization header, or an empty
    line, followed by the body, so a test sees the credential and the
    lines together.
    """

    received: list[bytes] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            authorization = self.headers.get("Authorization", "")

            received.append(authorization.encode() + b"\n" + self.rfile.read(length))
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)

    thread.start()

    try:
        yield f"http://127.0.0.1:{server.server_port}/events", received
    finally:
        server.shutdown()
        server.server_close()


def test_append_and_read_events(tmp_path: Path) -> None:
    workshop = tmp_path / "ws"

    workshop.mkdir()
    (workshop / "workshop.yaml").write_text(MANIFEST)

    events = [{"kind": "page-enter", "page": "01"}, "junk", {"kind": "finish"}]

    assert append_events(tmp_path, "ws", events) == 2
    assert append_events(tmp_path, "ws", [{"kind": "later"}]) == 1
    assert append_events(tmp_path, "ws", []) == 0

    lines = (workshop / "_workshop" / "events.jsonl").read_text().splitlines()

    assert len(lines) == 3
    assert json.loads(lines[0]) == {"kind": "page-enter", "page": "01"}
    assert [event["kind"] for event in read_events(tmp_path, "ws")] == [
        "page-enter",
        "finish",
        "later",
    ]

    with pytest.raises(AnalyticsError, match="not a workshop"):
        append_events(tmp_path, "elsewhere", events)

    assert read_events(tmp_path, "ws") == read_events(tmp_path, "ws")


def test_forward_events_posts_json_lines(sink: tuple[str, list[bytes]]) -> None:
    url, received = sink

    status = forward_events(url, [{"kind": "a"}, {"kind": "b"}])

    assert status == 202
    assert received == [b'\n{"kind":"a"}\n{"kind":"b"}\n']

    # The token travels as a bearer credential, never in the URL.
    forward_events(url, [{"kind": "c"}], token="secret.token")

    assert received[1] == b'Bearer secret.token\n{"kind":"c"}\n'

    with pytest.raises(AnalyticsError, match="Refusing"):
        forward_events("file:///tmp/x", [{"kind": "a"}])

    with pytest.raises(AnalyticsError, match="Unable to reach"):
        forward_events("http://127.0.0.1:9/nothing", [{"kind": "a"}], timeout=1)


def test_identity_comes_from_the_hub_variable() -> None:
    assert identity_from_environment({"JUPYTERHUB_USER": "ada"}) == "ada"
    assert identity_from_environment({}) == ""


EVENTS_SCHEMA = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "core"
    / "src"
    / "schema"
    / "events.schema.json"
)


def test_recorded_events_match_the_published_schema() -> None:
    """A line as the extension writes it validates against the schema.

    The schema is the contract a sink relies on; this keeps the Python
    side honest about the base fields the server never touches and the
    ``user`` field it adds under the hub identity policy.
    """

    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(EVENTS_SCHEMA.read_text(encoding="utf-8"))
    event = {
        "kind": "page-enter",
        "ts": "2026-09-15T10:00:00.000Z",
        "session_id": "mfx1-abc",
        "instance_id": "i-1",
        "workshop": "workshops/demo",
        "name": "demo",
        "version": "1.0",
        "source": "local:workshops/demo",
        "collection": "",
        "seq": 3,
        "labels": {},
        "frontend": "jupyterlab",
        "frontend_version": "0.2.0",
        "host": "jupyterhub",
        "platform": "linux",
        "trust": "trusted",
        "page": "01-start",
    }

    jsonschema.validate(event, schema)
    jsonschema.validate({**event, "user": "ada"}, schema)

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({**event, "seq": 0}, schema)

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({**event, "labels": {"Bad": "x"}}, schema)


def test_a_page_entry_lists_its_directives_or_not() -> None:
    """A page entry is closed, and its inventory is optional.

    A session from an older extension carries entries without
    ``directives``; a newer one lists them. Either validates, and a
    field the contract does not name is refused, which is what makes
    the inventory an additive change a sink must accept before the
    extension sends it.
    """

    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(EVENTS_SCHEMA.read_text(encoding="utf-8"))
    page = {"id": "01-start", "path": "pages/01-start.md", "title": "Start"}
    listed = {
        **page,
        "directives": [
            {"id": "01-start-1", "type": "execute", "trigger": "click"},
            {"id": "done", "type": "verify", "trigger": "trigger", "conditional": True},
        ],
    }
    entry = {**schema, **schema["definitions"]["page"]}

    jsonschema.validate(page, entry)
    jsonschema.validate(listed, entry)

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({**page, "colour": "red"}, entry)

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(
            {**page, "directives": [{"id": "x", "type": "execute"}]}, entry
        )
