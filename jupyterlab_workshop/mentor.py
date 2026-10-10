"""The mentor: a conversation above the level of any one workshop.

Workshop Author writes one workshop or one course. The mentor is for
the person who learns from workshops: it reads their learning journal,
the ``journal/`` directory of their library, before every conversation,
greets a person it has not met with a few questions and writes what it
learns into the journal's profile, the one file it may write, and
offers what comes next, a workshop or a course made for them, which
hands over to Workshop Author with a brief. It has no shell and writes
nothing else; the history in the journal is the extension's, and the
mentor only reads it.

The tools here are the mentor's own small set, built as the drafting
tools are, so that it can do nothing Workshop Author does.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer

from .collection import CollectionError, list_installed, load_collection
from .journal import (
    JOURNAL_DIRECTORY,
    MANIFEST_FILE,
    Journal,
    read_history,
    read_profile,
    render_for_prompt,
    save_profile,
)
from .journal import progress as read_progress
from .library import LibraryError, read_library

#: The tool the mentor offers a workshop or a course with; the panel shows
#: its call as a card with a Create button.
OFFER_TOOL = "offer_workshop"

#: The longest profile the mentor may write, in characters: about a page.
PROFILE_LIMIT = 6000

Kind = Literal["workshop", "course"]


def create_mentor_server(
    journal: Journal, root_dir: Path, workshops_directory: str
) -> MCPServer:
    """The mentor's tools: the journal, the profile, the library, an offer."""

    from mcp.server.mcpserver.exceptions import ToolError

    server = MCPServer("workshop")

    @server.tool()
    def read_journal(full: bool = False) -> Any:
        """The person's learning journal: their profile, when one has been
        written, and their history, what they installed, started, finished
        and made in this library.

        Without `full` the journal comes condensed, the most recently
        active workshops first; with `full` every history record comes
        whole, as JSON, with the profile as written.
        """

        if full:
            return {"profile": read_profile(journal), "history": read_history(journal)}

        return render_for_prompt(journal)

    @server.tool()
    def write_profile(text: str) -> str:
        """Write the person's profile, the whole file, as Markdown.

        The profile says who the person is as a learner, in concrete terms
        the authoring agent can use: what they want to learn and why, what
        they already know, the tools and languages they use, how much time
        they have, how deep and how fast they like to go, what they have
        tried before. Not a learner type. Keep it to a page; it goes into
        every prompt that uses it. Write it as the person said it, and let
        them read it back. It replaces what was there, so carry forward
        what still holds.
        """

        if not text.strip():
            raise ToolError("The profile cannot be empty; write what you know")

        if len(text) > PROFILE_LIMIT:
            raise ToolError(
                f"The profile is {len(text)} characters; keep it under "
                f"{PROFILE_LIMIT}, about a page, since it goes into every prompt"
            )

        save_profile(journal, text)

        return (
            f"Written to {JOURNAL_DIRECTORY}/profile.md. Tell the person it is "
            "there for them to read and change, as a Markdown link to it."
        )

    @server.tool()
    def list_library() -> Any:
        """What the library holds: the collections and catalogs it subscribes
        to, and every installed workshop and course with its progress, so a
        workshop already to hand can be pointed at before a new one is made.
        """

        try:
            registry = read_library(root_dir, workshops_directory) or {}
            records = list_installed(root_dir, workshops_directory, library=True)
        except (LibraryError, CollectionError) as error:
            return {"error": str(error)}

        return {
            "collections": registry.get("collections"),
            "catalogs": registry.get("catalogs"),
            "workshops": [
                {
                    key: record.get(key)
                    for key in (
                        "title",
                        "path",
                        "kind",
                        "version",
                        "pages",
                        "done",
                        "started",
                        "collection",
                    )
                }
                for record in records
            ],
        }

    @server.tool()
    def list_collection(location: str) -> Any:
        """Read a collection index from a URL or a local file: what it offers."""

        try:
            return load_collection(location, root_dir)
        except CollectionError as error:
            return {"error": str(error)}

    @server.tool()
    def offer_workshop(kind: Kind, title: str, brief: str) -> str:
        """Offer to have Workshop Author make a workshop, or a course, for the
        person.

        The person sees the offer as a card with a Create button; nothing
        is made until they press it, which opens Workshop Author with the
        brief as its first message. kind: workshop for one topic in a
        sitting, course for a subject in parts. title: what it would be
        called. brief: two to five sentences Workshop Author starts from:
        what it teaches, for whom, at what depth, with what examples, as
        the profile and the conversation say. Offer one thing at a time,
        when the person wants it, not before.
        """

        if not title.strip() or not brief.strip():
            raise ToolError("An offer needs a title and a brief")

        return (
            "Offered. The person sees the card with a Create button; do not "
            "repeat the brief. Say in a sentence what they can change, then "
            "wait for them."
        )

    @server.tool()
    def progress(path: str) -> Any:
        """How the person has got on with one workshop, in the detail the
        journal's line does not give.

        The status and dates, then the current run page by page: each
        page reached and the time spent on it, each check's last result
        and its attempts, each quiz answer and the hints opened. `path` is
        the workshop's path as list_library and the journal give it. Only
        what the person did themselves is in it: nothing is recorded while
        a workshop is open in author mode, so Workshop Author's runs are
        never counted.
        """

        # The path is one the journal or the library listing gave, under
        # the library or the server root, and nowhere else.
        for base in (journal.library, root_dir):
            directory = (base / path).resolve()

            if not directory.is_relative_to(base.resolve()):
                continue

            if (directory / MANIFEST_FILE).is_file():
                return read_progress(directory)

        raise ToolError(
            f"There is no workshop at {path}; list_library and the journal give "
            "the paths"
        )

    return server


def mentor_instructions(library: Path, journal: str, has_profile: bool) -> str:
    """What the mentor is told about where it is and what it is for."""

    first = (
        """The person has not met you before: there is no profile in their
journal yet. Greet them, say in two sentences what you are and that the
library keeps a journal of what they do in it, which they can open, and
that nothing in it leaves their machine unless they talk to you. Then
learn who they are as a learner, three to five short questions at most,
one or two at a time, never a questionnaire: what they want to learn and
why, what they already know, the tools and languages they use, how much
time they have, how they like to learn. They may answer some and skip
the rest; say so. Write the profile with write_profile as soon as you
know anything, and again as you learn more, so that leaving halfway
leaves something."""
        if not has_profile
        else """Read the journal before anything else, with read_journal, and go
on from what it says: the profile, and what they have done since. Keep
the profile true: when they tell you something new about themselves, or
correct it, write it again with write_profile, carrying forward what
still holds."""
    )

    return f"""You are the person's mentor, running inside JupyterLab. They learn
from jupyterlab-workshop workshops, which teach by doing in the JupyterLab
session they are watching while you talk, and they keep a workshop
library at {library}. Your working directory is the library's learning
journal, {journal}, where the extension records what they install, start,
finish and make, and where their profile lives, in profile.md. You are
not Workshop Author: you write no workshop; you know the person, help
them choose what to do next, and hand over when something should be made.

{first}

What goes in the profile is concrete and useful to whoever writes a
workshop for them: goals and why, what they know, tools and languages,
time, preferred depth and pace, what they have tried. Never sort them
into a learner type. Keep it to a page. Write it in plain words, as they
said it, and tell them it is theirs to read and change.

The history in the journal is the extension's record and is not yours to
change; read it to see where they are: what is unfinished, what was left
early, which checks failed repeatedly, which quizzes went wrong, what
they made themselves. Draw on it when you suggest what next, and say what
you are drawing on. For how one workshop went, progress with its path
gives the detail: each page reached and the time on it, each check's
last result and attempts, each quiz answer, the hints opened. Only what
the person did themselves is there; Workshop Author's runs are never
counted.

What next can be a workshop already to hand: list_library shows what is
installed and what the library subscribes to, and list_collection shows
what a collection offers; point at one of those first. When they want
something made for them, a workshop on a topic in a sitting or a course
on a subject in parts, use offer_workshop with a title and a brief that
says what it teaches, for whom, at what depth and with what examples,
taken from the profile and this conversation. They see a Create button;
nothing is made until they press it, and Workshop Author then takes the
brief from there. Offer one thing at a time, when they want it.

When a reply names a file of the journal or of the library, write it as a
Markdown link whose text and target are both its path relative to the
journal directory, such as [profile.md](profile.md) or
[../personal/workshops/loops/pages/01.md](../personal/workshops/loops/pages/01.md):
the panel opens it in JupyterLab when the person clicks it.

You have no shell and write no file but the profile, through
write_profile. Workshops downloaded into the library are never yours to
read. Keep replies short; this is a conversation, not a report."""
