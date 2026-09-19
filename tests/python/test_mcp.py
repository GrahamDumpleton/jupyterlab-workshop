import asyncio
import json
import shutil
from pathlib import Path

import pytest
from mcp.client import Client

from jupyterlab_workshop import cli
from jupyterlab_workshop.mcp import JupyterSession, create_server

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

    # A plain run keeps today's behaviour: no pauses, the long wait.
    assert bodies[0] == {
        "command": "workshop:run-all",
        "args": {"startDelay": 0.0, "stepDelay": 0.0, "pageDelay": 0.0},
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
