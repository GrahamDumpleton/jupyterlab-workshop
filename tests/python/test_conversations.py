import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop.conversations import (
    AGENT_FILE,
    PROVIDER_VARIABLE,
    command_line,
)

MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\n"
    "name: demo\ntitle: Demo\npages: [pages/01.md]\n"
)


@pytest.fixture
def library(jp_root_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # The root is the library, with one workshop of the owner's and one
    # installed from a collection.
    monkeypatch.setenv(PROVIDER_VARIABLE, "fake")

    (jp_root_dir / "library.json").write_text('{"version": 1}\n')

    for path in ("personal/demo", "collections/course/other"):
        workshop = jp_root_dir / path

        (workshop / "pages").mkdir(parents=True)
        (workshop / "workshop.yaml").write_text(MANIFEST)
        (workshop / "pages" / "01.md").write_text("# Page\n")

    return jp_root_dir


async def _receive(socket: Any, kind: str, timeout: float = 10) -> list[dict]:
    """Messages up to and including the first of a type."""

    messages = []

    while True:
        text = await asyncio.wait_for(socket.read_message(), timeout)

        assert text is not None, "the socket closed"

        message = json.loads(text)
        messages.append(message)

        if message["type"] == kind:
            return messages


def _events(messages: list[dict]) -> list[dict]:
    return [m["event"] for m in messages if m["type"] == "event"]


async def test_agent_status_reports_the_provider(jp_fetch, library) -> None:
    response = await jp_fetch("jupyterlab-workshop", "agent", "status")
    status = json.loads(response.body)

    assert status["provider"] == "fake"
    assert status["logged_in"] is True
    assert status["login"] == command_line(["echo", "fake agent logged in"])

    platform = json.loads((await jp_fetch("jupyterlab-workshop", "platform")).body)

    assert platform["agent"] is True


async def test_a_conversation_streams_asks_and_resumes(jp_ws_fetch, library) -> None:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "path": "personal/demo", "directory": ".", "client": "t1"}
        )
    )

    opened = (await _receive(socket, "opened"))[-1]

    assert opened["path"] == "personal/demo"
    assert opened["history"] == []

    socket.write_message(json.dumps({"type": "send", "text": "hello\n/ask"}))

    messages = await _receive(socket, "event")

    while not any(e["kind"] == "permission" for e in _events(messages)):
        messages += await _receive(socket, "event")

    request = next(e for e in _events(messages) if e["kind"] == "permission")

    socket.write_message(
        json.dumps({"type": "permission", "id": request["id"], "allow": True})
    )

    messages += await _receive(socket, "state")

    while messages[-1] != {"type": "state", "running": False}:
        messages += await _receive(socket, "state")

    events = _events(messages)
    kinds = [event["kind"] for event in events]

    assert kinds[0] == "user"
    assert {"kind": "text", "text": "You said: hello"} in events
    assert {"kind": "text", "text": "Allowed."} in events
    assert kinds[-1] == "done"

    socket.close()

    # The record is kept in the workshop, deltas left out.
    record = json.loads((library / "personal/demo/_workshop" / AGENT_FILE).read_text())

    assert record["provider"] == "fake"
    assert record["session_id"].startswith("fake-")
    assert "text-delta" not in [event["kind"] for event in record["history"]]

    # A second socket attaches to the same conversation and is sent what
    # happened so far.
    again = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    again.write_message(
        json.dumps({"type": "open", "path": "personal/demo", "directory": "."})
    )

    reopened = (await _receive(again, "opened"))[-1]

    assert reopened["session_id"] == record["session_id"]

    # The panel can carry the conversation on in a terminal.
    again.write_message(json.dumps({"type": "terminal"}))

    terminal = (await _receive(again, "terminal"))[-1]

    assert terminal["cwd"] == "personal/demo"
    assert terminal["command"] == command_line(
        ["echo", f"fake conversation {record['session_id']}"]
    )
    assert [e["kind"] for e in reopened["history"]] == [
        e["kind"] for e in record["history"]
    ]

    again.close()


@pytest.mark.parametrize(
    ("path", "directory", "refusal"),
    [
        ("collections/course/other", ".", "your own workshops"),
        ("personal/missing", ".", "not a workshop"),
        ("personal/demo", "elsewhere", "workshop library"),
        ("../outside", ".", "inside the JupyterLab root"),
    ],
)
async def test_conversations_are_only_for_the_owners_workshops(
    jp_ws_fetch, library, path: str, directory: str, refusal: str
) -> None:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "path": path, "directory": directory})
    )

    error = (await _receive(socket, "error"))[-1]

    assert refusal in error["message"]

    socket.close()


async def test_a_downloaded_workshop_is_refused(jp_ws_fetch, library) -> None:
    state = library / "personal/demo/_workshop"

    state.mkdir()
    (state / "source.json").write_text("{}")

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "path": "personal/demo", "directory": "."})
    )

    error = (await _receive(socket, "error"))[-1]

    assert "downloaded" in error["message"]

    socket.close()


async def test_a_turn_can_be_interrupted(jp_ws_fetch, library) -> None:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "path": "personal/demo", "directory": "."})
    )
    await _receive(socket, "opened")

    socket.write_message(json.dumps({"type": "send", "text": "/slow"}))

    await _receive(socket, "event")
    await _receive(socket, "event")

    socket.write_message(json.dumps({"type": "interrupt"}))

    messages = await _receive(socket, "state")

    while messages[-1] != {"type": "state", "running": False}:
        messages += await _receive(socket, "state")

    done = [e for e in _events(messages) if e["kind"] == "done"]

    assert done and done[-1]["interrupted"] is True

    socket.close()


def test_idle_conversations_close_and_resume_from_their_record(
    tmp_path: Path,
) -> None:
    from jupyterlab_workshop.agents.fake import FakeProvider
    from jupyterlab_workshop.conversations import ConversationManager

    (tmp_path / "library.json").write_text('{"version": 1}\n')

    workshop = tmp_path / "personal" / "demo"

    workshop.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)

    provider = FakeProvider()
    manager = ConversationManager(tmp_path, None, provider=provider, idle_timeout=0)

    async def scenario() -> tuple[str | None, str | None, list[str]]:
        first = await manager.open("personal/demo", ".", workshop)

        await first.send("hello")

        assert await manager.open("personal/demo", ".", workshop) is first

        closed = await manager.close_idle()

        assert closed == ["personal/demo"]
        assert provider.sessions[0].closed

        second = await manager.open("personal/demo", ".", workshop)
        kinds = [event["kind"] for event in second.history]

        await manager.close_all()

        return first.session.session_id, second.session.session_id, kinds

    first_id, second_id, kinds = asyncio.run(scenario())

    # The second conversation resumed the first, with what was said.
    assert second_id == first_id
    assert kinds[:2] == ["user", "text"]


async def test_the_model_and_effort_can_be_changed(jp_ws_fetch, library) -> None:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {
                "type": "open",
                "path": "personal/demo",
                "directory": ".",
                "model": "quick",
            }
        )
    )

    opened = (await _receive(socket, "opened"))[-1]

    # The defaults from the settings apply, and the choices are listed.
    assert opened["info"]["model"] == "quick"
    assert [m["value"] for m in opened["info"]["models"]] == [
        "default",
        "quick",
        "careful",
    ]

    socket.write_message(
        json.dumps({"type": "configure", "model": "careful", "effort": "high"})
    )

    info = (await _receive(socket, "info"))[-1]["info"]

    assert (info["model"], info["effort"]) == ("careful", "high")

    # A message still goes to the same conversation, and the bar learns
    # how much of the context it took.
    socket.write_message(json.dumps({"type": "send", "text": "hello"}))

    after = (await _receive(socket, "info"))[-1]["info"]

    assert after["context_used"] == len("hello")

    socket.close()

    # The choice is the workshop's from now on, over the settings.
    record = json.loads((library / "personal/demo/_workshop" / AGENT_FILE).read_text())

    assert (record["model"], record["effort"]) == ("careful", "high")


async def test_a_conversation_can_be_compacted(jp_ws_fetch, library) -> None:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "path": "personal/demo", "directory": "."})
    )
    await _receive(socket, "opened")

    socket.write_message(json.dumps({"type": "send", "text": "hello"}))
    await _receive(socket, "info")

    # The button's compaction is a turn with no message of the person's.
    socket.write_message(json.dumps({"type": "compact"}))

    messages = await _receive(socket, "info")
    events = _events(messages)

    assert [event["kind"] for event in events] == ["compacting", "compacted", "done"]
    assert events[1]["trigger"] == "manual"
    assert messages[-1]["info"]["context_used"] == len("summary")

    socket.close()

    # The history keeps that it was compacted, not that it was compacting.
    record = json.loads((library / "personal/demo/_workshop" / AGENT_FILE).read_text())
    kinds = [event["kind"] for event in record["history"]]

    assert "compacted" in kinds
    assert "compacting" not in kinds


@pytest.mark.parametrize(
    "request_", [{"type": "clear"}, {"type": "send", "text": "/clear"}]
)
async def test_a_conversation_can_be_started_over(
    jp_ws_fetch, library, request_: dict
) -> None:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "path": "personal/demo", "directory": "."})
    )
    await _receive(socket, "opened")

    socket.write_message(
        json.dumps({"type": "configure", "model": "careful", "effort": "high"})
    )
    await _receive(socket, "info")

    socket.write_message(json.dumps({"type": "send", "text": "hello"}))
    await _receive(socket, "info")

    path = library / "personal/demo/_workshop" / AGENT_FILE
    before = json.loads(path.read_text())

    # Clearing goes to a new session, and /clear is not sent to the agent.
    socket.write_message(json.dumps(request_))

    messages = await _receive(socket, "info")

    assert messages[0] == {"type": "cleared"}
    assert _events(messages) == []

    after = json.loads(path.read_text())

    assert after["history"] == []
    assert after["session_id"] != before["session_id"]
    assert (after["model"], after["effort"]) == ("careful", "high")

    socket.close()

    # Opening again shows the new conversation, empty.
    again = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    again.write_message(
        json.dumps({"type": "open", "path": "personal/demo", "directory": "."})
    )

    reopened = (await _receive(again, "opened"))[-1]

    assert reopened["history"] == []
    assert reopened["session_id"] == after["session_id"]

    again.close()


async def test_stopping_the_server_closes_conversations(
    jp_serverapp, jp_ws_fetch, library
) -> None:
    from jupyterlab_workshop.bridge import SETTINGS_KEY as BRIDGE_KEY
    from jupyterlab_workshop.handlers import CONVERSATIONS_KEY

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "path": "personal/demo", "directory": "."})
    )
    await _receive(socket, "opened")

    # A turn in progress, and a tool waiting on a browser that will never
    # answer, as when JupyterLab is stopped mid-turn.
    socket.write_message(json.dumps({"type": "send", "text": "/slow"}))
    await _receive(socket, "event")

    settings = jp_serverapp.web_app.settings
    manager = settings[CONVERSATIONS_KEY]
    waiting = asyncio.ensure_future(
        settings[BRIDGE_KEY].request("workshop:run-all", {}, 600)
    )

    await asyncio.sleep(0)

    assert manager.running() == ["personal/demo"]

    # The extension's stop hook is what Jupyter Server calls on shutdown.
    for app in jp_serverapp.extension_manager.extension_apps["jupyterlab_workshop"]:
        assert app.current_activity() == ["personal/demo"]

        await app.stop_extension()

    assert manager.open_paths() == []

    with pytest.raises(Exception, match="shutting down"):
        await waiting

    socket.close()
