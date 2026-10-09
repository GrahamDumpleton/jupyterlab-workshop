"""What an agent may do without asking the person first.

The rules are the same for every provider: the agent works on one
workshop, or on one course, so it reads and changes files inside that
directory freely, reads the authoring skill, uses the workshop tools and
the web, and asks before anything else. Workshops downloaded into the library,
from a collection or a URL of their own, are never touched, since they
are someone else's and may be replaced by an update. Bash runs freely
only where the agent's sandbox confines it.
Publishing to a gist is the one workshop tool that always asks, since it
puts the workshop on GitHub.

While a new workshop is being drafted nothing exists to work on, so a
read-only policy refuses every change to files and every command: the
agent may read, research and propose, and nothing more.

The policy is a pure function of the tool name and its input, so it is
tested without any agent.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from ..gist import read_record

Verdict = Literal["allow", "deny", "ask"]

# Tools that only read, and the input naming what they read.
READ_TOOLS: dict[str, str] = {
    "Read": "file_path",
    "Glob": "path",
    "Grep": "path",
    "LS": "path",
    "NotebookRead": "notebook_path",
}

# Tools that change files, and the input naming the file.
WRITE_TOOLS: dict[str, str] = {
    "Write": "file_path",
    "Edit": "file_path",
    "MultiEdit": "file_path",
    "NotebookEdit": "notebook_path",
}

# Tools that touch nothing on the machine.
FREE_TOOLS: frozenset[str] = frozenset(
    {
        "Skill",
        "ToolSearch",
        "TodoWrite",
        "WebSearch",
        "WebFetch",
    }
)

# The prefix the agent sees on the workshop tools.
WORKSHOP_TOOL_PREFIX = "mcp__workshop__"

# The workshop tool that sends the workshop to GitHub.
PUBLISH_GIST_TOOL = f"{WORKSHOP_TOOL_PREFIX}publish_gist"

# What Claude Code asks for when a sandboxed command reaches the network.
NETWORK_TOOL = "SandboxNetworkAccess"

# Why a change is refused while a workshop is drafted.
DRAFTING_REASON = (
    "Nothing is written or run while a new workshop is being drafted. "
    "Propose the workshop with propose_workshop; once the person creates "
    "it, the workshop is yours to write."
)


@dataclass(frozen=True)
class Decision:
    """What the policy says about one tool call, and why."""

    verdict: Verdict
    reason: str = ""

    # Whether an answer of Always allow may cover later calls like it.
    rememberable: bool = True


@dataclass(frozen=True)
class PermissionPolicy:
    """The rules for one conversation."""

    # The workshop the agent works on.
    workshop: Path

    # Other directories it may read, such as the authoring skill.
    readable: tuple[Path, ...] = ()

    # Directories it may never touch: the library's collections/ and
    # standalone/.
    forbidden: tuple[Path, ...] = ()

    # Whether Bash runs inside the agent's sandbox.
    sandboxed: bool = False

    # Whether nothing may be changed at all, while a workshop is drafted.
    read_only: bool = False

    def decide(self, tool: str, data: dict[str, Any]) -> Decision:
        """Whether a tool call may go ahead without asking."""

        if self.read_only and (tool in WRITE_TOOLS or tool == "Bash"):
            return Decision("deny", DRAFTING_REASON, rememberable=False)

        if tool == PUBLISH_GIST_TOOL:
            return self._publish_decision(data)

        if tool.startswith(WORKSHOP_TOOL_PREFIX) or tool in FREE_TOOLS:
            return Decision("allow")

        if tool in READ_TOOLS:
            return self._path_decision(data.get(READ_TOOLS[tool]), write=False)

        if tool in WRITE_TOOLS:
            return self._path_decision(data.get(WRITE_TOOLS[tool]), write=True)

        # A sandboxed command is allowed by the sandbox before the policy is
        # asked, so a Bash call reaching here wants to run outside it.
        if tool == "Bash":
            if self.sandboxed and not data.get("dangerouslyDisableSandbox"):
                return Decision("allow")

            return Decision("ask", "Runs a command on this machine")

        if tool == NETWORK_TOOL:
            host = str(data.get("host") or "the network")

            return Decision("ask", f"Lets a command reach {host} over the network")

        return Decision("ask", f"Uses {tool}")

    def _publish_decision(self, data: dict[str, Any]) -> Decision:
        # Updating the gist the workshop was published to may be allowed
        # for the rest of the conversation; making a new one is asked
        # about every time.
        directory = self._resolve(str(data.get("directory") or "."))
        record = read_record(directory)

        if record is not None and not data.get("create"):
            return Decision("ask", f"Updates the GitHub gist {record.url}")

        kind = "public" if data.get("public") else "secret"

        return Decision(
            "ask",
            f"Publishes {directory.name} to a new {kind} GitHub gist",
            rememberable=False,
        )

    def _path_decision(self, value: object, write: bool) -> Decision:
        # A search with no path searches the working directory.
        if value is None or value == "":
            return Decision("allow")

        if not isinstance(value, str):
            return Decision("ask", "Names a path the policy cannot read")

        path = self._resolve(value)

        for directory in self.forbidden:
            if _within(path, self._resolve(str(directory))):
                return Decision(
                    "deny",
                    "Downloaded workshops belong to whoever published them and "
                    "are never changed or read by the agent",
                )

        if _within(path, self._resolve(str(self.workshop))):
            return Decision("allow")

        if not write and any(
            _within(path, self._resolve(str(item))) for item in self.readable
        ):
            return Decision("allow")

        action = "Changes" if write else "Reads"

        return Decision("ask", f"{action} {path}, outside the workshop")

    def _resolve(self, value: str) -> Path:
        # Symbolic links are followed, so a link inside the workshop cannot
        # reach outside it unnoticed, and a linked course compares by its
        # real location.
        path = Path(os.path.expanduser(value))

        if not path.is_absolute():
            path = self.workshop / path

        return Path(os.path.realpath(path))


def _within(path: Path, directory: Path) -> bool:
    return path == directory or directory in path.parents
