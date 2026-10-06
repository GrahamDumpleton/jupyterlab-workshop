"""What every agent provider offers, independent of the agent behind it.

A provider runs a conversation with an AI agent in a workshop directory.
The panel and the server extension only see the types here: a status
report, the options a conversation starts with, the session it returns,
and the events a session streams. A provider translates its own agent's
messages into these events, so another agent can be added without
changing anything that talks to the panel.

Nothing here imports an optional dependency.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Protocol

if TYPE_CHECKING:
    from mcp.server.mcpserver import MCPServer

    from .policy import PermissionPolicy


@dataclass(frozen=True)
class AgentStatus:
    """Whether a provider can run, and with which credentials."""

    provider: str
    available: bool
    install_hint: str = ""
    logged_in: bool = False
    auth_method: str = ""
    plan: str = ""
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        """The status as the setup endpoint reports it."""

        data = asdict(self)
        data["warnings"] = list(self.warnings)

        return data


@dataclass(frozen=True)
class StartOptions:
    """What a conversation starts with."""

    # The workshop directory the agent works in, as an absolute path.
    directory: Path

    # Which files the agent may read or change without asking.
    policy: PermissionPolicy

    # Instructions added to the agent's own, saying what it is doing here.
    instructions: str = ""

    # The workshop tools, served to the agent in-process.
    tools: MCPServer | None = None

    # The authoring skill's directory, from the installed package.
    skill: Path | None = None

    # A session to resume, from the workshop's agent.json.
    resume: str | None = None

    # The model to use; empty for the provider's default.
    model: str = ""

    # How much effort the agent puts in; empty for its default.
    effort: str = ""


@dataclass(frozen=True)
class ModelChoice:
    """A model the person can choose."""

    # What to ask the agent for, such as "sonnet" or "default".
    value: str

    # What to call it.
    name: str

    description: str = ""

    # The effort levels it takes, empty when it takes none.
    efforts: tuple[str, ...] = ()


@dataclass(frozen=True)
class AgentInfo:
    """What a conversation runs on, for the panel's status bar."""

    # The model asked for, one of the choices' values; empty for the default.
    model: str = ""

    # The model actually answering.
    resolved: str = ""

    # The effort asked for; empty for the default.
    effort: str = ""

    models: tuple[ModelChoice, ...] = ()

    # Tokens in the context window, and the window's size, when known.
    context_used: int | None = None
    context_limit: int | None = None

    def to_dict(self) -> dict[str, Any]:
        """The information as the panel receives it."""

        data = asdict(self)
        data["models"] = [
            {**asdict(choice), "efforts": list(choice.efforts)}
            for choice in self.models
        ]

        return data


@dataclass(frozen=True)
class AgentEvent:
    """Something a session reports while it works."""

    kind: ClassVar[str] = ""

    def to_dict(self) -> dict[str, Any]:
        """The event as the panel receives it."""

        return {"kind": self.kind, **asdict(self)}


@dataclass(frozen=True)
class TextDelta(AgentEvent):
    """A piece of the reply as it streams in."""

    kind: ClassVar[str] = "text-delta"

    text: str


@dataclass(frozen=True)
class Text(AgentEvent):
    """A complete block of the reply, replacing the deltas before it."""

    kind: ClassVar[str] = "text"

    text: str


@dataclass(frozen=True)
class ToolCall(AgentEvent):
    """The agent calling a tool."""

    kind: ClassVar[str] = "tool-call"

    id: str
    name: str
    input: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolResult(AgentEvent):
    """What a tool call returned, shortened for display."""

    kind: ClassVar[str] = "tool-result"

    id: str
    ok: bool
    summary: str = ""


@dataclass(frozen=True)
class PermissionRequest(AgentEvent):
    """The agent asking to use a tool the policy does not allow by itself.

    The session waits until `AgentSession.answer` is called with the id.
    """

    kind: ClassVar[str] = "permission"

    id: str
    tool: str
    input: dict[str, Any] = field(default_factory=dict)
    reason: str = ""

    # Whether Always allow is offered, to cover later calls like this one.
    rememberable: bool = True


@dataclass(frozen=True)
class Question(AgentEvent):
    """The agent asking the person to choose, one or more questions at once.

    Each question has `question`, a short `header`, `options` of `label`
    and `description`, and `multiSelect`. The session waits until
    `AgentSession.answer_question` is called with the id.
    """

    kind: ClassVar[str] = "question"

    id: str
    questions: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class PermissionWithdrawn(AgentEvent):
    """A permission request the agent no longer waits on, unanswered.

    Claude Code gives up on a request when the command behind it is
    stopped, such as by its own time limit, and the agent carries on
    without it.
    """

    kind: ClassVar[str] = "permission-withdrawn"

    id: str


@dataclass(frozen=True)
class Compacting(AgentEvent):
    """The agent has begun summarizing the conversation to free context."""

    kind: ClassVar[str] = "compacting"


@dataclass(frozen=True)
class Compacted(AgentEvent):
    """The conversation so far was replaced by a summary of it."""

    kind: ClassVar[str] = "compacted"

    # "manual" when asked for, "auto" when the context window was filling.
    trigger: str = "manual"

    # Tokens in the context window before and after, when known.
    tokens_before: int | None = None
    tokens_after: int | None = None


@dataclass(frozen=True)
class Done(AgentEvent):
    """The end of a turn: the agent has replied, or was stopped."""

    kind: ClassVar[str] = "done"

    session_id: str | None
    interrupted: bool = False
    turns: int = 0

    # What the turn cost in US dollars, where the provider says; only
    # meaningful on a paid API account.
    cost: float | None = None


@dataclass(frozen=True)
class Error(AgentEvent):
    """A failure that ended the turn, followed by `Done`."""

    kind: ClassVar[str] = "error"

    message: str


class AgentSession(Protocol):
    """One conversation with an agent."""

    @property
    def session_id(self) -> str | None:
        """The id to resume the conversation by, once the agent has one."""

    def send(self, text: str) -> AsyncIterator[AgentEvent]:
        """Send a message and stream what the agent does.

        Every turn ends with `Done`, after an `Error` when it failed.
        """

    def answer(self, permission_id: str, allow: bool, remember: bool = False) -> bool:
        """Answer a permission request; False when it is unknown or answered.

        With remember set, the same request is allowed for the rest of the
        conversation without asking again.
        """

    def answer_question(self, question_id: str, answers: dict[str, str] | None) -> bool:
        """Answer the agent's questions, by question text; None declines.

        False when the id is unknown or already answered.
        """

    def compact(self) -> AsyncIterator[AgentEvent]:
        """Summarize the conversation so far, to free the context window.

        A turn like any other, reporting `Compacting` and `Compacted` and
        ending with `Done`.
        """

    async def interrupt(self) -> None:
        """Stop the turn in progress."""

    async def info(self) -> AgentInfo:
        """What the conversation runs on: the model, the choices, the context."""

    async def set_model(self, model: str) -> None:
        """Answer with another model from the next message on."""

    async def close(self) -> None:
        """End the conversation and release what it holds."""


class AgentProvider(Protocol):
    """An agent that conversations can be held with."""

    name: str

    def available(self) -> bool:
        """Whether the provider's dependencies are installed."""

    async def status(self) -> AgentStatus:
        """Whether the provider can run here, and with which credentials."""

    async def start(self, options: StartOptions) -> AgentSession:
        """Start a conversation, or resume one."""

    def login_command(self) -> list[str] | None:
        """The command a person runs in a terminal to log the agent in."""

    def terminal_command(
        self, session_id: str, options: StartOptions
    ) -> list[str] | None:
        """The command that carries a conversation on in a terminal.

        Run in the workshop directory; None when the agent has no
        terminal form.
        """
