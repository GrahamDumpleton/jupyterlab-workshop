"""Promoting a workshop into a course.

A workshop of the library owner's that outgrows standing alone, or that
belongs with others, moves into a course: its directory goes under the
course's ``workshops/``, whole, so its pages, files and the progress and
gist record in its ``_workshop/`` state come with it and a later publish
updates the same gist. The course's design and indexes then take it in:
an entry written from its manifest goes into ``OUTLINE.md`` under the
chosen collection, the collection's index is rebuilt with it at the end,
and the Justfile's order for that collection gains its name. Both the
workshop and the course are git repositories, so the workshop's own
repository is removed with the directory and its files are committed in
the course, which is how its history carries on; the commit is skipped,
and said so, when git has no identity to commit as.

The workshop's conversation with Workshop Author does not move: a course
has one conversation, so the record is dropped and the panel is pointed
at the course's conversation with the workshop named.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .catalog import CatalogError, parse_catalog
from .collection import (
    CollectionError,
    CollectionMetadata,
    guess_repository,
    index_repository,
    parse_collection,
)
from .course import COURSE_FILE, read_record
from .library import DEFAULT_COURSE_WORKSHOPS
from .publish import PublishError, read_manifest
from .tree import STATE_DIR

#: The conversation record and attachments a workshop leaves behind.
CONVERSATION_FILES = ("agent.json", "attachments")


class PromotionError(Exception):
    """The workshop cannot be promoted as asked."""


@dataclass(frozen=True)
class PromotionReport:
    """What promoting a workshop did."""

    #: The workshop's new directory, under the course's ``workshops/``.
    target: Path

    #: The collection it was added to, or None for a course without one.
    collection: str | None

    #: Whether the collection's index now lists it.
    indexed: bool

    #: Whether an entry was written into ``OUTLINE.md``.
    outlined: bool

    #: Whether the Justfile's order for the collection gained its name.
    ordered: bool

    #: Whether the move was committed in the course, and if not why.
    committed: bool
    commit_note: str = ""

    def to_dict(self) -> dict[str, Any]:
        """The report as the endpoint and the tool give it."""

        return {
            "target": str(self.target),
            "collection": self.collection,
            "indexed": self.indexed,
            "outlined": self.outlined,
            "ordered": self.ordered,
            "committed": self.committed,
            "commit_note": self.commit_note,
        }


def course_collections(course: Path) -> list[dict[str, str]]:
    """The collections of a course, each with its ``name`` and ``title``.

    The catalog names them, by the relative path of each index; without
    a catalog, every ``collections/<name>/collection.json`` counts. The
    name is the index's directory, as the Justfile and the outline use it.
    """

    indexes: list[Path] = []
    catalog_path = course / "catalog.json"

    if catalog_path.is_file():
        try:
            catalog = parse_catalog(catalog_path.read_text(encoding="utf-8"))
        except (OSError, CatalogError):
            catalog = {"collections": []}

        for entry in catalog.get("collections") or []:
            url = str(entry.get("url") or "")

            if url and "://" not in url and not url.startswith("/"):
                indexes.append((course / url).resolve())
    else:
        indexes.extend(sorted((course / "collections").glob("*/collection.json")))

    found: list[dict[str, str]] = []

    for index_path in indexes:
        if not index_path.is_file():
            continue

        try:
            index = parse_collection(index_path.read_text(encoding="utf-8"))
        except (OSError, CollectionError):
            continue

        found.append(
            {
                "name": index_path.parent.name,
                "title": str(index.get("title") or index_path.parent.name),
            }
        )

    return found


def promote_workshop(
    workshop: Path, course: Path, collection: str | None = None
) -> PromotionReport:
    """Move a workshop into a course, and take it into the course's design,
    index and order.

    ``collection`` names the part of the course it joins, by the index's
    directory name; a course with one collection needs no name, and one
    with none takes the workshop into ``workshops/`` alone.
    """

    workshop = workshop.resolve()
    course = course.resolve()

    _check(workshop, course)

    collections = course_collections(course)
    chosen = _choose(collection, collections)
    workshops_dir = course / DEFAULT_COURSE_WORKSHOPS
    target = workshops_dir / workshop.name

    if target.exists():
        raise PromotionError(
            f"The course already has a workshop called {workshop.name}"
        )

    # The workshop's own repository ends here, since its files join the
    # course's, and its conversation does not come along.
    if (workshop / ".git").is_dir():
        shutil.rmtree(workshop / ".git")

    for name in CONVERSATION_FILES:
        path = workshop / STATE_DIR / name

        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        elif path.exists():
            path.unlink()

    workshops_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(workshop), str(target))

    outlined = ordered = indexed = False
    touched: list[Path] = [target]

    if chosen is not None:
        number, indexed = _index(course, chosen, target)

        if indexed:
            touched.append(course / "collections" / chosen / "collection.json")

        outlined = _outline(course, chosen, collections, target, number)

        if outlined:
            touched.append(course / "OUTLINE.md")

        ordered = _order(course, chosen, target.name)

        if ordered:
            touched.append(course / "Justfile")

    committed, note = _commit(course, touched, target.name)

    return PromotionReport(
        target=target,
        collection=chosen,
        indexed=indexed,
        outlined=outlined,
        ordered=ordered,
        committed=committed,
        commit_note=note,
    )


def _check(workshop: Path, course: Path) -> None:
    if not (workshop / "workshop.yaml").is_file():
        raise PromotionError(f"{workshop} is not a workshop")

    if (workshop / STATE_DIR / "source.json").is_file():
        raise PromotionError(
            f"{workshop} was downloaded from a collection, so it is not yours to move"
        )

    if not course.is_dir():
        raise PromotionError(f"{course} is not a directory")

    if (course / "workshop.yaml").is_file():
        raise PromotionError(f"{course} is a single workshop, not a course of them")

    if course == workshop or course in workshop.parents:
        raise PromotionError(f"{workshop} is already inside {course}")


def _choose(collection: str | None, collections: list[dict[str, str]]) -> str | None:
    names = [item["name"] for item in collections]

    if collection:
        if collection not in names:
            raise PromotionError(
                f"The course has no collection {collection}; it has "
                + (", ".join(names) if names else "none")
            )

        return collection

    if len(names) == 1:
        return names[0]

    if len(names) > 1:
        raise PromotionError(
            "The course has several collections, so name the one the workshop "
            "joins: " + ", ".join(names)
        )

    return None


def _index(course: Path, collection: str, target: Path) -> tuple[int, bool]:
    # The index is rebuilt with every workshop it lists, in its order, and
    # the new one last; the number is its place, from one.
    index_path = course / "collections" / collection / "collection.json"

    if not index_path.is_file():
        return 1, False

    try:
        existing = parse_collection(index_path.read_text(encoding="utf-8"))
    except (OSError, CollectionError) as error:
        raise PromotionError(f"Unable to read {index_path}: {error}") from error

    directories: list[Path] = []

    for entry in existing.get("workshops") or []:
        for version in entry.get("versions") or []:
            subdir = (version.get("source") or {}).get("subdir")

            if subdir and (course / subdir / "workshop.yaml").is_file():
                directories.append(course / subdir)

                break

    directories = list(dict.fromkeys(directories))
    number = len(directories) + 1
    directories.append(target)

    repo, ref = _repository(course)

    try:
        index = index_repository(
            course, directories, repo, ref, existing, CollectionMetadata()
        )
    except CollectionError as error:
        raise PromotionError(f"Unable to rebuild {index_path}: {error}") from error

    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")

    return number, True


def _repository(course: Path) -> tuple[str, str]:
    # The address the indexes name: the Justfile's, which course init
    # wrote and publishing rewrote, else the record's, else the origin,
    # else the scaffold's placeholder.
    justfile = course / "Justfile"
    repo = ""

    if justfile.is_file():
        match = re.search(
            r'^repo\s*:=\s*"([^"]+)"', justfile.read_text(encoding="utf-8"), re.M
        )
        repo = match.group(1) if match else ""

    if not repo and (course / COURSE_FILE).is_file():
        try:
            repo = str((read_record(course) or {}).get("repository") or "")
        except Exception:
            repo = ""

    origin, branch = guess_repository(course)

    return repo or origin or f"https://github.com/OWNER/{course.name}", branch or "main"


def _outline(
    course: Path,
    collection: str,
    collections: list[dict[str, str]],
    target: Path,
    number: int,
) -> bool:
    # The entry goes at the end of the collection's workshops section,
    # before the next heading; a design without that section gets it at
    # the end, so nothing is lost.
    outline_path = course / "OUTLINE.md"

    if not outline_path.is_file():
        return False

    title = next(
        (item["title"] for item in collections if item["name"] == collection),
        collection,
    )
    text = outline_path.read_text(encoding="utf-8")
    entry = outline_entry(target, number)
    heading = re.search(rf"^### The {re.escape(title)} workshops[^\n]*\n", text, re.M)

    if heading is None:
        updated = text.rstrip("\n") + "\n\n" + entry
    else:
        following = re.compile(r"^#{1,3} ", re.M).search(text, heading.end())
        cut = following.start() if following else len(text)
        updated = text[:cut].rstrip("\n") + "\n\n" + entry + "\n" + text[cut:]

    outline_path.write_text(updated, encoding="utf-8")

    return True


def outline_entry(workshop: Path, number: int) -> str:
    """An outline entry for a workshop, from its manifest and pages."""

    try:
        manifest = read_manifest(workshop)
    except PublishError:
        manifest = {}

    title = str(manifest.get("title") or workshop.name)
    description = str(manifest.get("description") or "").strip()
    listed = manifest.get("pages")
    pages = (
        [_page_title(workshop, page) for page in listed]
        if isinstance(listed, list)
        else []
    )
    today = datetime.now(UTC).date().isoformat()
    lines = [f"### {number}. `{workshop.name}`: {title}", ""]

    lines.append(description or "One line on the question the workshop answers.")
    lines.append("")

    if pages:
        lines.append("Pages, in order: " + "; ".join(pages) + ".")
        lines.append("")

    lines.append(
        f"- Promoted from a workshop of its own on {today}; fill in the "
        "format, the sources it draws on and its length."
    )

    return "\n".join(lines) + "\n"


def _page_title(workshop: Path, page: object) -> str:
    path = page.get("path") if isinstance(page, dict) else page

    if not isinstance(path, str):
        return str(path)

    try:
        text = (workshop / path).read_text(encoding="utf-8")
    except OSError:
        return Path(path).stem

    front = re.match(r"---\n(.*?)\n---\n", text, re.S)

    if front:
        found = re.search(r"^title:\s*(.+)$", front.group(1), re.M)

        if found:
            return found.group(1).strip().strip("\"'")

    heading = re.search(r"^# (.+)$", text, re.M)

    return heading.group(1).strip() if heading else Path(path).stem


def _order(course: Path, collection: str, name: str) -> bool:
    # The Justfile holds each collection's order as a variable listing
    # the workshop names; the new one goes at the end.
    justfile = course / "Justfile"

    if not justfile.is_file():
        return False

    variable = collection.replace("-", "_")
    text = justfile.read_text(encoding="utf-8")
    pattern = re.compile(rf'^({re.escape(variable)}\s*:=\s*")([^"]*)"', re.M)
    match = pattern.search(text)

    if match is None or name in match.group(2).split():
        return False

    names = [*match.group(2).split(), name]
    updated = text[: match.start()] + f'{match.group(1)}{" ".join(names)}"'
    updated += text[match.end() :]

    justfile.write_text(updated, encoding="utf-8")

    return True


def _commit(course: Path, paths: list[Path], name: str) -> tuple[bool, str]:
    # The move is committed in the course, so the workshop's history goes
    # on there; without git, a repository or an identity, it is left for
    # the person and the report says why.
    git = shutil.which("git")

    if git is None:
        return False, "git is not installed"

    inside = subprocess.run(
        [git, "-C", str(course), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=False,
    )

    if inside.returncode != 0:
        return False, "the course is not a git repository"

    relative = [str(path.relative_to(course)) for path in paths if path.exists()]
    added = subprocess.run(
        [git, "-C", str(course), "add", "-A", "--", *relative],
        capture_output=True,
        text=True,
        check=False,
    )

    if added.returncode != 0:
        return False, f"git add failed: {added.stderr.strip()}"

    committed = subprocess.run(
        [git, "-C", str(course), "commit", "-q", "-m", f"Add the workshop {name}"],
        capture_output=True,
        text=True,
        check=False,
    )

    if committed.returncode != 0:
        detail = (committed.stderr or committed.stdout).strip().splitlines()

        return False, "git commit failed: " + (detail[-1] if detail else "unknown")

    return True, ""
