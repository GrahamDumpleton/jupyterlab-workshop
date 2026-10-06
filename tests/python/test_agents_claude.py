import asyncio
import contextlib
import json
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop.agents.base import (
    Compacted,
    Compacting,
    Done,
    Error,
    PermissionRequest,
    PermissionWithdrawn,
    Question,
    StartOptions,
    Text,
    TextDelta,
    ToolCall,
    ToolResult,
)
from jupyterlab_workshop.agents.claude import ClaudeSession, sdk_tools_server
from jupyterlab_workshop.agents.policy import PermissionPolicy
from jupyterlab_workshop.mcp import create_server

pytest.importorskip("claude_agent_sdk")


def _policy(tmp_path: Path) -> PermissionPolicy:
    workshop = tmp_path / "library" / "personal" / "demo"
    installed = tmp_path / "library" / "installed"

    for directory in (workshop, installed):
        directory.mkdir(parents=True, exist_ok=True)

    return PermissionPolicy(workshop=workshop, forbidden=(installed,))


def test_sdk_tools_are_the_mcp_servers_tools() -> None:
    from mcp.client import Client

    server = create_server(lambda: None)

    async def scenario() -> tuple[list[str], list[str], Any]:
        config = await sdk_tools_server(server)
        served = [tool.name for tool in await server.list_tools()]

        # The in-process server Claude talks to lists the same tools, with
        # the same schemas, and calls through to the workshop server.
        async with Client(config["instance"]) as client:
            listed = await client.list_tools()
            result = await client.call_tool("get_schema", {"kind": "catalog"})

        schemas = {tool.name: tool.input_schema for tool in listed.tools}
        originals = {tool.name: tool.input_schema for tool in await server.list_tools()}

        assert schemas == originals

        return served, list(schemas), result

    served, listed, result = asyncio.run(scenario())

    assert listed == served
    assert "lint" in listed and "run_workshop" in listed
    assert not result.is_error
    assert '"title"' in result.content[0].text


def test_claude_messages_become_panel_events(tmp_path: Path) -> None:
    from claude_agent_sdk import (
        AssistantMessage,
        ResultMessage,
        SystemMessage,
        TextBlock,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
    )
    from claude_agent_sdk.types import StreamEvent

    session = ClaudeSession(
        StartOptions(directory=tmp_path, policy=_policy(tmp_path)), client=None
    )

    def result(**overrides: Any) -> Any:
        values: dict[str, Any] = {
            "subtype": "success",
            "duration_ms": 1,
            "duration_api_ms": 1,
            "is_error": False,
            "num_turns": 2,
            "session_id": "abc",
        }
        values.update(overrides)

        return ResultMessage(**values)

    assert session.translate(SystemMessage("init", {"session_id": "abc"})) == []
    assert session.session_id == "abc"

    delta = StreamEvent(
        uuid="u",
        session_id="abc",
        event={
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": "Hel"},
        },
    )

    assert session.translate(delta) == [TextDelta("Hel")]

    assistant = AssistantMessage(
        content=[
            TextBlock("Hello"),
            ToolUseBlock(id="t1", name="Write", input={"file_path": "a"}),
        ],
        model="m",
    )

    assert session.translate(assistant) == [
        Text("Hello"),
        ToolCall("t1", "Write", {"file_path": "a"}),
    ]

    user = UserMessage(
        content=[ToolResultBlock(tool_use_id="t1", content="written", is_error=False)]
    )

    assert session.translate(user) == [ToolResult("t1", True, "written")]
    assert session.translate(result()) == [Done("abc", turns=2)]

    failed = session.translate(result(is_error=True, result="Overloaded"))

    assert failed == [Error("Overloaded"), Done("abc", turns=2)]

    # Claude Code reports the running total; each turn is told its own cost.
    first = session.translate(result(total_cost_usd=0.25))
    second = session.translate(result(total_cost_usd=0.75))

    assert first == [Done("abc", turns=2, cost=0.25)]
    assert second == [Done("abc", turns=2, cost=0.5)]


def test_claude_compaction_becomes_panel_events(tmp_path: Path) -> None:
    from claude_agent_sdk import SystemMessage

    session = ClaudeSession(
        StartOptions(directory=tmp_path, policy=_policy(tmp_path)), client=None
    )

    # The shapes Claude Code sends, asked for with /compact or on its own.
    started = SystemMessage("status", {"status": "compacting"})
    finished = SystemMessage("status", {"status": None, "compact_result": "success"})
    boundary = SystemMessage(
        "compact_boundary",
        {"compact_metadata": {"trigger": "auto", "pre_tokens": 150000}},
    )
    failed = SystemMessage(
        "status",
        {"status": None, "compact_result": "failed", "compact_error": "too short"},
    )

    assert session.translate(started) == [Compacting()]
    assert session.translate(finished) == []
    assert session.translate(boundary) == [Compacted("auto", 150000, None)]
    assert session.translate(failed) == [
        Error("Compacting the conversation failed: too short")
    ]


class _ScriptedClient:
    """Stands in for the SDK client, answering each query with one reply."""

    def __init__(self) -> None:
        self.queries: list[Any] = []

    async def query(self, prompt: Any) -> None:
        # A message with attachments comes as a stream of message dicts,
        # as the SDK takes them.
        if isinstance(prompt, str):
            self.queries.append(prompt)
        else:
            self.queries.append([message async for message in prompt])

    async def receive_response(self) -> Any:
        from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

        yield AssistantMessage(content=[TextBlock(str(self.queries[-1]))], model="m")
        yield ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id="abc",
        )


def test_each_claude_turn_has_only_its_own_events(tmp_path: Path) -> None:
    session = ClaudeSession(
        StartOptions(directory=tmp_path, policy=_policy(tmp_path)),
        client=_ScriptedClient(),
    )

    async def turn(text: str) -> list[Any]:
        events = []

        # As the conversation does, stop reading at the end of the turn,
        # once the stream has had time to finish behind it.
        async for event in session.send(text):
            events.append(event)

            if isinstance(event, Done):
                await asyncio.sleep(0.01)

                break

        return events

    async def both() -> list[list[Any]]:
        return [await turn("first"), await turn("second")]

    first, second = asyncio.run(both())

    assert first == [Text("first"), Done("abc", turns=1)]
    assert second == [Text("second"), Done("abc", turns=1)]


def test_claude_is_sent_attachments_as_content_blocks(tmp_path: Path) -> None:
    from jupyterlab_workshop.attachments import Attachment

    client = _ScriptedClient()
    session = ClaudeSession(
        StartOptions(directory=tmp_path, policy=_policy(tmp_path)),
        client=client,
    )
    shot = Attachment("shot.png", "image/png", b"\x89PNG", path=tmp_path / "shot.png")

    async def turn() -> None:
        async for event in session.send("look", [shot]):
            if isinstance(event, Done):
                break

    asyncio.run(turn())

    (message,) = client.queries[-1]
    blocks = message["message"]["content"]

    assert message["type"] == "user"
    assert message["message"]["role"] == "user"
    assert blocks[0] == {"type": "text", "text": "look"}
    assert blocks[1]["type"] == "image"
    assert blocks[1]["source"]["media_type"] == "image/png"
    assert str(tmp_path / "shot.png") in blocks[2]["text"]


def test_claude_permission_callback_follows_the_policy(tmp_path: Path) -> None:
    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny
    from claude_agent_sdk.types import ToolPermissionContext

    policy = _policy(tmp_path)
    session = ClaudeSession(
        StartOptions(directory=policy.workshop, policy=policy), client=None
    )

    async def scenario() -> list[Any]:
        answers: list[Any] = []

        answers.append(
            await session.can_use_tool(
                "Write", {"file_path": "a.md"}, ToolPermissionContext()
            )
        )
        answers.append(
            await session.can_use_tool(
                "Read",
                {"file_path": str(tmp_path / "library" / "installed" / "x")},
                ToolPermissionContext(),
            )
        )

        # A Bash command asks, and the request comes out of the event queue.
        async def ask(remember: bool) -> Any:
            pending = asyncio.ensure_future(
                session.can_use_tool(
                    "Bash",
                    {"command": "make"},
                    ToolPermissionContext(tool_use_id="b1"),
                )
            )
            request = await session._events.get()

            assert isinstance(request, PermissionRequest)
            assert request.id == "b1"
            assert session.answer("b1", allow=True, remember=remember)

            return await pending

        answers.append(await ask(remember=True))

        # Remembered, the same command no longer asks.
        answers.append(
            await session.can_use_tool(
                "Bash", {"command": "make"}, ToolPermissionContext()
            )
        )

        return answers

    answers = asyncio.run(scenario())

    assert isinstance(answers[0], PermissionResultAllow)
    assert isinstance(answers[1], PermissionResultDeny)
    assert isinstance(answers[2], PermissionResultAllow)
    assert isinstance(answers[3], PermissionResultAllow)
    assert session._events.empty()


def test_claude_network_requests_are_described_and_withdrawn(
    tmp_path: Path,
) -> None:
    from claude_agent_sdk import PermissionResultAllow
    from claude_agent_sdk.types import ToolPermissionContext

    policy = _policy(tmp_path)
    session = ClaudeSession(
        StartOptions(directory=policy.workshop, policy=policy), client=None
    )

    async def scenario() -> list[Any]:
        seen: list[Any] = []

        # Claude Code cancels a request it stops waiting for; the panel is
        # told the request no longer stands.
        pending = asyncio.ensure_future(
            session.can_use_tool(
                "SandboxNetworkAccess",
                {"host": "pypi.org"},
                ToolPermissionContext(tool_use_id="n1"),
            )
        )
        request = await session._events.get()

        seen.append(request)
        pending.cancel()

        with contextlib.suppress(asyncio.CancelledError):
            await pending

        seen.append(await session._events.get())

        # Always allow for one host does not cover another.
        async def ask(host: str, tool_use_id: str) -> Any:
            waiting = asyncio.ensure_future(
                session.can_use_tool(
                    "SandboxNetworkAccess",
                    {"host": host},
                    ToolPermissionContext(tool_use_id=tool_use_id),
                )
            )
            asked = await session._events.get()

            session.answer(asked.id, allow=True, remember=True)

            return await waiting

        seen.append(await ask("pypi.org", "n2"))
        seen.append(
            await session.can_use_tool(
                "SandboxNetworkAccess", {"host": "pypi.org"}, ToolPermissionContext()
            )
        )

        other = asyncio.ensure_future(
            session.can_use_tool(
                "SandboxNetworkAccess",
                {"host": "example.com"},
                ToolPermissionContext(tool_use_id="n3"),
            )
        )

        seen.append(await session._events.get())
        other.cancel()

        return seen

    seen = asyncio.run(scenario())

    assert isinstance(seen[0], PermissionRequest)
    assert seen[0].reason == "Lets a command reach pypi.org over the network"
    assert seen[1] == PermissionWithdrawn("n1")
    assert isinstance(seen[2], PermissionResultAllow)
    assert isinstance(seen[3], PermissionResultAllow)
    assert isinstance(seen[4], PermissionRequest)
    assert seen[4].id == "n3"


def test_claude_questions_are_answered_by_the_person(tmp_path: Path) -> None:
    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny
    from claude_agent_sdk.types import ToolPermissionContext

    policy = _policy(tmp_path)
    session = ClaudeSession(
        StartOptions(directory=policy.workshop, policy=policy), client=None
    )
    data = {
        "questions": [
            {
                "question": "Who is it for?",
                "header": "Audience",
                "multiSelect": False,
                "options": [{"label": "Newcomers", "description": ""}],
            }
        ]
    }

    async def ask(answers: dict[str, str] | None) -> tuple[Any, Any]:
        pending = asyncio.ensure_future(
            session.can_use_tool(
                "AskUserQuestion", data, ToolPermissionContext(tool_use_id="q1")
            )
        )
        question = await session._events.get()

        assert session.answer_question("q1", answers)
        assert not session.answer_question("q1", answers)

        return question, await pending

    async def both() -> list[tuple[Any, Any]]:
        return [await ask({"Who is it for?": "Newcomers"}), await ask(None)]

    (question, allowed), (_, declined) = asyncio.run(both())

    # The question goes to the panel, and the answers go back with the
    # tool's input, as Claude Code's own prompt sends them.
    assert question == Question("q1", data["questions"])
    assert isinstance(allowed, PermissionResultAllow)
    assert allowed.updated_input == {
        **data,
        "answers": {"Who is it for?": "Newcomers"},
    }

    assert isinstance(declined, PermissionResultDeny)


def test_claude_does_not_remember_creating_a_gist(tmp_path: Path) -> None:
    from claude_agent_sdk.types import ToolPermissionContext

    policy = _policy(tmp_path)
    session = ClaudeSession(
        StartOptions(directory=policy.workshop, policy=policy), client=None
    )
    publish = {"directory": "."}

    async def ask(tool_use_id: str) -> PermissionRequest:
        pending = asyncio.ensure_future(
            session.can_use_tool(
                "mcp__workshop__publish_gist",
                publish,
                ToolPermissionContext(tool_use_id=tool_use_id),
            )
        )
        request = await session._events.get()

        assert isinstance(request, PermissionRequest)

        session.answer(tool_use_id, allow=True, remember=True)
        await pending

        return request

    async def scenario() -> list[PermissionRequest]:
        # Even answered with Always allow, the second still asks.
        return [await ask("p1"), await ask("p2")]

    first, second = asyncio.run(scenario())

    assert not first.rememberable
    assert second.id == "p2"


def test_the_resume_command_brings_the_skill_and_the_tools(tmp_path: Path) -> None:
    from jupyterlab_workshop.agents.claude import resume_command

    cli = tmp_path / "bin" / "claude"
    workshop_cli = tmp_path / "bin" / "jupyter-workshop"
    command = resume_command(cli, "abc", tmp_path / "plugin", workshop_cli)

    assert command[:3] == [str(cli), "--resume", "abc"]
    assert command[command.index("--plugin-dir") + 1] == str(tmp_path / "plugin")

    config = json.loads(command[command.index("--mcp-config") + 1])

    assert config["mcpServers"]["workshop"] == {
        "command": str(workshop_cli),
        "args": ["mcp"],
    }

    # Without the skill or the workshop command, only the conversation.
    assert resume_command(cli, "abc", None, None) == [str(cli), "--resume", "abc"]
