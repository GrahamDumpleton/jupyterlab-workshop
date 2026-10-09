"""What a workshop or course repository should never commit.

The scaffolds write a ``.gitignore`` from the entries here, so a new
repository starts right, and :func:`check_ignores` compares any
repository against the same entries, so one brought into a library from
elsewhere, or made before an entry was added, can be told what it is
missing and have it added. The two share the one list, so they cannot
drift apart.
"""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

Kind = Literal["workshop", "course"]


@dataclass(frozen=True)
class IgnoreEntry:
    """One group of a ``.gitignore``: a comment saying why, then the
    patterns it covers, which git reads as it reads any ignore file."""

    why: str
    patterns: tuple[str, ...]

    #: Only for a course written for JupyterLite as well.
    lite: bool = False

    def render(self) -> str:
        """The group as it appears in the file."""

        comment = "\n".join(f"# {line}" for line in self.why.splitlines())

        return comment + "\n" + "\n".join(self.patterns) + "\n"


#: What a single workshop never commits.
WORKSHOP_IGNORES: tuple[IgnoreEntry, ...] = (
    IgnoreEntry("Runtime state written by the workshop extension", ("_workshop/",)),
    IgnoreEntry("Published archives", ("dist/",)),
    IgnoreEntry(
        "The learner's workspace, filled from files/ when the workshop opens",
        ("work/",),
    ),
    IgnoreEntry(
        "Temporary working files, never referred to from the workshop",
        ("scratch/",),
    ),
    IgnoreEntry(
        "Checkpoints JupyterLab keeps beside a file saved from its editor",
        (".ipynb_checkpoints/",),
    ),
    IgnoreEntry(
        "Claude Code's local state: the permissions granted in this checkout\n"
        "and its own bookkeeping, none of it meant for anyone else",
        (".claude/",),
    ),
)

#: What a course repository never commits.
COURSE_IGNORES: tuple[IgnoreEntry, ...] = (
    IgnoreEntry(
        "Python environment managed by uv",
        (".venv/", "__pycache__/", "*.py[cod]", ".ipynb_checkpoints/"),
    ),
    IgnoreEntry(
        "The authoring skill is a symlink into the installed package, made by\n"
        "`just install`, so it always matches the pinned release",
        (".claude/skills/jupyterlab-workshop-authoring",),
    ),
    IgnoreEntry(
        "Claude Code's local state: the permissions granted in this checkout\n"
        "and its own bookkeeping. The repository's .mcp.json and AGENTS.md are\n"
        "committed; these are local.",
        (".claude/settings.local.json", ".claude/.cc-writes/"),
    ),
    IgnoreEntry("Workshop Author's conversation about this course", (".workshop/",)),
    IgnoreEntry(
        "State and outputs left behind by opening, running or publishing a workshop",
        (
            "workshops/*/_workshop/",
            "workshops/*/work/",
            "workshops/*/dist/",
            "workshops/*/scratch/",
            "results-*.xml",
            "test-results/",
        ),
    ),
    IgnoreEntry(
        "The JupyterLite site, built by `just site`",
        ("dist/", ".jupyterlite.doit.db"),
        lite=True,
    ),
    IgnoreEntry(
        "Temporary working files for agents, never referenced from committed files",
        ("scratch/",),
    ),
    IgnoreEntry("Editors and OS", (".DS_Store",)),
)


def ignore_entries(kind: Kind, lite: bool = False) -> tuple[IgnoreEntry, ...]:
    """The entries a repository of this kind should have."""

    entries = WORKSHOP_IGNORES if kind == "workshop" else COURSE_IGNORES

    return tuple(entry for entry in entries if lite or not entry.lite)


def render_ignores(kind: Kind, lite: bool = False) -> str:
    """The ``.gitignore`` the scaffold writes for a repository of this kind."""

    return "\n".join(entry.render() for entry in ignore_entries(kind, lite))


@dataclass
class IgnoreReport:
    """What a repository's ``.gitignore`` lacks, and what was added to it."""

    kind: Kind
    directory: Path

    #: The patterns git does not ignore, with the reason each matters.
    missing: list[tuple[str, str]] = field(default_factory=list)

    #: The patterns written to the file by a fix, in order.
    added: list[str] = field(default_factory=list)

    #: Why the check was not exact: git missing, or the directory no
    #: repository, so the file's text was read instead.
    note: str = ""

    def to_dict(self) -> dict[str, object]:
        """The report as the tool and the command report it."""

        return {
            "kind": self.kind,
            "directory": str(self.directory),
            "missing": [
                {"pattern": pattern, "why": why} for pattern, why in self.missing
            ],
            "added": list(self.added),
            "note": self.note,
        }


def repository_kind(directory: Path) -> Kind | None:
    """Whether a directory is a workshop, a course, or neither."""

    if (directory / "workshop.yaml").is_file():
        return "workshop"

    for marker in ("OUTLINE.md", "catalog.json", "collections", "workshops"):
        if (directory / marker).exists():
            return "course"

    return None


def check_ignores(
    directory: Path, kind: Kind | None = None, fix: bool = False
) -> IgnoreReport:
    """Report the ignore patterns a repository lacks, and add them when asked.

    Each pattern is tried against git itself, with ``git check-ignore``,
    so a pattern the author wrote another way counts as present; without
    git, or in a directory that is no repository, the file's own lines
    are read instead and the report says so. With ``fix``, the missing
    entries are appended to ``.gitignore``, comments and all, and listed
    as added. Raises ``ValueError`` when the directory is neither a
    workshop nor a course and no kind is given.
    """

    directory = directory.expanduser().resolve()
    kind = kind or repository_kind(directory)

    if kind is None:
        raise ValueError(f"{directory} is neither a workshop nor a course")

    lite = kind == "course" and (directory / "lite").is_dir()
    report = IgnoreReport(kind=kind, directory=directory)
    ignore = directory / ".gitignore"
    git = shutil.which("git")

    # Ask git what it would ignore, which honours every form a pattern
    # can take; fall back to the file's text where git cannot answer.
    ignored: Callable[[str], bool]

    if git is not None and _is_repository(git, directory):
        ignored = _ignored_by_git(git, directory)
    else:
        ignored = _listed_in(ignore)
        report.note = (
            "git is not installed, so the file's lines were read instead"
            if git is None
            else "the directory is not a git repository, so the file's lines "
            "were read instead"
        )

    missing: list[IgnoreEntry] = []

    for entry in ignore_entries(kind, lite):
        patterns = tuple(p for p in entry.patterns if not ignored(p))

        if patterns:
            missing.append(IgnoreEntry(entry.why, patterns, entry.lite))
            report.missing.extend((pattern, entry.why) for pattern in patterns)

    if fix and missing:
        existing = ignore.read_text("utf-8") if ignore.is_file() else ""
        separator = (
            ""
            if not existing or existing.endswith("\n\n")
            else ("\n" if existing.endswith("\n") else "\n\n")
        )
        ignore.write_text(
            existing + separator + "\n".join(entry.render() for entry in missing),
            "utf-8",
        )
        report.added = [pattern for entry in missing for pattern in entry.patterns]

    return report


def _is_repository(git: str, directory: Path) -> bool:
    """Whether git can answer for the directory: a work tree it is part of."""

    completed = subprocess.run(
        [git, "-C", str(directory), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
    )

    return completed.returncode == 0 and completed.stdout.strip() == "true"


def _ignored_by_git(git: str, directory: Path) -> Callable[[str], bool]:
    """A test of whether git ignores a path matching a pattern."""

    def ignored(pattern: str) -> bool:
        completed = subprocess.run(
            [
                git,
                "-C",
                str(directory),
                "check-ignore",
                "-q",
                "--no-index",
                _probe(pattern),
            ],
            capture_output=True,
            text=True,
        )

        return completed.returncode == 0

    return ignored


def _listed_in(ignore: Path) -> Callable[[str], bool]:
    """A test of whether a ``.gitignore`` lists a pattern as written, with
    or without its trailing slash, for where git cannot be asked."""

    lines = _lines(ignore)

    def listed(pattern: str) -> bool:
        return pattern in lines or pattern.rstrip("/") in lines

    return listed


def _probe(pattern: str) -> str:
    """A path that the pattern would match, to ask git about: a wildcard
    stands for a name, and a directory pattern gets a file inside it."""

    probe = pattern.lstrip("/").replace("*", "x").replace("[cod]", "c")

    if probe.endswith("/"):
        probe += "probe"

    return probe


def _lines(ignore: Path) -> set[str]:
    """The patterns a ``.gitignore`` lists, for the fallback."""

    if not ignore.is_file():
        return set()

    return {
        line.strip()
        for line in ignore.read_text("utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
