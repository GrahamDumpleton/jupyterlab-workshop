import json
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

from educates_jupyterlab_workshop.analytics import (
    AnalyticsError,
    append_events,
    forward_events,
    identity_from_environment,
    read_events,
)

MANIFEST = (
    "apiVersion: workshop.educates.dev/v1alpha1\n"
    "name: demo\ntitle: Demo\npages: [a.md]\n"
)


@pytest.fixture
def sink() -> Iterator[tuple[str, list[bytes]]]:
    """A local HTTP server that records what is posted to it."""

    received: list[bytes] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))

            received.append(self.rfile.read(length))
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
    assert received == [b'{"kind":"a"}\n{"kind":"b"}\n']

    with pytest.raises(AnalyticsError, match="Refusing"):
        forward_events("file:///tmp/x", [{"kind": "a"}])

    with pytest.raises(AnalyticsError, match="Unable to reach"):
        forward_events("http://127.0.0.1:9/nothing", [{"kind": "a"}], timeout=1)


def test_identity_comes_from_the_hub_variable() -> None:
    assert identity_from_environment({"JUPYTERHUB_USER": "ada"}) == "ada"
    assert identity_from_environment({}) == ""
