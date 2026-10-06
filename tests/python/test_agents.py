import asyncio
import json
import os
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop.agents import UnknownProviderError, get_provider
from jupyterlab_workshop.agents.base import (
    Done,
    Error,
    PermissionRequest,
    StartOptions,
    Text,
    ToolCall,
    ToolResult,
)
from jupyterlab_workshop.agents.claude import parse_auth_status, skill_plugin
from jupyterlab_workshop.agents.fake import FakeProvider
from jupyterlab_workshop.agents.policy import PermissionPolicy
from jupyterlab_workshop.mcp import create_server, skill_directory


def _policy(tmp_path: Path, sandboxed: bool = False) -> PermissionPolicy:
    workshop = tmp_path / "library" / "personal" / "demo"
    skill = tmp_path / "skill"
    installed = tmp_path / "library" / "installed"

    for directory in (workshop, skill, installed):
        directory.mkdir(parents=True, exist_ok=True)

    return PermissionPolicy(
        workshop=workshop,
        readable=(skill,),
        forbidden=(installed,),
        sandboxed=sandboxed,
    )


def test_policy_allows_the_workshop_and_asks_about_the_rest(tmp_path: Path) -> None:
    policy = _policy(tmp_path)
    workshop = policy.workshop

    def verdict(tool: str, data: dict[str, Any]) -> str:
        return policy.decide(tool, data).verdict

    # The workshop's own files, by absolute or relative path.
    assert verdict("Write", {"file_path": str(workshop / "pages" / "01.md")}) == "allow"
    assert verdict("Edit", {"file_path": "workshop.yaml"}) == "allow"
    assert verdict("Read", {"file_path": "pages/01.md"}) == "allow"
    assert verdict("Glob", {"pattern": "**/*.md"}) == "allow"

    # The skill is readable, not writable.
    skill = tmp_path / "skill" / "SKILL.md"

    assert verdict("Read", {"file_path": str(skill)}) == "allow"
    assert verdict("Write", {"file_path": str(skill)}) == "ask"

    # Climbing out, or anywhere else on the machine, asks first.
    assert verdict("Write", {"file_path": "../other/x.md"}) == "ask"
    assert verdict("Read", {"file_path": str(tmp_path / "secret.txt")}) == "ask"
    assert verdict("Read", {"file_path": "~/.ssh/id_rsa"}) == "ask"

    # A link inside the workshop is judged by where it leads.
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, workshop / "escape")

    assert verdict("Write", {"file_path": "escape/x.md"}) == "ask"

    # Installed workshops are refused outright.
    installed = tmp_path / "library" / "installed" / "c" / "w" / "workshop.yaml"

    decision = policy.decide("Read", {"file_path": str(installed)})

    assert decision.verdict == "deny"
    assert "Downloaded" in decision.reason

    # The workshop tools and the web are free; other tools ask.
    assert verdict("mcp__workshop__lint", {"directory": "."}) == "allow"
    assert verdict("WebSearch", {"query": "x"}) == "allow"
    assert verdict("Skill", {"skill": "x"}) == "allow"
    assert verdict("SomethingNew", {}) == "ask"
    assert verdict("Read", {"file_path": 3}) == "ask"


def test_policy_asks_before_publishing_a_gist(tmp_path: Path) -> None:
    policy = _policy(tmp_path)
    tool = "mcp__workshop__publish_gist"

    # With nothing recorded, publishing makes a new gist: always asked.
    first = policy.decide(tool, {"directory": "."})

    assert first.verdict == "ask"
    assert "new secret GitHub gist" in first.reason
    assert not first.rememberable
    assert "public" in policy.decide(tool, {"directory": ".", "public": True}).reason

    # Once one is recorded, updating it may be allowed for the conversation,
    # but asking for a new one still asks every time.
    (policy.workshop / "_workshop").mkdir()
    (policy.workshop / "_workshop" / "gist.json").write_text(
        json.dumps({"id": "abc", "url": "https://gist.github.com/ada/abc"})
    )

    update = policy.decide(tool, {"directory": "."})

    assert update.verdict == "ask"
    assert update.reason == "Updates the GitHub gist https://gist.github.com/ada/abc"
    assert update.rememberable
    assert not policy.decide(tool, {"directory": ".", "create": True}).rememberable


def test_policy_lets_bash_run_only_in_the_sandbox(tmp_path: Path) -> None:
    unsandboxed = _policy(tmp_path)
    sandboxed = _policy(tmp_path, sandboxed=True)
    command = {"command": "ls"}

    assert unsandboxed.decide("Bash", command).verdict == "ask"
    assert sandboxed.decide("Bash", command).verdict == "allow"
    assert (
        sandboxed.decide("Bash", {**command, "dangerouslyDisableSandbox": True}).verdict
        == "ask"
    )


def test_providers_are_found_by_name() -> None:
    assert get_provider("fake").name == "fake"
    assert get_provider().name == "claude"

    with pytest.raises(UnknownProviderError):
        get_provider("nobody")


def test_fake_provider_streams_asks_and_calls_tools(tmp_path: Path) -> None:
    provider = FakeProvider()
    options = StartOptions(
        directory=tmp_path,
        policy=_policy(tmp_path),
        tools=create_server(lambda: None),
    )

    async def scenario() -> list[Any]:
        session = await provider.start(options)
        events: list[Any] = []

        async for event in session.send("hello there\n/ask\n/tool get_schema {}"):
            events.append(event)

            if isinstance(event, PermissionRequest):
                assert session.answer(event.id, allow=False)
                assert not session.answer(event.id, allow=True)

        await session.close()

        return events

    events = asyncio.run(scenario())
    kinds = [event.kind for event in events]

    assert kinds[0] == "text-delta"
    assert Text("You said: hello there") in events
    assert "permission" in kinds
    assert Text("Denied.") in events

    call = next(event for event in events if isinstance(event, ToolCall))
    result = next(event for event in events if isinstance(event, ToolResult))

    assert call.name == "mcp__workshop__get_schema"
    assert result.ok and '"title"' in result.summary
    assert isinstance(events[-1], Done)
    assert events[-1].to_dict()["kind"] == "done"


def test_fake_provider_can_be_interrupted_and_fail(tmp_path: Path) -> None:
    provider = FakeProvider()
    options = StartOptions(directory=tmp_path, policy=_policy(tmp_path), resume="s1")

    async def scenario() -> tuple[list[Any], list[Any]]:
        session = await provider.start(options)
        slow: list[Any] = []

        async for event in session.send("/slow"):
            slow.append(event)

            if len(slow) == 3:
                await session.interrupt()

        failed = [event async for event in session.send("/fail")]

        return slow, failed

    slow, failed = asyncio.run(scenario())

    assert slow[-1] == Done("s1", interrupted=True)
    assert len(slow) < 10
    assert isinstance(failed[0], Error)
    assert failed[-1] == Done("s1")


def test_auth_status_is_read_from_claude_code() -> None:
    subscription = parse_auth_status(
        0,
        json.dumps(
            {"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max"}
        ),
        environ={},
    )

    assert subscription.logged_in
    assert (subscription.auth_method, subscription.plan) == ("claude.ai", "max")
    assert subscription.warnings == ()

    assert not parse_auth_status(1, "", environ={}).logged_in
    assert not parse_auth_status(0, json.dumps({"authMethod": "none"}), {}).logged_in
    assert not parse_auth_status(0, "not json", environ={}).auth_method

    # A key in the environment takes the place of the subscription.
    api = parse_auth_status(
        0,
        json.dumps({"loggedIn": True, "authMethod": "api_key"}),
        environ={"ANTHROPIC_API_KEY": "sk-test"},
    )

    assert api.logged_in
    assert "ANTHROPIC_API_KEY" in api.warnings[0]


def test_skill_plugin_serves_the_installed_skill(tmp_path: Path) -> None:
    skill = skill_directory()

    assert skill is not None

    plugin = skill_plugin(skill, tmp_path, "1.2.3")
    manifest = json.loads((plugin / ".claude-plugin" / "plugin.json").read_text())

    assert manifest["name"] == "jupyterlab-workshop"
    assert manifest["version"] == "1.2.3"
    assert (plugin / "skills" / skill.name / "SKILL.md").is_file()

    # Asked again it is kept; a new version gets a directory of its own.
    assert skill_plugin(skill, tmp_path, "1.2.3") == plugin
    assert skill_plugin(skill, tmp_path, "1.2.4") != plugin
