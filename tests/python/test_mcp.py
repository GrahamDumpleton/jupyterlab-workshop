import asyncio
import json
import shutil
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from mcp.client import Client

from jupyterlab_workshop import cli
from jupyterlab_workshop.bridge import Bridge
from jupyterlab_workshop.mcp import (
    BridgeSession,
    JupyterSession,
    SessionError,
    create_server,
)

needs_node = pytest.mark.skipif(
    shutil.which("node") is None or not cli.NODE_BUNDLE.is_file(),
    reason="needs node and the built Node bundle (run `just build`)",
)


def _run(coroutine):  # type: ignore[no-untyped-def]
    return asyncio.run(coroutine)


def _text(result) -> str:  # type: ignore[no-untyped-def]
    return "".join(getattr(block, "text", "") for block in result.content)


def test_tools_and_resources_are_listed() -> None:
    server = create_server(lambda: None)

    async def scenario() -> tuple[list[str], list[str]]:
        async with Client(server) as client:
            tools = await client.list_tools()
            resources = await client.list_resources()

            return (
                [tool.name for tool in tools.tools],
                [str(resource.uri) for resource in resources.resources],
            )

    tools, resources = _run(scenario())

    assert {
        "lint",
        "test",
        "init",
        "publish",
        "publish_gist",
        "index",
        "draft",
        "run_action",
        "run_page",
        "run_workshop",
        "run_progress",
        "reset_workshop",
    } <= set(tools)
    assert "workshop://schema/workshop" in resources
    assert "workshop://skill" in resources


def test_init_tool_writes_a_workshop_and_live_tools_need_a_session(
    tmp_path: Path,
) -> None:
    server = create_server(lambda: None)
    target = tmp_path / "quiz-time"

    async def scenario() -> tuple[str, str, str]:
        async with Client(server) as client:
            created = await client.call_tool(
                "init",
                {"directory": str(target), "template": "blank", "title": "Quiz"},
            )
            skill = await client.read_resource("workshop://skill")
            status = await client.call_tool("session_status", {})

            return (
                _text(created),
                "".join(getattr(c, "text", "") for c in skill.contents),
                _text(status),
            )

    created, skill, status = _run(scenario())

    assert (
        (target / "workshop.yaml")
        .read_text()
        .startswith(
            "apiVersion: jupyterlab-workshop/v1alpha1\nname: quiz-time\ntitle: Quiz\n"
        )
    )
    assert "workshop.yaml" in created
    assert skill.startswith("---\nname: jupyterlab-workshop-authoring")
    assert "No running JupyterLab" in status


@needs_node
def test_relative_paths_resolve_against_the_base(tmp_path: Path) -> None:
    # An agent inside Jupyter Server works in a workshop directory, not
    # the server's current directory, and names paths relative to it.
    server = create_server(lambda: None, base=tmp_path)

    async def scenario() -> tuple[str, str]:
        async with Client(server) as client:
            created = await client.call_tool(
                "init", {"directory": "demo", "template": "blank"}
            )
            linted = await client.call_tool("lint", {"directory": "demo"})

            return _text(created), _text(linted)

    created, linted = _run(scenario())

    assert (tmp_path / "demo" / "workshop.yaml").is_file()
    assert json.loads(created)["directory"] == str(tmp_path / "demo")
    assert "no workshop.yaml" not in linted


@needs_node
def test_publish_gist_tool_creates_then_updates_the_recorded_gist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, str]] = []

    def github(
        method: str, url: str, body: Mapping[str, Any] | None, token: str
    ) -> dict[str, Any]:
        assert token == "tok"
        calls.append((method, url))

        return {"id": "abc", "html_url": "https://gist.github.com/ada/abc"}

    monkeypatch.setenv("GH_TOKEN", "tok")

    server = create_server(lambda: None, base=tmp_path, github=github)

    async def scenario() -> list[Any]:
        async with Client(server) as client:
            await client.call_tool("init", {"directory": "demo", "template": "blank"})

            first = await client.call_tool("publish_gist", {"directory": "demo"})
            second = await client.call_tool("publish_gist", {"directory": "demo"})

            # A workshop that does not lint is not sent.
            (tmp_path / "demo" / "workshop.yaml").write_text("name: [\n")

            broken = await client.call_tool("publish_gist", {"directory": "demo"})

            return [json.loads(_text(result)) for result in (first, second, broken)]

    first, second, broken = _run(scenario())

    assert first["url"] == "https://gist.github.com/ada/abc"
    assert first["created"] is True
    assert first["public"] is False
    assert second["created"] is False
    assert [call[0] for call in calls] == ["POST", "PATCH", "GET", "PATCH"]

    record = json.loads((tmp_path / "demo" / "_workshop" / "gist.json").read_text())

    assert record["url"] == "https://gist.github.com/ada/abc"
    assert broken["error"] == "The workshop does not lint clean"
    assert len(calls) == 4


def test_index_tool_writes_a_collection(tmp_path: Path) -> None:
    server = create_server(lambda: None)

    cli.main(["init", str(tmp_path / "workshops" / "one"), "--title", "One"])

    async def scenario() -> tuple[str, str]:
        async with Client(server) as client:
            missing = await client.call_tool(
                "index", {"directories": [str(tmp_path / "workshops")]}
            )
            written = await client.call_tool(
                "index",
                {
                    "directories": [str(tmp_path / "workshops")],
                    "root": str(tmp_path),
                    "repo": "https://github.com/org/repo",
                    "ref": "v1",
                    "title": "Mine",
                },
            )

            return _text(missing), _text(written)

    missing, written = _run(scenario())

    assert "no git origin" in missing
    assert "workshops/one" in written

    index = json.loads((tmp_path / "collection.json").read_text())

    assert index["title"] == "Mine"
    assert index["workshops"][0]["versions"][0]["source"]["subdir"] == "workshops/one"


def test_catalog_tool_writes_and_refreshes_a_catalog(tmp_path: Path) -> None:
    server = create_server(lambda: None)
    collection = tmp_path / "python" / "collection.json"

    collection.parent.mkdir()
    collection.write_text(
        json.dumps(
            {
                "version": 1,
                "title": "Python",
                "description": "The language.",
                "icon": "icon.svg",
                "workshops": [],
            }
        )
    )

    async def scenario() -> str:
        async with Client(server) as client:
            written = await client.call_tool(
                "catalog",
                {
                    "path": str(tmp_path / "catalog.json"),
                    "collections": [str(collection)],
                    "relative": True,
                    "title": "Mine",
                },
            )

            return _text(written)

    assert "python/collection.json" in _run(scenario())

    catalog = json.loads((tmp_path / "catalog.json").read_text())

    assert catalog["title"] == "Mine"
    assert catalog["collections"] == [
        {
            "url": "python/collection.json",
            "title": "Python",
            "description": "The language.",
            "icon": "icon.svg",
        }
    ]


@needs_node
def test_lint_tool_reports_findings(tmp_path: Path) -> None:
    server = create_server(lambda: None)
    target = tmp_path / "demo"

    cli.main(["init", str(target)])

    page = target / "pages" / "01-welcome.md"

    page.write_text(page.read_text() + "\n```{kernel-execute}\nprint(1)\n```\n")

    async def scenario() -> dict:
        async with Client(server) as client:
            result = await client.call_tool("lint", {"directory": str(target)})

            return json.loads(_text(result))

    report = _run(scenario())

    assert report["errors"] == 1
    assert report["messages"][0]["fix"] == {
        "kind": "add-capability",
        "capability": "kernel-exec",
    }


class _RecordingSession(JupyterSession):
    """A session that answers every bridge call and keeps what was asked."""

    calls: list[dict[str, object]] = []

    def request(
        self, endpoint: str, body: dict | None = None, timeout: float = 60.0
    ) -> object:
        type(self).calls.append(
            {"endpoint": endpoint, "body": body, "timeout": timeout}
        )

        return {"result": {"ok": True}}


def test_run_tools_pass_the_pace_and_limits_to_the_bridge() -> None:
    _RecordingSession.calls = []
    server = create_server(lambda: _RecordingSession(url="http://x", token=""))

    async def scenario() -> list[str]:
        async with Client(server) as client:
            texts = []

            for name, arguments in [
                ("run_workshop", {}),
                (
                    "run_workshop",
                    {
                        "pace": "presentation",
                        "step_delay": 2.0,
                        "action_timeout": 900,
                        "wait": False,
                    },
                ),
                ("run_page", {"page": "intro", "pace": "demo"}),
                ("run_workshop", {"pace": "leisurely"}),
                ("run_progress", {}),
                ("reset_workshop", {}),
            ]:
                texts.append(_text(await client.call_tool(name, arguments)))

            return texts

    texts = _run(scenario())
    bodies = [call["body"] for call in _RecordingSession.calls]

    # A plain run has no pauses and the long wait, and leaves the
    # workshop as Finish does once it passes.
    assert bodies[0] == {
        "command": "workshop:run-all",
        "args": {
            "startDelay": 0.0,
            "stepDelay": 0.0,
            "pageDelay": 0.0,
            "close": True,
        },
        "timeout": 1200.0,
    }

    # A paced run in the background carries its pauses, the explicit
    # override, the action limit and the flag, and waits only briefly.
    assert bodies[1]["args"] == {
        "startDelay": 5.0,
        "stepDelay": 2.0,
        "pageDelay": 8.0,
        "actionTimeout": 900,
        "background": True,
    }
    assert bodies[1]["timeout"] == 30.0

    assert bodies[2]["command"] == "workshop:run-page"
    assert bodies[2]["args"] == {
        "page": "intro",
        "only": "all",
        "startDelay": 2.0,
        "stepDelay": 1.5,
    }

    # An unknown pace is answered, not sent.
    assert "Unknown pace" in texts[3]
    assert len(bodies) == 5
    assert bodies[3]["command"] == "workshop:self-test-progress"
    assert bodies[4]["command"] == "workshop:bridge-reset"


def test_bridge_session_reaches_the_bridge_from_a_worker_thread() -> None:
    # The live tools run in a worker thread, so the session hands each
    # request to the server's loop, aimed at its tab, and answers as the
    # bridge endpoint does.
    bridge = Bridge(None)
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)

    thread.start()

    try:
        session = BridgeSession(bridge=bridge, loop=loop, target="tab-1")
        server = create_server(lambda: session)

        async def answer() -> None:
            while not bridge.pending():
                await asyncio.sleep(0.01)

            item = bridge.pending()[0]

            assert item["target"] == "tab-1"
            assert item["command"] == "workshop:bridge-status"

            bridge.resolve(item["request_id"], result={"workshop": "demo"})

        answered = asyncio.run_coroutine_threadsafe(answer(), loop)

        async def scenario() -> str:
            async with Client(server) as client:
                return _text(await client.call_tool("session_status", {}))

        text = _run(scenario())

        answered.result(5)

        assert json.loads(text) == {"result": {"workshop": "demo"}}

        # A request nobody answers is reported, not raised to the agent.
        with pytest.raises(SessionError, match="author mode"):
            session.request(
                "bridge", {"command": "workshop:x", "args": {}, "timeout": 0.05}
            )

        with pytest.raises(SessionError, match="Only the bridge"):
            session.request("verify", {})
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(5)
        loop.close()


def test_session_requests_report_server_errors() -> None:
    session = JupyterSession(url="http://127.0.0.1:9", token="t")

    with pytest.raises(Exception, match="Unable to reach"):
        session.request("bridge", {"command": "workshop:x"}, timeout=1)


@pytest.mark.parametrize("name", ["actions.md", "pages.md"])
def test_skill_reference_matches_the_docs(name: str) -> None:
    root = Path(__file__).resolve().parents[2]
    docs = root / "docs" / name
    reference = root / "skills" / "jupyterlab-workshop-authoring" / "references" / name

    if not docs.is_file():
        pytest.skip("needs the documentation in a checkout")

    assert reference.read_text() == docs.read_text()


def test_bridge_session_gives_up_when_the_server_stops() -> None:
    # A tool waiting on a browser when the server's loop stops returns at
    # once, since the process cannot exit while the thread waits.
    import time

    bridge = Bridge(None)
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)

    thread.start()

    session = BridgeSession(bridge=bridge, loop=loop)
    outcome: list[str] = []

    def wait() -> None:
        try:
            session.request(
                "bridge", {"command": "workshop:run-all", "args": {}, "timeout": 600}
            )
        except SessionError as error:
            outcome.append(str(error))

    waiter = threading.Thread(target=wait)
    started = time.monotonic()

    waiter.start()
    time.sleep(0.2)
    loop.call_soon_threadsafe(loop.stop)
    waiter.join(5)

    assert outcome == ["JupyterLab is shutting down"]
    assert time.monotonic() - started < 3

    thread.join(5)
    loop.close()
