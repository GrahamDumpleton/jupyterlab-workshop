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

    assert {"lint", "test", "init", "publish", "index", "draft", "run_action"} <= set(
        tools
    )
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
    assert skill.startswith("---\nname: workshop-author")
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


def test_session_requests_report_server_errors() -> None:
    session = JupyterSession(url="http://127.0.0.1:9", token="t")

    with pytest.raises(Exception, match="Unable to reach"):
        session.request("bridge", {"command": "workshop:x"}, timeout=1)


@pytest.mark.parametrize("name", ["actions.md", "pages.md"])
def test_skill_reference_matches_the_docs(name: str) -> None:
    root = Path(__file__).resolve().parents[2]
    docs = root / "docs" / name
    reference = root / "skills" / "workshop-author" / "references" / name

    if not docs.is_file():
        pytest.skip("needs the documentation in a checkout")

    assert reference.read_text() == docs.read_text()
