"""A provider that needs no model, for tests.

It answers each message by rule, so a test can drive every kind of event
the panel handles without credentials or network:

- A plain message is echoed back, streamed a word at a time.

- `/ask` asks permission to run a Bash command and says what it was told.

- `/question` asks two questions, one choice and one of several, and
  says what was answered.

- `/drop` asks permission, then stops waiting for the answer, as Claude
  Code does when the command behind a request times out.
  `/ask TOOL {json}` asks about any tool as the policy would, without
  then using it.

- `/tool NAME {json}` calls a workshop tool and reports the call and
  its result.

- `/slow` streams a long reply slowly, to be interrupted.

- `/fail` ends the turn with an error.

- `/compact` compacts the conversation, as the button does.

Several can be given on separate lines and run in order. A message with
files attached is answered first with what was attached and where each
was saved.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import AsyncIterator, Sequence
from typing import Any

from ..attachments import Attachment
from .base import (
    AgentEvent,
    AgentInfo,
    AgentStatus,
    Compacted,
    Compacting,
    Done,
    Error,
    ModelChoice,
    PermissionRequest,
    PermissionWithdrawn,
    Question,
    StartOptions,
    Text,
    TextDelta,
    ToolCall,
    ToolResult,
)

# The questions the fake agent asks for `/question`.
FAKE_QUESTIONS: list[dict[str, Any]] = [
    {
        "question": "Who is the workshop for?",
        "header": "Audience",
        "multiSelect": False,
        "options": [
            {"label": "Newcomers", "description": "New to the subject"},
            {"label": "Experienced", "description": "Know the basics already"},
        ],
    },
    {
        "question": "Which topics should it cover?",
        "header": "Topics",
        "multiSelect": True,
        "options": [
            {"label": "Routing", "description": ""},
            {"label": "Templates", "description": ""},
            {"label": "Testing", "description": ""},
        ],
    },
]

# The models the fake agent pretends to offer.
FAKE_MODELS: tuple[ModelChoice, ...] = (
    ModelChoice("default", "Default", "Whatever the fake agent likes"),
    ModelChoice("quick", "Quick", "Answers at once", ()),
    ModelChoice("careful", "Careful", "Thinks first", ("low", "medium", "high")),
)


class FakeSession:
    """A conversation with the fake agent."""

    def __init__(self, options: StartOptions) -> None:
        self._options = options
        self._session_id = options.resume or f"fake-{secrets.token_hex(4)}"
        self._answers: dict[str, asyncio.Future[bool]] = {}
        self._questions: dict[str, asyncio.Future[dict[str, str] | None]] = {}
        self._interrupted = asyncio.Event()
        self._model = options.model
        self.closed = False
        self.received: list[str] = []
        self.attached: list[Attachment] = []

    @property
    def session_id(self) -> str | None:
        """The id the conversation resumes by."""

        return self._session_id

    async def send(
        self, text: str, attachments: Sequence[Attachment] = ()
    ) -> AsyncIterator[AgentEvent]:
        """Answer each line of the message by its rule."""

        self.received.append(text)
        self.attached.extend(attachments)
        self._interrupted.clear()

        if attachments:
            yield Text(
                "Attached: "
                + "; ".join(
                    f"{item.name} ({item.media_type}, {item.size} bytes) at {item.path}"
                    for item in attachments
                )
            )

        lines = [line for line in text.strip().splitlines() if line.strip()]

        for line in lines or ([] if attachments else [""]):
            async for event in self._line(line.strip()):
                yield event

                if self._interrupted.is_set():
                    yield Done(self._session_id, interrupted=True)

                    return

                if isinstance(event, Error):
                    yield Done(self._session_id)

                    return

        yield Done(self._session_id, turns=1)

    def compact(self) -> AsyncIterator[AgentEvent]:
        """Pretend to summarize the conversation."""

        return self.send("/compact")

    def answer(self, permission_id: str, allow: bool, remember: bool = False) -> bool:
        """Answer the permission request the session is waiting on."""

        future = self._answers.get(permission_id)

        if future is None or future.done():
            return False

        future.set_result(allow)

        return True

    def answer_question(self, question_id: str, answers: dict[str, str] | None) -> bool:
        """Answer the questions the session is waiting on."""

        future = self._questions.get(question_id)

        if future is None or future.done():
            return False

        future.set_result(answers)

        return True

    async def interrupt(self) -> None:
        """Stop the reply in progress."""

        self._interrupted.set()

    async def info(self) -> AgentInfo:
        """The pretend model, and a context as long as what was said."""

        return AgentInfo(
            model=self._model,
            resolved=self._model or "default",
            effort=self._options.effort,
            models=FAKE_MODELS,
            context_used=sum(len(text) for text in self.received),
            context_limit=10000,
        )

    async def set_model(self, model: str) -> None:
        """Pretend to switch."""

        self._model = model

    async def close(self) -> None:
        """End any turn in progress, as a real agent's process ending would."""

        self.closed = True
        self._interrupted.set()

    async def _line(self, line: str) -> AsyncIterator[AgentEvent]:
        if line == "/ask" or line.startswith("/ask "):
            tool, _, rest = line[len("/ask ") :].partition(" ")
            data: dict[str, Any] = json.loads(rest) if rest.strip() else {}
            decision = self._options.policy.decide(tool, data) if tool else None
            request = PermissionRequest(
                id=secrets.token_hex(4),
                tool=tool or "Bash",
                input=data if tool else {"command": "echo hello"},
                reason=decision.reason
                if decision
                else "Runs a command on this machine",
                rememberable=decision.rememberable if decision else True,
            )
            future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

            self._answers[request.id] = future

            yield request

            allowed = await future

            yield Text("Allowed." if allowed else "Denied.")

        elif line == "/question":
            question = Question(id=secrets.token_hex(4), questions=FAKE_QUESTIONS)
            pending: asyncio.Future[dict[str, str] | None] = (
                asyncio.get_running_loop().create_future()
            )

            self._questions[question.id] = pending

            yield question

            answers = await pending

            if answers is None:
                yield Text("No answer.")
            else:
                yield Text(
                    "; ".join(f"{key} {value}" for key, value in answers.items())
                )

        elif line == "/drop":
            request = PermissionRequest(
                id=secrets.token_hex(4),
                tool="SandboxNetworkAccess",
                input={"host": "pypi.org"},
                reason="Lets a command reach pypi.org over the network",
            )

            yield request

            await asyncio.sleep(1.0)

            yield PermissionWithdrawn(request.id)
            yield Text("Carried on without it.")

        elif line.startswith("/tool "):
            name, _, rest = line[len("/tool ") :].partition(" ")
            arguments: dict[str, Any] = json.loads(rest) if rest.strip() else {}
            call_id = secrets.token_hex(4)

            yield ToolCall(call_id, f"mcp__workshop__{name}", arguments)

            yield await self._call_tool(call_id, name, arguments)

        elif line == "/slow":
            for number in range(1, 200):
                yield TextDelta(f"{number} ")

                await asyncio.sleep(0.05)

        elif line == "/compact":
            before = sum(len(text) for text in self.received)

            yield Compacting()

            self.received = ["summary"]

            yield Compacted("manual", before, len("summary"))

        elif line == "/fail":
            yield Error("The fake agent was asked to fail")

        else:
            words = f"You said: {line}".split(" ")

            for word in words:
                yield TextDelta(word + " ")

            yield Text(" ".join(words))

    async def _call_tool(
        self, call_id: str, name: str, arguments: dict[str, Any]
    ) -> ToolResult:
        tools = self._options.tools

        if tools is None:
            return ToolResult(call_id, False, "No tools were given")

        try:
            result = await tools.call_tool(name, arguments)
        except Exception as error:
            return ToolResult(call_id, False, str(error))

        content = getattr(result, "content", []) or []
        text = "".join(getattr(block, "text", "") for block in content)

        return ToolResult(call_id, not getattr(result, "is_error", False), text)


class FakeProvider:
    """The fake agent, always available and always logged in."""

    name = "fake"

    def __init__(self) -> None:
        self.sessions: list[FakeSession] = []

    def available(self) -> bool:
        """Nothing to install."""

        return True

    async def status(self) -> AgentStatus:
        """Logged in, on a pretend plan."""

        return AgentStatus(
            provider=self.name,
            available=True,
            logged_in=True,
            auth_method="fake",
            plan="test",
        )

    async def start(self, options: StartOptions) -> FakeSession:
        """Start or resume a conversation."""

        session = FakeSession(options)

        self.sessions.append(session)

        return session

    def login_command(self) -> list[str] | None:
        """A command that only says it logged in."""

        return ["echo", "fake agent logged in"]

    def terminal_command(
        self, session_id: str, options: StartOptions
    ) -> list[str] | None:
        """A command that only names the conversation."""

        return ["echo", f"fake conversation {session_id}"]
