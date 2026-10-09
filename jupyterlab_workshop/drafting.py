"""Drafting a new workshop with the agent before anything is created.

Create Workshop with AI starts a conversation about a workshop that does
not exist yet. The agent works out what it should teach, who it is for
and what it is for, asking whatever it needs to, and then proposes a
plan with the one tool it has, `propose_workshop`. The panel shows the
plan with a Create button. Only when the person presses it does the
server make the workshop under the library's `personal/workshops/` tree,
and the conversation carries on there with the plan as the agent's brief.

Nothing is written while drafting: the agent's policy is read-only, and
the draft's record lives in the server's data directory, not in the
library, so a request that goes nowhere leaves nothing behind.

Create Course with AI drafts the same way, with `propose_course` in
place of `propose_workshop`: the plan is the course's title, name,
description and collections, and Create scaffolds the whole repository
under `personal/courses/` with the same code as `jupyter workshop course
init`, so the agent never writes the repository's own files by hand.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from .course import CollectionSpec, CourseError, CourseOptions, check_options

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
            f"personal/workshops/{proposal.name} already exists; propose another name."
        )

    if proposal.audience not in AUDIENCES:
        raise ProposalError(
            "The audience is one of: " + ", ".join(sorted(AUDIENCES)) + "."
        )

    if not proposal.summary.strip():
        raise ProposalError("The plan needs a summary of what it teaches.")

    if not [item for item in proposal.outline if item.strip()]:
        raise ProposalError("The plan needs an outline, one line per page.")


@dataclass(frozen=True)
class CourseProposal:
    """The course the agent proposes, as the person will see it."""

    title: str
    name: str
    description: str
    collections: tuple[CollectionSpec, ...]

    # The prefix of the collection ids; the course's name when empty.
    id_prefix: str = ""

    # Whether the course is written for JupyterLite as well.
    lite: bool = False

    def to_dict(self) -> dict[str, Any]:
        """The plan as it is recorded and sent."""

        return {
            "title": self.title,
            "name": self.name,
            "description": self.description,
            "collections": [asdict(item) for item in self.collections],
            "id_prefix": self.id_prefix,
            "lite": self.lite,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CourseProposal:
        """A plan read back from a record."""

        return cls(
            title=str(data.get("title") or ""),
            name=str(data.get("name") or ""),
            description=str(data.get("description") or ""),
            collections=_collections(data.get("collections")),
            id_prefix=str(data.get("id_prefix") or ""),
            lite=bool(data.get("lite")),
        )

    def options(self) -> CourseOptions:
        """What the scaffold writes the course from."""

        return CourseOptions(
            name=self.name,
            title=self.title,
            description=self.description,
            collections=self.collections,
            id_prefix=self.id_prefix or self.name,
            lite=self.lite,
        )


def check_course_proposal(proposal: CourseProposal, courses: Path) -> None:
    """Refuse a course plan that could not be created under `courses`."""

    if not proposal.title.strip():
        raise ProposalError("The plan needs a title.")

    if not proposal.description.strip():
        raise ProposalError("The plan needs a description of what the course teaches.")

    for collection in proposal.collections:
        if not collection.title.strip():
            raise ProposalError(f"The collection {collection.name} needs a title.")

    # The scaffold's own rules on names and the id prefix apply.
    try:
        check_options(proposal.options())
    except CourseError as error:
        raise ProposalError(str(error)) from error

    if (courses / proposal.name).exists():
        raise ProposalError(
            f"personal/courses/{proposal.name} already exists; propose another name."
        )


def _collections(value: object) -> tuple[CollectionSpec, ...]:
    # The collections as the tool or a record gives them: a list of
    # mappings with a name, a title and perhaps a description.
    if not isinstance(value, list):
        return ()

    return tuple(
        CollectionSpec(
            name=str(item.get("name") or "").strip(),
            title=str(item.get("title") or "").strip(),
            description=str(item.get("description") or "").strip(),
        )
        for item in value
        if isinstance(item, dict)
    )


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

        title: the workshop's title. name: its directory under
        personal/workshops/, lower case letters, digits and hyphens.
        audience: newcomers, experienced or demonstration. summary: two or
        three sentences on what it teaches and to whom. outline: one line
        per page, in order.
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


def create_course_draft_server(
    courses: Path, on_propose: Callable[[CourseProposal], None]
) -> MCPServer:
    """The tools a course-drafting agent has: only `propose_course`."""

    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError

    server = MCPServer("workshop")

    @server.tool()
    def propose_course(
        title: str,
        name: str,
        description: str,
        collections: list[dict[str, str]],
        id_prefix: str = "",
        lite: bool = False,
    ) -> str:
        """Propose the new course, for the person to create or change.

        The person sees the plan with a Create button; nothing is created
        until they press it. Call it only once you know what the course
        teaches, who it is for and how it divides into parts; call it
        again with a changed plan when they ask for changes.

        title: the course's title. name: its directory under
        personal/courses/, lower case letters, digits and hyphens.
        description: two or three sentences on what it teaches and to
        whom. collections: the parts of the course in order, one to a
        few, each a mapping with a name (lower case letters, digits and
        hyphens), a title and a description of a sentence or two; a
        course with one part has one collection. id_prefix: the prefix
        of the collection ids, a domain or forge account the person
        controls such as example.org or github.com/name, or empty for
        the course's name. lite: whether the workshops will also run as
        a JupyterLite site in the browser, which rules out terminals.
        """

        proposal = CourseProposal(
            title=title.strip(),
            name=name.strip(),
            description=description.strip(),
            collections=_collections(collections),
            id_prefix=id_prefix.strip(),
            lite=lite,
        )

        try:
            check_course_proposal(proposal, courses)
        except ProposalError as error:
            raise ToolError(str(error)) from error

        on_propose(proposal)

        return (
            "Proposed. The person sees the plan with a Create button. Do not "
            "repeat the plan; say in a sentence what you would like them to "
            "check, then wait for them to create it or ask for changes."
        )

    return server


def course_draft_instructions(courses: str) -> str:
    """What the agent is told while a course is being drafted."""

    return f"""You are Workshop Author, running inside JupyterLab. The person you
work for wants a new course: a repository of jupyterlab-workshop
workshops, organised as one or more collections, each a part of the
course with an index of its own, published together. Nothing has been
created yet: your job now is to agree with them what to make, not to
make it. You cannot write files or run commands until they have agreed.

Before proposing anything, read the "Who it is for" and "Several
workshops in one repository" sections of the
jupyterlab-workshop:jupyterlab-workshop-authoring skill. Then make sure
you know: what the course teaches and to whom, how
it divides into parts (one part is fine for a short course), whether the
workshops must also run as a JupyterLite site in the browser, and what
prefix the collection ids should carry, a domain or forge account the
person controls, such as github.com/<account>, since an id is permanent.
Take these from what the person has said where you can. Where you
cannot, ask: a few short questions at a time, not a questionnaire. If
what they wrote does not say what course they want, say so plainly and
ask; never guess a subject. You may search and read the web to
understand the subject. The person may attach files to a message, such
as notes or an existing syllabus; each is saved in your working
directory, where you may read it, and goes with the course once it is
created.

When you know enough, call the propose_course tool with the plan: a
title, a directory name, a description, the collections in order with a
name, a title and a description each, the id prefix, and whether it is
for JupyterLite too. The course will be created under {courses}/ with
that name, as a git repository with the design document, the indexes,
the launch configuration and the tooling in place and no workshops yet;
designing the workshops in OUTLINE.md comes after, in the course's own
conversation. The person then presses Create, or asks for changes, in
which case propose again. Keep your replies short; the plan speaks for
itself."""


def course_brief(proposal: CourseProposal) -> str:
    """The first message of the created course's conversation."""

    parts = "\n".join(
        f"{number}. {item.title} ({item.name})"
        + (f": {item.description}" if item.description else "")
        for number, item in enumerate(proposal.collections, 1)
    )
    frontends = "JupyterLab and JupyterLite" if proposal.lite else "JupyterLab only"

    return f"""Design the course we agreed. The current directory has been
scaffolded for it: read AGENTS.md and OUTLINE.md first. OUTLINE.md holds
the skeleton of the design; fill it in with me before any workshop is
written, starting with what the course is, its source material, and the
workshops of the first part, one entry each. Write nothing under
workshops/ until the outline of a part is settled.

Title: {proposal.title}
For: {frontends}

{proposal.description}

Parts:
{parts}"""


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
