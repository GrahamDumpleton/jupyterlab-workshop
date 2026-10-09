"""Conversations with an AI agent about a workshop, held in the server.

The agent runs inside Jupyter Server, not in the browser, so a
conversation outlives the page that started it: reloading the page, or
opening the panel in another tab, attaches to the same conversation and
is sent what happened so far. There is one conversation per workshop.

A conversation is only ever started for the library owner's own
workshops, under `personal/workshops/`, or for one of their courses
under `personal/courses/`, never for an installed workshop: the agent
runs with the workshop or course as its working directory, and a
workshop someone else wrote could ship agent configuration that would
then be obeyed. Each workshop keeps its conversation's id, and what was
said, in `_workshop/agent.json`, so it carries on after a restart.

A course has one conversation, about the whole repository, kept in
`.workshop/agent.json` at its root, since `_workshop/` is a workshop's
own state directory and two agents editing one repository and one
outline would work against each other. A workshop inside a course is
written in the course's conversation, never in one of its own.

A new workshop or course starts as a draft: a conversation with nothing
behind it, held under `draft:<id>` and recorded in the server's data
directory, in which the agent may only read, research and propose (see
`drafting.py`). Creating from the plan moves what was said into the new
workshop's or course's conversation, which then begins with the plan as
its brief.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import posixpath
import shlex
import shutil
import subprocess
import sys
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .agents import get_provider
from .agents.base import (
    AgentEvent,
    AgentProvider,
    AgentSession,
    Done,
    StartOptions,
)
from .agents.policy import PermissionPolicy
from .attachments import (
    ATTACHMENTS_DIR,
    Attachment,
    attachments_directory,
    save_attachments,
)
from .bridge import Bridge
from .collection import STATE_DIR
from .drafting import (
    DRAFT_PATTERN,
    CourseProposal,
    Proposal,
    ProposalError,
    brief,
    check_course_proposal,
    check_proposal,
    course_brief,
    course_draft_instructions,
    create_course_draft_server,
    create_draft_server,
    draft_instructions,
)
from .library import (
    COURSES_DIRECTORY,
    INSTALLED_DIRECTORY,
    NEEDS_UPGRADE_MESSAGE,
    PERSONAL_WORKSHOPS_DIRECTORY,
    LibraryError,
    course_of_path,
    is_library,
    is_own_library_path,
    library_directory,
    needs_upgrade,
    read_library,
)

log = logging.getLogger(__name__)

# The file a conversation is kept in, under its state directory.
AGENT_FILE = "agent.json"

# A course's state directory, at its root; `_workshop/` is a workshop's.
COURSE_STATE_DIR = ".workshop"

# What a conversation can be about.
KINDS = ("workshop", "course")

# The environment variable naming the provider, for tests.
PROVIDER_VARIABLE = "JUPYTERLAB_WORKSHOP_AGENT_PROVIDER"

# How long a conversation nobody is attached to stays open.
IDLE_TIMEOUT = 30 * 60.0

# How many events of a conversation are kept to show again.
HISTORY_LIMIT = 500

# How much of a tool call's input is kept in the history.
INPUT_LIMIT = 2000

Listener = Callable[[dict[str, Any]], Awaitable[None] | None]

# Events shown as they happen but not kept in the history.
_TRANSIENT = ("text-delta", "compacting")

# The key a draft's conversation is held under, before its workshop exists.
DRAFT_PREFIX = "draft:"

# How long an untouched draft's record is kept.
DRAFT_LIFETIME = 30 * 24 * 60 * 60.0

# What typed as a message starts the conversation over, as these do in
# Claude Code.
CLEAR_COMMANDS = ("/clear", "/reset", "/new")

# Idle checks in progress, held so they are not collected while they run.
_REAPING: set[asyncio.Future[None]] = set()


class ConversationError(Exception):
    """A conversation cannot be opened or used as asked."""


@dataclass
class Conversation:
    """One workshop's or course's conversation and who is watching it."""

    # The workshop's or course's path relative to the JupyterLab root, as
    # the browser names it; `draft:<id>` for one still being drafted.
    path: str

    # The directory on disk, which may lie behind a course link.
    directory: Path

    session: AgentSession

    provider: str

    # Whether it is about a workshop or a course, drafted or made.
    kind: str = "workshop"

    # The directory under `directory` the record and attachments live in.
    state_dir: str = STATE_DIR

    # What the conversation was started with, for its terminal command.
    options: StartOptions | None = None

    # The model and effort chosen, empty for the agent's defaults.
    model: str = ""
    effort: str = ""

    # What the conversation has cost so far, where the agent says.
    cost: float = 0.0

    # The browser tab the live tools act in: the last to attach.
    client: str = ""

    history: list[dict[str, Any]] = field(default_factory=list)

    listeners: list[Listener] = field(default_factory=list)

    running: bool = False

    last_active: float = field(default_factory=time.monotonic)

    created: str = field(default_factory=lambda: _now())

    # The draft's id while the workshop or course is being drafted, and
    # the plan last proposed for it.
    draft: str = ""
    proposal: Proposal | CourseProposal | None = None

    # The workshops directory the draft's workshop or course is created in.
    workshops_directory: str = ""

    async def send(self, text: str, attachments: Sequence[Attachment] = ()) -> None:
        """Send a message, with any files attached, telling every listener.

        The attachments are saved beside the conversation's record first,
        so the agent can read them, and the history keeps what they were
        but not their content.
        """

        if self.running:
            raise ConversationError("The agent is still working on the last message")

        try:
            saved = save_attachments(self.directory, attachments, self.state_dir)
        except OSError as error:
            raise ConversationError(
                f"Unable to save the attachments: {error}"
            ) from error

        message: dict[str, Any] = {"kind": "user", "text": text}

        if saved:
            message["attachments"] = [item.describe() for item in saved]

        await self._turn(message, lambda: self.session.send(text, saved))

    async def compact(self) -> None:
        """Summarize the conversation so far, to free the context window."""

        await self._turn(None, self.session.compact)

    async def reset(self) -> None:
        """Tell every listener the conversation has started over."""

        await self._broadcast({"type": "cleared"})
        await self.publish_info()

    async def _turn(
        self,
        message: dict[str, Any] | None,
        stream: Callable[[], AsyncIterator[AgentEvent]],
    ) -> None:
        if self.running:
            raise ConversationError("The agent is still working on the last message")

        self.running = True
        self.last_active = time.monotonic()

        if message is not None:
            await self._publish(message)

        await self._broadcast({"type": "state", "running": True})

        try:
            async for event in stream():
                await self._publish(event.to_dict())

                if isinstance(event, Done):
                    self.cost += event.cost or 0.0

                    break
        except Exception as error:
            log.exception("The conversation about %s failed", self.path)

            await self._publish({"kind": "error", "message": str(error)})
        finally:
            self.running = False
            self.last_active = time.monotonic()

            self.save()

            await self._broadcast({"type": "state", "running": False})
            await self.publish_info()

    async def info(self) -> dict[str, Any]:
        """What the conversation runs on, as the panel's status bar shows it."""

        try:
            info = (await self.session.info()).to_dict()
        except Exception:
            log.debug("Unable to ask the agent what it runs on", exc_info=True)

            info = {"model": self.model, "effort": self.effort, "models": []}

        return {**info, "cost": self.cost}

    async def publish_info(self) -> None:
        """Tell every listener what the conversation runs on now."""

        await self._broadcast({"type": "info", "info": await self.info()})

    def save(self) -> None:
        """Record the conversation in the agent.json of its state directory."""

        state = self.directory / self.state_dir
        data: dict[str, Any] = {
            "kind": self.kind,
            "provider": self.provider,
            "session_id": self.session.session_id,
            "model": self.model,
            "effort": self.effort,
            "cost": self.cost,
            "created": self.created,
            "updated": _now(),
            "history": self.history[-HISTORY_LIMIT:],
        }

        if self.draft:
            data["proposal"] = self.proposal.to_dict() if self.proposal else None

        try:
            state.mkdir(parents=True, exist_ok=True)

            temporary = state / f".{AGENT_FILE}.tmp"
            temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, state / AGENT_FILE)
        except OSError:
            log.warning("Unable to save the conversation about %s", self.path)

    def attach(self, listener: Listener, client: str) -> None:
        """Start telling a listener what happens, its tab now the target."""

        self.listeners.append(listener)
        self.last_active = time.monotonic()

        if client:
            self.client = client

    def detach(self, listener: Listener) -> None:
        """Stop telling a listener."""

        if listener in self.listeners:
            self.listeners.remove(listener)

        self.last_active = time.monotonic()

    async def announce(self, message: dict[str, Any]) -> None:
        """Tell every listener something about the conversation itself."""

        await self._broadcast(message)

    async def _publish(self, event: dict[str, Any]) -> None:
        # Streamed pieces of a reply are sent but not kept: the complete
        # block that follows them is. Nor is the start of a compaction,
        # which only matters while it runs.
        if event.get("kind") not in _TRANSIENT:
            self.history.append(_shortened(event))

            del self.history[:-HISTORY_LIMIT]

        await self._broadcast({"type": "event", "event": event})

    async def _broadcast(self, message: dict[str, Any]) -> None:
        for listener in list(self.listeners):
            try:
                result = listener(message)

                if result is not None:
                    await result
            except Exception:
                log.debug("Dropping a conversation listener that failed")

                self.detach(listener)


class ConversationManager:
    """The open conversations of a server, by workshop."""

    def __init__(
        self,
        root_dir: Path,
        bridge: Bridge | None,
        provider: AgentProvider | None = None,
        skill: Path | None = None,
        idle_timeout: float = IDLE_TIMEOUT,
        drafts: Path | None = None,
    ) -> None:
        self._root = root_dir
        self._drafts = drafts
        self._bridge = bridge
        self._provider = provider
        self._skill = skill
        self._idle_timeout = idle_timeout
        self._conversations: dict[str, Conversation] = {}
        self._opening: dict[str, asyncio.Lock] = {}
        self._reaper: asyncio.TimerHandle | None = None

    @property
    def provider(self) -> AgentProvider:
        """The provider conversations are held with."""

        if self._provider is None:
            self._provider = get_provider(
                os.environ.get(PROVIDER_VARIABLE, "") or "claude"
            )

        return self._provider

    @property
    def drafts_directory(self) -> Path:
        """Where drafts are recorded: the server's data directory."""

        if self._drafts is None:
            from jupyter_core.paths import jupyter_data_dir

            self._drafts = Path(jupyter_data_dir()) / "jupyterlab_workshop" / "drafts"

        return self._drafts

    def open_paths(self) -> list[str]:
        """The workshops with a conversation open."""

        return list(self._conversations)

    def running(self) -> list[str]:
        """The workshops whose conversation has a turn in progress."""

        return [
            path
            for path, conversation in self._conversations.items()
            if conversation.running
        ]

    def get(self, path: str) -> Conversation | None:
        """The open conversation about a workshop, if there is one."""

        return self._conversations.get(path)

    async def open(
        self,
        path: str,
        workshops_directory: str,
        directory: Path,
        model: str = "",
        effort: str = "",
    ) -> Conversation:
        """The conversation about a workshop or a course, started or resumed
        if needed.

        `directory` is the workshop or course on disk, already checked to
        be under the root; `path` is the same relative to the root. The
        model and effort are the settings' defaults, used unless the
        conversation has chosen its own.
        """

        kind = self._check(path, workshops_directory, directory)

        lock = self._opening.setdefault(path, asyncio.Lock())

        async with lock:
            existing = self._conversations.get(path)

            if existing is not None:
                return existing

            conversation = await self._start(
                path, workshops_directory, directory, model, effort, kind
            )

            self._conversations[path] = conversation

        self._start_reaper()

        return conversation

    async def configure(
        self, conversation: Conversation, model: str, effort: str
    ) -> None:
        """Change the model or the effort, between turns.

        A model changes in the running conversation. Effort is fixed when a
        conversation starts, so a change of effort starts it again from
        where it was, which keeps everything said so far.
        """

        if conversation.running:
            raise ConversationError(
                "Wait for the agent to finish before changing the model or effort"
            )

        if effort != conversation.effort and conversation.options is not None:
            await conversation.session.close()

            options = replace(
                conversation.options,
                resume=conversation.session.session_id,
                model=model,
                effort=effort,
            )

            conversation.session = await self.provider.start(options)
            conversation.options = options

        elif model != conversation.model:
            await conversation.session.set_model(model)

        conversation.model = model
        conversation.effort = effort

        conversation.save()

        await conversation.publish_info()

    async def clear(self, conversation: Conversation) -> None:
        """Start a workshop's conversation over, forgetting what was said.

        The agent starts a new session, with the same model and effort,
        the workshop's record keeps only the new one, and the files
        attached to the old one go with it.
        """

        if conversation.running:
            raise ConversationError(
                "Wait for the agent to finish before starting a new conversation"
            )

        if conversation.options is None:
            raise ConversationError("This conversation cannot be started over")

        await conversation.session.close()

        shutil.rmtree(
            attachments_directory(conversation.directory, conversation.state_dir),
            ignore_errors=True,
        )

        options = replace(
            conversation.options,
            resume=None,
            model=conversation.model,
            effort=conversation.effort,
        )

        conversation.session = await self.provider.start(options)
        conversation.options = options
        conversation.history = []
        conversation.proposal = None
        conversation.cost = 0.0
        conversation.created = _now()

        conversation.save()

        await conversation.reset()

    async def open_draft(
        self,
        draft: str,
        workshops_directory: str,
        model: str = "",
        effort: str = "",
        kind: str = "workshop",
    ) -> Conversation:
        """The conversation drafting a new workshop or course, started or
        resumed.

        `draft` is the id the panel made for it. Nothing is created in the
        library until `create` is called with the plan the agent proposed.
        """

        if not DRAFT_PATTERN.match(draft):
            raise ConversationError("Not a draft id")

        if kind not in KINDS:
            raise ConversationError(f"Not something to draft: {kind}")

        if not is_library(self._root, workshops_directory):
            raise ConversationError("Workshop Author works only in a workshop library")

        self._check_upgraded(workshops_directory)

        key = DRAFT_PREFIX + draft
        lock = self._opening.setdefault(key, asyncio.Lock())

        async with lock:
            existing = self._conversations.get(key)

            if existing is not None:
                return existing

            self._prune_drafts()

            conversation = await self._start_draft(
                draft, workshops_directory, model, effort, kind
            )

            self._conversations[key] = conversation

        self._start_reaper()

        return conversation

    async def create(self, conversation: Conversation) -> tuple[Conversation, str]:
        """Create the workshop or course a draft agreed on, and hand its
        conversation on.

        A workshop is scaffolded empty under `personal/workshops/` with the
        plan's name and title; a course is scaffolded whole under
        `personal/courses/`, as `jupyter workshop course init` writes it.
        Either starts as a git repository, with nothing committed, and its
        conversation starts with what was said in the draft. Returns that
        conversation and the brief to send it first; the draft is closed
        and its record removed.
        """

        if not conversation.draft:
            raise ConversationError("Only a draft creates a workshop or course")

        if conversation.running:
            raise ConversationError("Wait for the agent to finish before creating")

        proposal = conversation.proposal

        if proposal is None:
            raise ConversationError(
                "Nothing has been proposed yet: Workshop Author proposes a plan "
                "once it knows what to make"
            )

        from .scaffold import initialize_repository

        workshops_directory = conversation.workshops_directory
        library = library_directory(self._root, workshops_directory)

        if isinstance(proposal, CourseProposal):
            tree, state_dir = COURSES_DIRECTORY, COURSE_STATE_DIR
            directory = library / tree / proposal.name

            try:
                check_course_proposal(proposal, library / tree)
            except ProposalError as error:
                raise ConversationError(str(error)) from error

            _write_course(directory, proposal)

            text = course_brief(proposal)
        else:
            tree, state_dir = PERSONAL_WORKSHOPS_DIRECTORY, STATE_DIR
            directory = library / tree / proposal.name

            try:
                check_proposal(proposal, library / tree)
            except ProposalError as error:
                raise ConversationError(str(error)) from error

            _write_workshop(directory, proposal)

            text = brief(proposal)

        path = posixpath.normpath(
            posixpath.join(workshops_directory or ".", tree, proposal.name)
        )

        # The workshop or course is the person's own, so its history starts
        # with it; the agent commits only when told.
        initialize_repository(directory)

        # Files attached while drafting go with it, where the agent may
        # use them.
        carried = _move_attachments(
            conversation.directory, directory, STATE_DIR, state_dir
        )

        # The new conversation starts where the draft left off, so the
        # panel shows the whole exchange and the plan agreed in it.
        created = await self.open(
            path,
            workshops_directory,
            directory,
            conversation.model,
            conversation.effort,
        )

        created.history = [
            *conversation.history,
            {"kind": "note", "text": f"Created {path}."},
        ]
        created.save()

        await self.discard(conversation, announce=False)
        await conversation.announce(
            {"type": "created", "path": path, "kind": created.kind}
        )

        if carried:
            text += (
                "\n\nThe files attached while drafting are now under "
                f"{state_dir}/{ATTACHMENTS_DIR}/ here: " + ", ".join(carried) + "."
            )

        return created, text

    async def discard(self, conversation: Conversation, announce: bool = True) -> None:
        """End a draft and remove its record."""

        if not conversation.draft:
            raise ConversationError("Only a draft can be discarded")

        self._conversations.pop(conversation.path, None)

        await conversation.session.close()

        shutil.rmtree(conversation.directory, ignore_errors=True)

        if announce:
            await conversation.announce({"type": "closed"})

    async def moved(self, path: str, course_path: str, inside: str) -> None:
        """Hand a promoted workshop's conversation on to its course's.

        The workshop's conversation ends, since a course has one
        conversation for all of it, and whoever is watching is told where
        to carry on: the course's path, with the workshop's place in it.
        The record is not saved, since the directory has moved and the
        course keeps its own.
        """

        conversation = self._conversations.pop(path, None)

        if conversation is None:
            return

        await conversation.announce(
            {"type": "moved", "path": course_path, "kind": "course", "inside": inside}
        )
        await conversation.session.close()

    async def close(self, path: str) -> None:
        """End a workshop's conversation, keeping its record."""

        conversation = self._conversations.pop(path, None)

        if conversation is not None:
            conversation.save()

            await conversation.session.close()

    async def close_all(self) -> None:
        """End every conversation."""

        for path in list(self._conversations):
            await self.close(path)

        if self._reaper is not None:
            self._reaper.cancel()
            self._reaper = None

    async def close_idle(self) -> list[str]:
        """End the conversations nobody has watched for a while."""

        now = time.monotonic()
        idle = [
            path
            for path, conversation in self._conversations.items()
            if not conversation.listeners
            and not conversation.running
            and now - conversation.last_active > self._idle_timeout
        ]

        for path in idle:
            await self.close(path)

        return idle

    def _check(self, path: str, workshops_directory: str, directory: Path) -> str:
        # The library must exist, in this release's layout, the workshop or
        # course be its owner's, and nothing downloaded: the same rule that
        # trusts a workshop by location. Returns what the path is.
        if not is_library(self._root, workshops_directory):
            raise ConversationError("Workshop Author works only in a workshop library")

        self._check_upgraded(workshops_directory)

        if not is_own_library_path(workshops_directory, path):
            raise ConversationError(
                "Workshop Author works only on your own workshops, under "
                "personal/workshops/, and your courses, under personal/courses/"
            )

        # A course has one conversation, about the whole repository.
        course = course_of_path(workshops_directory, path)

        if course is not None:
            course_path, inner = course

            if inner:
                raise ConversationError(
                    "A workshop in a course is written in the course's "
                    f"conversation: open Workshop Author on {course_path}"
                )

            if not directory.is_dir():
                raise ConversationError(f"{path} is not a course")

            return "course"

        if not (directory / "workshop.yaml").is_file():
            raise ConversationError(f"{path} is not a workshop")

        if (directory / STATE_DIR / "source.json").is_file():
            raise ConversationError(
                f"{path} was downloaded from a collection, so it is not yours to edit"
            )

        return "workshop"

    def _check_upgraded(self, workshops_directory: str) -> None:
        # A library in the previous layout has no personal/workshops/
        # tree for the agent to write into; the upgrade makes one.
        try:
            library = read_library(self._root, workshops_directory)
        except LibraryError as error:
            raise ConversationError(str(error)) from error

        if library is not None and needs_upgrade(library):
            raise ConversationError(NEEDS_UPGRADE_MESSAGE)

    async def _start(
        self,
        path: str,
        workshops_directory: str,
        directory: Path,
        model: str,
        effort: str,
        kind: str,
    ) -> Conversation:
        from .agents.claude import sandbox_supported
        from .mcp import BridgeSession, create_server

        provider = self.provider
        state_dir = COURSE_STATE_DIR if kind == "course" else STATE_DIR
        record = _read_record(directory, state_dir)
        resume = (
            str(record.get("session_id") or "") or None
            if record.get("provider") == provider.name
            else None
        )
        # A choice made in this workshop's conversation outlasts the defaults.
        if "model" in record:
            model = str(record.get("model") or "")

        if "effort" in record:
            effort = str(record.get("effort") or "")

        library = library_directory(self._root, workshops_directory)
        loop = asyncio.get_running_loop()
        conversation_holder: list[Conversation] = []

        # The live tools reach the tab watching the conversation, through
        # the bridge in this process, whichever tab that is by then.
        def session_factory() -> BridgeSession | None:
            if self._bridge is None:
                return None

            client = conversation_holder[0].client if conversation_holder else ""

            return BridgeSession(self._bridge, loop, client or None)

        policy = PermissionPolicy(
            workshop=directory,
            readable=(self._skill,) if self._skill else (),
            forbidden=(library / INSTALLED_DIRECTORY,),
            sandboxed=provider.name == "claude" and sandbox_supported(),
        )
        options = StartOptions(
            directory=directory,
            policy=policy,
            instructions=course_instructions(path, directory)
            if kind == "course"
            else instructions(path, directory),
            tools=create_server(session_factory, base=directory),
            skill=self._skill,
            resume=resume,
            model=model,
            effort=effort,
        )

        session = await provider.start(options)
        conversation = Conversation(
            path=path,
            directory=directory,
            session=session,
            provider=provider.name,
            kind=kind,
            state_dir=state_dir,
            options=options,
            model=model,
            effort=effort,
            cost=float(record.get("cost") or 0.0) if resume else 0.0,
            history=list(record.get("history") or []) if resume else [],
            created=str(record.get("created") or _now()) if resume else _now(),
        )

        conversation_holder.append(conversation)

        return conversation

    async def _start_draft(
        self,
        draft: str,
        workshops_directory: str,
        model: str,
        effort: str,
        kind: str,
    ) -> Conversation:
        provider = self.provider
        directory = self.drafts_directory / draft

        directory.mkdir(parents=True, exist_ok=True)

        record = _read_record(directory)
        resume = (
            str(record.get("session_id") or "") or None
            if record.get("provider") == provider.name
            else None
        )

        if "model" in record:
            model = str(record.get("model") or "")

        if "effort" in record:
            effort = str(record.get("effort") or "")

        library = library_directory(self._root, workshops_directory)
        holder: list[Conversation] = []

        # A plan that passes the checks is kept for the Create button.
        def on_propose(proposal: Proposal | CourseProposal) -> None:
            if holder:
                holder[0].proposal = proposal
                holder[0].save()

        # The agent may read and research, and nothing else: its working
        # directory is the draft's own, empty but for the record.
        policy = PermissionPolicy(
            workshop=directory,
            readable=(self._skill,) if self._skill else (),
            forbidden=(library / INSTALLED_DIRECTORY,),
            read_only=True,
        )

        # A workshop is proposed for personal/workshops/, a course for
        # personal/courses/, each with the one tool that proposes it.
        tree = COURSES_DIRECTORY if kind == "course" else PERSONAL_WORKSHOPS_DIRECTORY
        target = posixpath.normpath(posixpath.join(workshops_directory or ".", tree))

        if kind == "course":
            tools = create_course_draft_server(library / tree, on_propose)
            told = course_draft_instructions(target)
        else:
            tools = create_draft_server(library / tree, on_propose)
            told = draft_instructions(target)

        options = StartOptions(
            directory=directory,
            policy=policy,
            instructions=told,
            tools=tools,
            skill=self._skill,
            resume=resume,
            model=model,
            effort=effort,
        )

        session = await provider.start(options)
        recorded = record.get("proposal") if resume else None
        proposal: Proposal | CourseProposal | None = None

        if isinstance(recorded, dict):
            proposal = (
                CourseProposal.from_dict(recorded)
                if kind == "course"
                else Proposal.from_dict(recorded)
            )

        conversation = Conversation(
            path=DRAFT_PREFIX + draft,
            directory=directory,
            session=session,
            provider=provider.name,
            kind=kind,
            options=options,
            model=model,
            effort=effort,
            cost=float(record.get("cost") or 0.0) if resume else 0.0,
            history=list(record.get("history") or []) if resume else [],
            created=str(record.get("created") or _now()) if resume else _now(),
            draft=draft,
            proposal=proposal,
            workshops_directory=workshops_directory,
        )

        holder.append(conversation)

        return conversation

    def _prune_drafts(self) -> None:
        # Drafts nobody came back to are removed after a while, so the data
        # directory does not fill with abandoned ideas.
        now = time.time()
        root = self.drafts_directory

        if not root.is_dir():
            return

        for entry in root.iterdir():
            key = DRAFT_PREFIX + entry.name

            try:
                old = now - entry.stat().st_mtime > DRAFT_LIFETIME
            except OSError:
                continue

            if entry.is_dir() and old and key not in self._conversations:
                shutil.rmtree(entry, ignore_errors=True)

    def terminal_command(self, conversation: Conversation) -> str | None:
        """The line to type in a terminal to carry a conversation on there."""

        session_id = conversation.session.session_id

        # A draft has no workshop to carry on in.
        if conversation.draft:
            return None

        if not session_id or conversation.options is None:
            return None

        parts = self.provider.terminal_command(session_id, conversation.options)

        return command_line(parts) if parts else None

    def login_command(self) -> str | None:
        """The line to type in a terminal to log the agent in."""

        parts = self.provider.login_command()

        return command_line(parts) if parts else None

    def _start_reaper(self) -> None:
        # A timer, not a task, so a server stopping with conversations open
        # leaves nothing pending behind it.
        if self._reaper is not None:
            return

        loop = asyncio.get_running_loop()
        interval = min(60.0, self._idle_timeout)

        def tick() -> None:
            self._reaper = None

            async def reap() -> None:
                await self.close_idle()

                if self._conversations:
                    self._start_reaper()

            task = asyncio.ensure_future(reap())

            _REAPING.add(task)
            task.add_done_callback(_REAPING.discard)

        self._reaper = loop.call_later(interval, tick)


def instructions(path: str, directory: Path) -> str:
    """What the agent is told about where it is and what it is for."""

    return f"""You are Workshop Author, running inside JupyterLab. You write and
revise one jupyterlab-workshop workshop: the directory {directory}, which
is your working directory. The person you work for is watching their
JupyterLab session in a browser while you work.

Before writing or changing workshop files, use the
jupyterlab-workshop:jupyterlab-workshop-authoring skill, and follow it.

The workshop tools are the mcp__workshop__ tools; use them, not the
jupyter workshop command in a shell, which the sandbox may stop. Paths you
give the file tools (lint, render, pages, publish, draft) are relative to
the workshop directory, so "." is this workshop. The live tools act in the person's own
browser tab: open_workshop with the path "{path}" opens this workshop there
in author mode, and run_page, run_workshop and reset_workshop then run it.

A version of the workshop is ready to show when lint reports no errors and
run_workshop at the fast pace passes. Do not say it is ready otherwise;
say what failed and fix it. Once it is ready, say so, and the person can
open it. Run the self-test tool, test, only when the person asks for it.

The workshop is a git repository. Follow the skill's "Git and GitHub"
section: commit only when the person tells you to, never add a
Co-Authored-By line or any other trailer naming an agent, and before the
first commit check git config user.name and user.email, asking the
person for them and setting them with git config --local when either is
unset. Before a commit, run check_gitignore with the directory ".": if
it reports missing entries, say what the commit would take in that it
should not, and offer to add them, with fix, before committing. Never
push or publish unasked; when a version is ready, you may say once that
you can publish it when asked.

When the person asks to publish or share the workshop as a gist, make
sure it is ready first, then use publish_gist with the directory ".".
It updates the gist the workshop was published to before, recorded in
_workshop/gist.json, or creates a secret one; pass create only to make
a new gist, and public only when the person asks for a public one. When
they ask to publish it to GitHub as a repository, or to push, use
publish_github with the directory ".": it creates a private repository
and pushes, or pushes to the one the workshop already has, and public
only when they ask for a public one. Either way the person is asked to
confirm. Give them the URL.

The person can attach files to a message: a screenshot, a diagram, a
PDF, notes, a data file. Each is saved under {STATE_DIR}/{ATTACHMENTS_DIR}/
in the workshop, and the message says where. An image is shown to you
in the message as well; read a PDF from its file. When the person wants
a file itself to be part of the workshop, an image to show on a page or
data a page's actions use, copy it into a directory of the workshop's
own, such as images/, and refer to it there; never refer to it where it
was saved, since {STATE_DIR}/ is the workshop's state and not part of it.

Stay inside the workshop directory. Anything outside it asks the person
first; workshops downloaded into the library are never yours to read or
change."""


def course_instructions(path: str, directory: Path) -> str:
    """What the agent is told when its conversation is about a course."""

    return f"""You are Workshop Author, running inside JupyterLab. You design and
write one course of jupyterlab-workshop workshops: the repository
{directory}, which is your working directory. A course is one or more
collections, each a part of the course with an index of its own under
collections/<name>/collection.json, and every workshop of every
collection is a directory under workshops/. The person you work for is
watching their JupyterLab session in a browser while you work.

Read AGENTS.md and OUTLINE.md in the repository first, and follow them.
AGENTS.md holds the conventions of this repository; OUTLINE.md is the
design of the course, written before its workshops are, with one entry
per workshop and a status table, and it is kept true as the work goes.
While OUTLINE.md still has its skeleton, settle the design with the
person before writing any workshop. Use the
jupyterlab-workshop:jupyterlab-workshop-authoring skill and follow it:
its "Designing a course" section for the outline, the naming and
numbering and how a course is kept true, and the rest for writing the
workshops themselves.

The workshop tools are the mcp__workshop__ tools; use them, not the
jupyter workshop or just commands in a shell, which the sandbox may stop.
Paths you give the file tools are relative to the course directory, so a
workshop is "workshops/<name>". init scaffolds a new workshop there;
lint, render, pages and test take it. index writes a collection's
index: give it the workshop directories in the collection's order, out
"collections/<name>/collection.json", ordered true, and repo as the
Justfile's repo variable gives it, which is a placeholder until the
course has a repository on GitHub; the stub's id and title are kept.
catalog refreshes catalog.json with path "catalog.json" and relative
true. The Justfile's index-<name> recipe lists each collection's
workshops in order; keep it in step when a workshop is added or moved.
The live tools act in the person's own browser tab: open_workshop with
the path "{path}/workshops/<name>" opens a workshop there in author
mode, and run_page, run_workshop and reset_workshop then run it.

A version of a workshop is ready to show when lint reports no errors and
run_workshop at the fast pace passes. Do not say it is ready otherwise;
say what failed and fix it. Once it is ready, say so, update its row in
the status table of OUTLINE.md and its entry in the README, and refresh
the index. Run the self-test tool, test, only when the person asks.

The repository is under git. Follow the skill's "Git and GitHub"
section: commit only when the person tells you to, with a message that
says what changed and why, and never add a Co-Authored-By line or any
other trailer naming an agent. Before the first commit, check git config
user.name and user.email; if either is unset, ask the person for them
and set them with git config --local in this repository, never globally
unless they say so. Before a commit, run check_gitignore with the
directory ".": a repository brought in from elsewhere may not ignore
what a course should, and if it reports missing entries, say what the
commit would take in that it should not, and offer to add them, with
fix, before committing. Never push, add a remote or publish anything
unless asked; when a version is ready, you may say once that you can
publish when asked. When the person asks to publish the course to GitHub, or to
push, use publish_github with the directory ".": it creates a private
repository and pushes, or pushes to the one the course already has, and
public only when they ask for a public one; it refuses an uncommitted
tree, so ask to commit first. After the repository is created it
rewrites the generated files that named a placeholder address, which
then need committing and pushing. The person is asked to confirm. Give
them the URL and pass on its notes, such as the GitHub Pages setting a
JupyterLite site needs.

The person can attach files to a message: a screenshot, a diagram, a
PDF, notes, a data file. Each is saved under {COURSE_STATE_DIR}/{ATTACHMENTS_DIR}/
in the course, and the message says where. An image is shown to you in
the message as well; read a PDF from its file. When the person wants a
file itself to be part of a workshop, copy it into that workshop's own
directory and refer to it there; never refer to it where it was saved,
since {COURSE_STATE_DIR}/ is the conversation's state and not part of the course.

Stay inside the course directory. Anything outside it asks the person
first; workshops downloaded into the library are never yours to read or
change."""


def command_line(parts: list[str]) -> str:
    """A command quoted for the shell a terminal on this server runs."""

    if sys.platform == "win32":
        return subprocess.list2cmdline(parts)

    return shlex.join(parts)


def _write_workshop(directory: Path, proposal: Proposal) -> None:
    # An empty workshop with the plan's name and title, for the agent to
    # write from the brief.
    from .scaffold import write_scaffold

    write_scaffold(
        directory,
        proposal.name,
        proposal.title,
        ci=False,
        template="blank",
        gating="soft" if proposal.gating else "off",
    )


def _write_course(directory: Path, proposal: CourseProposal) -> None:
    # The whole repository as the command line scaffolds it, pinned to
    # this release, with no repository URL yet.
    from .course import CourseError, write_course

    try:
        write_course(directory, proposal.options())
    except CourseError as error:
        raise ConversationError(str(error)) from error


def _move_attachments(
    source: Path, target: Path, source_state: str, target_state: str
) -> list[str]:
    # The files attached in one conversation's directory move to another's,
    # by name; the names moved are returned.
    origin = attachments_directory(source, source_state)

    if not origin.is_dir():
        return []

    destination = attachments_directory(target, target_state)
    moved: list[str] = []

    destination.mkdir(parents=True, exist_ok=True)

    for entry in sorted(origin.iterdir()):
        if entry.is_file():
            shutil.move(str(entry), str(destination / entry.name))
            moved.append(entry.name)

    return moved


def _read_record(directory: Path, state_dir: str = STATE_DIR) -> dict[str, Any]:
    try:
        data = json.loads(
            (directory / state_dir / AGENT_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return {}

    return data if isinstance(data, dict) else {}


def _shortened(event: dict[str, Any]) -> dict[str, Any]:
    # A tool call's input can hold a whole file; the history keeps enough
    # to show what was done.
    value = event.get("input")

    if not isinstance(value, dict):
        return event

    text = json.dumps(value)

    if len(text) <= INPUT_LIMIT:
        return event

    return {**event, "input": {"truncated": text[:INPUT_LIMIT] + "…"}}


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
