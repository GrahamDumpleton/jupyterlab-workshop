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
    # The root is the library, with one workshop of the owner's, one
    # installed from a collection, and a course of the owner's holding one
    # workshop.
    monkeypatch.setenv(PROVIDER_VARIABLE, "fake")

    (jp_root_dir / "library.json").write_text('{"version": 2}\n')

    for path in (
        "personal/workshops/demo",
        "installed/collections/course/other",
        "personal/courses/my-course/workshops/inner",
    ):
        workshop = jp_root_dir / path

        (workshop / "pages").mkdir(parents=True)
        (workshop / "workshop.yaml").write_text(MANIFEST)
        (workshop / "pages" / "01.md").write_text("# Page\n")

    (jp_root_dir / "personal/courses/my-course/OUTLINE.md").write_text("# Outline\n")

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
            {
                "type": "open",
                "path": "personal/workshops/demo",
                "directory": ".",
                "client": "t1",
            }
        )
    )

    opened = (await _receive(socket, "opened"))[-1]

    assert opened["path"] == "personal/workshops/demo"
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
    record = json.loads(
        (library / "personal/workshops/demo/_workshop" / AGENT_FILE).read_text()
    )

    assert record["provider"] == "fake"
    assert record["session_id"].startswith("fake-")
    assert "text-delta" not in [event["kind"] for event in record["history"]]

    # A second socket attaches to the same conversation and is sent what
    # happened so far.
    again = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    again.write_message(
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
    )

    reopened = (await _receive(again, "opened"))[-1]

    assert reopened["session_id"] == record["session_id"]

    # The panel can carry the conversation on in a terminal.
    again.write_message(json.dumps({"type": "terminal"}))

    terminal = (await _receive(again, "terminal"))[-1]

    assert terminal["cwd"] == "personal/workshops/demo"
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
        ("installed/collections/course/other", ".", "your own workshops"),
        ("personal/workshops/missing", ".", "not a workshop"),
        ("personal/workshops/demo", "elsewhere", "workshop library"),
        ("../outside", ".", "inside the JupyterLab root"),
        ("personal/courses/missing", ".", "not a course"),
        (
            "personal/courses/my-course/workshops/inner",
            ".",
            "open Workshop Author on personal/courses/my-course",
        ),
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


async def test_a_course_has_one_conversation_at_its_root(
    jp_serverapp, jp_ws_fetch, library
) -> None:
    import base64

    from jupyterlab_workshop.handlers import CONVERSATIONS_KEY

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "path": "personal/courses/my-course", "directory": "."}
        )
    )

    opened = (await _receive(socket, "opened"))[-1]

    assert (opened["path"], opened["kind"]) == ("personal/courses/my-course", "course")

    # The agent works in the course's directory, is told about the course,
    # and may write anywhere in it, a workshop of the course included.
    manager = jp_serverapp.web_app.settings[CONVERSATIONS_KEY]
    conversation = manager.get("personal/courses/my-course")
    options = conversation.options

    assert options.directory == library / "personal/courses/my-course"
    assert "Read AGENTS.md and OUTLINE.md" in options.instructions
    assert "personal/courses/my-course/workshops/<name>" in options.instructions
    assert (
        options.policy.decide(
            "Write", {"file_path": "workshops/inner/pages/02.md"}
        ).verdict
        == "allow"
    )

    # What is said and attached is kept at the course root, in .workshop/,
    # since _workshop/ is a workshop's own state directory.
    notes = base64.b64encode(b"a syllabus").decode("ascii")

    socket.write_message(
        json.dumps(
            {
                "type": "send",
                "text": "use this",
                "attachments": [
                    {"name": "syllabus.txt", "type": "text/plain", "data": notes}
                ],
            }
        )
    )
    await _receive(socket, "info")

    course = library / "personal/courses/my-course"
    record = json.loads((course / ".workshop" / AGENT_FILE).read_text())

    assert record["kind"] == "course"
    assert (course / ".workshop/attachments/syllabus.txt").read_text() == "a syllabus"
    assert not (course / "_workshop").exists()

    # A terminal carries the conversation on in the course's directory.
    socket.write_message(json.dumps({"type": "terminal"}))

    assert (await _receive(socket, "terminal"))[-1]["cwd"] == (
        "personal/courses/my-course"
    )

    socket.close()


async def test_a_downloaded_workshop_is_refused(jp_ws_fetch, library) -> None:
    state = library / "personal/workshops/demo/_workshop"

    state.mkdir()
    (state / "source.json").write_text("{}")

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
    )

    error = (await _receive(socket, "error"))[-1]

    assert "downloaded" in error["message"]

    socket.close()


async def test_a_turn_can_be_interrupted(jp_ws_fetch, library) -> None:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
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

    (tmp_path / "library.json").write_text('{"version": 2}\n')

    workshop = tmp_path / "personal" / "workshops" / "demo"

    workshop.mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)

    provider = FakeProvider()
    manager = ConversationManager(tmp_path, None, provider=provider, idle_timeout=0)

    async def scenario() -> tuple[str | None, str | None, list[str]]:
        first = await manager.open("personal/workshops/demo", ".", workshop)

        await first.send("hello")

        assert await manager.open("personal/workshops/demo", ".", workshop) is first

        closed = await manager.close_idle()

        assert closed == ["personal/workshops/demo"]
        assert provider.sessions[0].closed

        second = await manager.open("personal/workshops/demo", ".", workshop)
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
                "path": "personal/workshops/demo",
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
    record = json.loads(
        (library / "personal/workshops/demo/_workshop" / AGENT_FILE).read_text()
    )

    assert (record["model"], record["effort"]) == ("careful", "high")


async def test_a_conversation_can_be_compacted(jp_ws_fetch, library) -> None:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
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
    record = json.loads(
        (library / "personal/workshops/demo/_workshop" / AGENT_FILE).read_text()
    )
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
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
    )
    await _receive(socket, "opened")

    socket.write_message(
        json.dumps({"type": "configure", "model": "careful", "effort": "high"})
    )
    await _receive(socket, "info")

    socket.write_message(json.dumps({"type": "send", "text": "hello"}))
    await _receive(socket, "info")

    path = library / "personal/workshops/demo/_workshop" / AGENT_FILE
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
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
    )

    reopened = (await _receive(again, "opened"))[-1]

    assert reopened["history"] == []
    assert reopened["session_id"] == after["session_id"]

    again.close()


async def test_files_attached_to_a_message_are_saved_and_shown(
    jp_serverapp, jp_ws_fetch, library
) -> None:
    import base64

    from jupyterlab_workshop.handlers import CONVERSATIONS_KEY

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
    )
    await _receive(socket, "opened")

    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 8).decode("ascii")
    notes = base64.b64encode(b"some notes").decode("ascii")

    socket.write_message(
        json.dumps(
            {
                "type": "send",
                "text": "use these",
                "attachments": [
                    {"name": "shot.png", "type": "image/png", "data": png},
                    {"name": "notes.txt", "type": "text/plain", "data": notes},
                ],
            }
        )
    )

    events = _events(await _receive(socket, "info"))
    attachments = library / "personal/workshops/demo/_workshop/attachments"

    # The message shows what was attached, without the content, and the
    # agent was given the files where they were saved.
    assert events[0]["kind"] == "user"
    assert events[0]["text"] == "use these"
    assert events[0]["attachments"] == [
        {"name": "shot.png", "type": "image/png", "size": 16},
        {"name": "notes.txt", "type": "text/plain", "size": 10},
    ]
    assert (attachments / "shot.png").is_file()
    assert (attachments / "notes.txt").read_text() == "some notes"

    reply = next(e for e in events if e["kind"] == "text")

    assert reply["text"].startswith("Attached: shot.png (image/png, 16 bytes) at ")
    assert str(attachments / "notes.txt") in reply["text"]

    session = jp_serverapp.web_app.settings[CONVERSATIONS_KEY].provider.sessions[-1]

    assert [a.path for a in session.attached] == [
        attachments / "shot.png",
        attachments / "notes.txt",
    ]

    # A file that cannot be attached is refused, and nothing is sent.
    socket.write_message(
        json.dumps(
            {
                "type": "send",
                "text": "and this",
                "attachments": [
                    {"name": "tool.exe", "type": "application/x-msdownload", "data": ""}
                ],
            }
        )
    )

    assert "cannot be attached" in (await _receive(socket, "error"))[-1]["message"]
    assert session.received == ["use these"]

    # Starting over takes the attachments with it.
    socket.write_message(json.dumps({"type": "clear"}))
    await _receive(socket, "info")

    assert not attachments.exists()

    socket.close()


async def test_stopping_the_server_closes_conversations(
    jp_serverapp, jp_ws_fetch, library
) -> None:
    from jupyterlab_workshop.bridge import SETTINGS_KEY as BRIDGE_KEY
    from jupyterlab_workshop.handlers import CONVERSATIONS_KEY

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
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

    assert manager.running() == ["personal/workshops/demo"]

    # The extension's stop hook is what Jupyter Server calls on shutdown.
    for app in jp_serverapp.extension_manager.extension_apps["jupyterlab_workshop"]:
        assert app.current_activity() == ["personal/workshops/demo"]

        await app.stop_extension()

    assert manager.open_paths() == []

    with pytest.raises(Exception, match="shutting down"):
        await waiting

    socket.close()


PLAN = {
    "title": "Git basics",
    "name": "git-basics",
    "audience": "newcomers",
    "summary": "The first steps with git, for someone who has never used it.",
    "outline": ["Make a repository", "Make the first commit"],
    "quizzes": True,
    "gating": True,
}


async def _draft(
    jp_ws_fetch: Any, draft: str = "0123abcd-ef45", kind: str = "workshop"
) -> Any:
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "draft": draft, "directory": ".", "kind": kind})
    )

    opened = (await _receive(socket, "opened"))[-1]

    assert opened["draft"] == draft
    assert opened["kind"] == kind
    assert opened["history"] == []

    return socket


async def _turn(socket: Any, text: str) -> list[dict]:
    socket.write_message(json.dumps({"type": "send", "text": text}))

    return _events(await _receive(socket, "info"))


async def test_a_workshop_is_drafted_and_created_from_the_plan(
    jp_ws_fetch, library
) -> None:
    socket = await _draft(jp_ws_fetch)

    # Creating before anything is proposed is refused.
    socket.write_message(json.dumps({"type": "create"}))

    refused = (await _receive(socket, "error"))[-1]

    assert "Nothing has been proposed" in refused["message"]

    # A plan that could not be created is an error the agent reads.
    taken = {**PLAN, "name": "demo"}
    events = await _turn(socket, f"/tool propose_workshop {json.dumps(taken)}")
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is False
    assert "personal/workshops/demo already exists" in result["summary"]

    # A good plan is kept, and nothing exists in the library yet.
    events = await _turn(socket, f"/tool propose_workshop {json.dumps(PLAN)}")
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is True
    assert not (library / "personal" / "workshops" / "git-basics").exists()

    # A file attached while drafting is saved with the draft, outside the
    # library.
    socket.write_message(
        json.dumps(
            {
                "type": "send",
                "text": "",
                "attachments": [
                    {"name": "plan.md", "type": "text/markdown", "data": "IyBIaQ=="}
                ],
            }
        )
    )
    await _receive(socket, "info")

    assert not list(library.rglob("plan.md"))

    # Create makes the workshop, and the panel is told where to go.
    socket.write_message(json.dumps({"type": "create"}))

    created = (await _receive(socket, "created"))[-1]

    assert created["path"] == "personal/workshops/git-basics"

    manifest = (library / "personal/workshops/git-basics/workshop.yaml").read_text()

    # The workshop is the person's own, so it starts as a repository.
    assert (library / "personal/workshops/git-basics/.git").is_dir()

    assert "title: Git basics" in manifest
    assert "gating: soft" in manifest

    socket.close()

    # The workshop's conversation has what was said in the draft, then
    # begins with the plan as its brief.
    again = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    again.write_message(
        json.dumps(
            {"type": "open", "path": "personal/workshops/git-basics", "directory": "."}
        )
    )

    reopened = (await _receive(again, "opened"))[-1]
    kinds = [event["kind"] for event in reopened["history"]]

    assert kinds.count("tool-call") == 2
    created_note = {"kind": "note", "text": "Created personal/workshops/git-basics."}

    assert created_note in reopened["history"]

    if reopened["running"]:
        await _receive(again, "info")

    record = json.loads(
        (library / "personal/workshops/git-basics/_workshop" / AGENT_FILE).read_text()
    )
    first = next(
        event
        for event in record["history"]
        if event["kind"] == "user" and "Write the workshop we agreed" in event["text"]
    )

    assert "1. Make a repository" in first["text"]

    # The draft's attachment went with the workshop, and the brief says so.
    assert (
        library / "personal/workshops/git-basics/_workshop/attachments/plan.md"
    ).read_text() == "# Hi"
    assert "attached while drafting" in first["text"]
    assert "plan.md" in first["text"]

    again.close()


COURSE_PLAN = {
    "title": "Python for analysts",
    "name": "python-course",
    "description": "Python from the first line to a working analysis, for analysts.",
    "collections": [
        {"name": "basics", "title": "The basics", "description": "The language."},
        {"name": "data", "title": "Working with data"},
    ],
    "id_prefix": "github.com/example",
    "lite": True,
}


async def test_a_course_is_drafted_and_created_from_the_plan(
    jp_ws_fetch, library
) -> None:
    socket = await _draft(jp_ws_fetch, "c0a5e000-0001", kind="course")

    # A plan the scaffold could not write, or whose name is taken, is an
    # error the agent reads.
    bad = {**COURSE_PLAN, "collections": [{"name": "Bad Name", "title": "Bad"}]}
    events = await _turn(socket, f"/tool propose_course {json.dumps(bad)}")
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is False
    assert "cannot be a collection name" in result["summary"]

    taken = {**COURSE_PLAN, "name": "my-course"}
    events = await _turn(socket, f"/tool propose_course {json.dumps(taken)}")
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is False
    assert "personal/courses/my-course already exists" in result["summary"]

    # A good plan is kept, and nothing exists in the library yet.
    events = await _turn(socket, f"/tool propose_course {json.dumps(COURSE_PLAN)}")
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is True
    assert not (library / "personal/courses/python-course").exists()

    socket.write_message(
        json.dumps(
            {
                "type": "send",
                "text": "",
                "attachments": [
                    {"name": "syllabus.md", "type": "text/markdown", "data": "IyBIaQ=="}
                ],
            }
        )
    )
    await _receive(socket, "info")

    # Create scaffolds the whole repository, as course init does, and the
    # panel is told where to go.
    socket.write_message(json.dumps({"type": "create"}))

    created = (await _receive(socket, "created"))[-1]

    assert created["path"] == "personal/courses/python-course"

    course = library / "personal/courses/python-course"

    assert (course / ".git").is_dir()
    assert (course / "OUTLINE.md").is_file()
    assert (course / "collections/basics/collection.json").is_file()
    assert (course / "collections/data/collection.json").is_file()
    assert (course / "lite/settings.json").is_file()

    record = json.loads((course / "course.json").read_text())

    assert record["idPrefix"] == "github.com/example"
    assert record["collections"][1]["title"] == "Working with data"

    socket.close()

    # The course's conversation has what was said in the draft, then
    # begins with the plan as its brief, recorded at the course root.
    again = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    again.write_message(
        json.dumps(
            {"type": "open", "path": "personal/courses/python-course", "directory": "."}
        )
    )

    reopened = (await _receive(again, "opened"))[-1]

    assert reopened["kind"] == "course"
    assert {"kind": "note", "text": "Created personal/courses/python-course."} in (
        reopened["history"]
    )

    if reopened["running"]:
        await _receive(again, "info")

    agent_record = json.loads((course / ".workshop" / AGENT_FILE).read_text())
    first = next(
        event
        for event in agent_record["history"]
        if event["kind"] == "user" and "Design the course we agreed" in event["text"]
    )

    assert "1. The basics (basics): The language." in first["text"]
    assert "2. Working with data (data)" in first["text"]
    assert "JupyterLab and JupyterLite" in first["text"]
    assert (course / ".workshop/attachments/syllabus.md").read_text() == "# Hi"
    assert ".workshop/attachments/" in first["text"]

    again.close()


async def test_a_draft_cannot_write_and_can_be_discarded(
    jp_serverapp, jp_ws_fetch, library
) -> None:
    from jupyterlab_workshop.handlers import CONVERSATIONS_KEY

    manager = jp_serverapp.web_app.settings[CONVERSATIONS_KEY]
    socket = await _draft(jp_ws_fetch, "feed0000-0001")

    await _turn(socket, "hello")

    # The draft's policy refuses writes and commands, and its record lives
    # outside the library.
    conversation = manager.get("draft:feed0000-0001")
    policy = conversation.options.policy

    assert policy.decide("Write", {"file_path": "x.md"}).verdict == "deny"
    assert policy.decide("Bash", {"command": "ls"}).verdict == "deny"
    assert library not in conversation.directory.parents
    assert (conversation.directory / "_workshop" / AGENT_FILE).is_file()

    socket.write_message(json.dumps({"type": "discard"}))

    await _receive(socket, "closed")

    assert manager.get("draft:feed0000-0001") is None
    assert not conversation.directory.exists()

    socket.close()


async def test_a_draft_needs_a_library_and_a_proper_id(
    jp_ws_fetch, jp_root_dir, monkeypatch
) -> None:
    monkeypatch.setenv(PROVIDER_VARIABLE, "fake")

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "draft": "../x", "directory": "."})
    )

    assert (await _receive(socket, "error"))[-1]["message"] == "Not a draft id"

    socket.write_message(
        json.dumps(
            {"type": "open", "draft": "0123abcd-ef45", "directory": ".", "kind": "x"}
        )
    )

    assert "Not something to draft" in (await _receive(socket, "error"))[-1]["message"]

    socket.close()


async def test_the_mentor_keeps_the_profile_and_workshop_author_reads_it(
    jp_serverapp, jp_ws_fetch, library
) -> None:
    from jupyterlab_workshop.handlers import CONVERSATIONS_KEY

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "kind": "mentor", "path": "journal", "directory": "."}
        )
    )

    opened = (await _receive(socket, "opened"))[-1]

    assert (opened["path"], opened["kind"]) == ("journal", "mentor")
    assert (library / "journal" / "settings.yaml").is_file()

    # The mentor works in the journal, is told the person is new, may read
    # the person's own workshops but nothing downloaded, and writes only
    # through its tool.
    manager = jp_serverapp.web_app.settings[CONVERSATIONS_KEY]
    conversation = manager.get("journal")
    options = conversation.options
    policy = options.policy

    assert options.directory == library / "journal"
    assert "has not met you before" in options.instructions
    assert "not Workshop Author" in options.instructions

    refused = policy.decide("Write", {"file_path": "profile.md"})

    assert refused.verdict == "deny"
    assert "write_profile" in refused.reason
    assert policy.decide("Bash", {"command": "ls"}).verdict == "deny"
    assert (
        policy.decide(
            "Read", {"file_path": "../personal/workshops/demo/workshop.yaml"}
        ).verdict
        == "allow"
    )
    assert (
        policy.decide(
            "Read", {"file_path": "../installed/collections/course/other/workshop.yaml"}
        ).verdict
        == "deny"
    )

    # Before anything is written the journal says so; the profile is
    # written whole, with its date; an offer and the library listing work.
    events = await _turn(socket, "/tool read_journal")
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is True
    assert "No profile has been written" in result["summary"]

    # One workshop's record in detail, by the path the library gives, and
    # a refusal for a path that is not a workshop.
    events = await _turn(socket, '/tool progress {"path": "personal/workshops/demo"}')
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is True
    assert '"status": "not started"' in result["summary"]
    assert "author mode" in result["summary"]

    events = await _turn(socket, '/tool progress {"path": "../elsewhere"}')
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is False
    assert "There is no workshop at ../elsewhere" in result["summary"]

    events = await _turn(
        socket,
        '/tool write_profile {"text": "# Me\\n\\nI know Python and want async."}',
    )
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is True
    assert "profile.md" in result["summary"]

    profile = (library / "journal" / "profile.md").read_text()

    assert profile.startswith("---\nupdated: ")
    assert profile.endswith("# Me\n\nI know Python and want async.\n")

    events = await _turn(socket, '/tool write_profile {"text": "  "}')
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is False
    assert "cannot be empty" in result["summary"]

    events = await _turn(
        socket,
        '/tool offer_workshop {"kind": "workshop", "title": "Async", '
        '"brief": "Teach asyncio."}',
    )
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is True
    assert "Offered" in result["summary"]

    events = await _turn(socket, "/tool list_library")
    result = next(e for e in events if e["kind"] == "tool-result")

    assert result["ok"] is True
    assert "personal/workshops/demo" in result["summary"]

    socket.close()

    # The record lives in the journal itself.
    assert (library / "journal" / AGENT_FILE).is_file()

    # Workshop Author, on a workshop and while drafting, is told about the
    # person from the profile.
    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps(
            {"type": "open", "path": "personal/workshops/demo", "directory": "."}
        )
    )
    await _receive(socket, "opened")

    told = manager.get("personal/workshops/demo").options.instructions

    assert "I know Python and want async." in told
    assert "write for this person" in told

    socket.close()

    socket = await _draft(jp_ws_fetch, draft="0123abcd-ef46")

    assert (
        "I know Python and want async."
        in manager.get("draft:0123abcd-ef46").options.instructions
    )

    socket.close()

    # The mentor is told differently once a profile exists.
    await manager.close("journal")

    socket = await jp_ws_fetch("jupyterlab-workshop", "agent", "conversation")

    socket.write_message(
        json.dumps({"type": "open", "kind": "mentor", "directory": "."})
    )
    await _receive(socket, "opened")

    told = manager.get("journal").options.instructions

    assert "Read the journal before anything else" in told
    assert "has not met you before" not in told

    socket.close()
