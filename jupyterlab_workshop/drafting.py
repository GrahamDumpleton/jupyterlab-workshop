"""Drafting a new workshop with the agent before anything is created.

Create Workshop with AI starts a conversation about a workshop that does
not exist yet. The agent works out what it should teach, who it is for
and what it is for, asking whatever it needs to, and then proposes a
plan with the one tool it has, `propose_workshop`. The panel shows the
plan with a Create button. Only when the person presses it does the
server make the workshop under the library's `personal/` tree, and the
conversation carries on there with the plan as the agent's brief.

Nothing is written while drafting: the agent's policy is read-only, and
the draft's record lives in the server's data directory, not in the
library, so a request that goes nowhere leaves nothing behind.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from mcp.server.mcpserver import MCPServer

# The audiences a plan is written for, as the authoring skill names them.
Audience = Literal["newcomers", "experienced", "demonstration"]

AUDIENCES: dict[str, str] = {
    "newcomers": "people new to the subject",
    "experienced": "experienced practitioners",
    "demonstration": "a product demonstration or presentation",
}

# What a workshop directory may be called: the scaffold's own rule.
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$")

# What a draft is called on disk and over the socket.
DRAFT_PATTERN = re.compile(r"^[a-f0-9-]{8,64}$")


class ProposalError(ValueError):
    """A plan that cannot be created as it stands."""


@dataclass(frozen=True)
class Proposal:
    """The workshop the agent proposes, as the person will see it."""

    title: str
    name: str
    audience: str
    summary: str
    outline: tuple[str, ...]
    quizzes: bool
    gating: bool

    def to_dict(self) -> dict[str, Any]:
        """The plan as it is recorded and sent."""

        data = asdict(self)
        data["outline"] = list(self.outline)

        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Proposal:
        """A plan read back from a record."""

        return cls(
            title=str(data.get("title") or ""),
            name=str(data.get("name") or ""),
            audience=str(data.get("audience") or ""),
            summary=str(data.get("summary") or ""),
            outline=tuple(str(item) for item in data.get("outline") or ()),
            quizzes=bool(data.get("quizzes")),
            gating=bool(data.get("gating")),
        )


def check_proposal(proposal: Proposal, personal: Path) -> None:
    """Refuse a plan that could not be created under `personal`."""

    if not proposal.title.strip():
        raise ProposalError("The plan needs a title.")

    if not NAME_PATTERN.match(proposal.name):
        raise ProposalError(
            f'"{proposal.name}" cannot be a directory name: use lower case '
            "letters, digits and hyphens, at most 64 characters, starting "
            "and ending with a letter or digit."
        )

    if (personal / proposal.name).exists():
        raise ProposalError(
            f"personal/{proposal.name} already exists; propose another name."
        )

    if proposal.audience not in AUDIENCES:
        raise ProposalError(
            "The audience is one of: " + ", ".join(sorted(AUDIENCES)) + "."
        )

    if not proposal.summary.strip():
        raise ProposalError("The plan needs a summary of what it teaches.")

    if not [item for item in proposal.outline if item.strip()]:
        raise ProposalError("The plan needs an outline, one line per page.")


def create_draft_server(
    personal: Path, on_propose: Callable[[Proposal], None]
) -> MCPServer:
    """The tools a drafting agent has: only `propose_workshop`.

    A plan that passes the checks is handed to `on_propose`, which keeps
    it for the Create button; one that does not is an error the agent
    reads and can correct.
    """

    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError

    server = MCPServer("workshop")

    @server.tool()
    def propose_workshop(
        title: str,
        name: str,
        audience: Audience,
        summary: str,
        outline: list[str],
        quizzes: bool,
        gating: bool,
    ) -> str:
        """Propose the new workshop, for the person to create or change.

        The person sees the plan with a Create button; nothing is created
        until they press it. Call it only once you know what the workshop
        teaches, who it is for and what it is for; call it again with a
        changed plan when they ask for changes.

        title: the workshop's title. name: its directory under personal/,
        lower case letters, digits and hyphens. audience: newcomers,
        experienced or demonstration. summary: two or three sentences on
        what it teaches and to whom. outline: one line per page, in order.
        quizzes and gating: whether it will have quizzes, and whether
        pages wait for their checks before the next opens.
        """

        proposal = Proposal(
            title=title.strip(),
            name=name.strip(),
            audience=audience,
            summary=summary.strip(),
            outline=tuple(item.strip() for item in outline if item.strip()),
            quizzes=quizzes,
            gating=gating,
        )

        # A ToolError's message reaches the agent, so it can correct the
        # plan; any other exception would reach it only as a failure.
        try:
            check_proposal(proposal, personal)
        except ProposalError as error:
            raise ToolError(str(error)) from error

        on_propose(proposal)

        return (
            "Proposed. The person sees the plan with a Create button. Do not "
            "repeat the plan; say in a sentence what you would like them to "
            "check, then wait for them to create it or ask for changes."
        )

    return server


def draft_instructions(personal: str) -> str:
    """What the agent is told while a workshop is being drafted."""

    return f"""You are Workshop Author, running inside JupyterLab. The person you
work for wants a new jupyterlab-workshop workshop. Nothing has been
created yet: your job now is to agree with them what to make, not to
make it. You cannot write files or run commands until they have agreed.

Before proposing anything, read the "Who it is for" section of the
jupyterlab-workshop:jupyterlab-workshop-authoring skill. Then make sure
you know three things: what the workshop teaches, who it is for
(newcomers to the subject, experienced practitioners, or a product
demonstration or presentation), and what it is for. Take them from what
the person has said where you can. Where you cannot, ask: a few short
questions at a time, not a questionnaire. If what they wrote does not
say what workshop they want, say so plainly and ask; never guess a
topic. You may search and read the web to understand the subject. The
person may attach files to a message, such as notes, a slide deck as a
PDF or a diagram; each is saved in your working directory, where you
may read it, and goes with the workshop once it is created.

When you know enough, call the propose_workshop tool with the plan: a
title, a directory name, the audience, a short summary, an outline of
four to eight pages, and whether it has quizzes and gating, chosen for
the audience. The workshop will be created under {personal}/ with that
name. The person then presses Create, or asks for changes, in which case
propose again. Keep your replies short; the plan speaks for itself."""


def brief(proposal: Proposal) -> str:
    """The first message of the created workshop's conversation."""

    outline = "\n".join(
        f"{number}. {item}" for number, item in enumerate(proposal.outline, 1)
    )
    checks: list[str] = []

    checks.append("with quizzes" if proposal.quizzes else "without quizzes")
    checks.append("with gating" if proposal.gating else "without gating")

    opening = (
        "Write the workshop we agreed, in the current directory, which has "
        "been scaffolded empty for it."
    )

    return f"""{opening}

Title: {proposal.title}
For: {AUDIENCES.get(proposal.audience, proposal.audience)}, {" and ".join(checks)}

{proposal.summary}

Pages:
{outline}"""
