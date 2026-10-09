"""Workshop libraries: a workshops directory with a registry of its own.

A library is the workshops directory, ``<JupyterLab root>/<workshops
directory>``, when it holds ``library.json``. The registry records the
collections and catalogs its owner subscribes to, in order, the
directory under ``installed/collections/`` each collection's workshops
go into, and the courses that need saying something about. Inside the
library, what the owner made is kept apart from what they installed:
their own single workshops live under ``personal/workshops/`` and their
courses, each a repository of workshops with its indexes, under
``personal/courses/``; workshops installed from a collection live under
``installed/collections/<collection>/`` and those downloaded from a URL
of their own under ``installed/workshops/``. The directories under
``installed/`` always carry a short hash of where their workshops came
from, so two sources never compete for a name. A workshops directory
without the registry is a plain one and behaves exactly as before.

A library made by an earlier release, whose registry is version 1,
keeps its own workshops under ``personal/``, its courses under
``projects/`` and its downloads under ``collections/`` and
``standalone/``. Such a registry is read, so the library can be seen to
need upgrading, and ``upgrade_library`` moves the trees to where this
release keeps them; nothing writes to it before then.

The browser applies the same rules through the core package's
``library`` module; the two must choose the same directory names, which
the shared test vectors check.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .collection import collection_hash, normalize_location

#: The registry file that makes a workshops directory a library.
LIBRARY_FILE = "library.json"

#: The registry format version this package understands.
LIBRARY_VERSION = 2

#: The registry format version before this one, read but never written.
LEGACY_LIBRARY_VERSION = 1

#: The tree of what the library's owner made.
PERSONAL_DIRECTORY = "personal"

#: The tree of what was installed from elsewhere.
INSTALLED_DIRECTORY = "installed"

#: Where the owner's own single workshops go.
PERSONAL_WORKSHOPS_DIRECTORY = f"{PERSONAL_DIRECTORY}/workshops"

#: Where courses go, cloned in or linked from elsewhere.
COURSES_DIRECTORY = f"{PERSONAL_DIRECTORY}/courses"

#: Where workshops installed from a collection go, a directory per collection.
COLLECTIONS_DIRECTORY = f"{INSTALLED_DIRECTORY}/collections"

#: Where workshops downloaded from a URL of their own go.
INSTALLED_WORKSHOPS_DIRECTORY = f"{INSTALLED_DIRECTORY}/workshops"

#: A course's workshops directory when its entry does not name one.
DEFAULT_COURSE_WORKSHOPS = "workshops"

#: A catalog a course may hold at its top, listing its collections.
COURSE_CATALOG = "catalog.json"

#: A collection index a course may hold at its top.
COURSE_COLLECTION = "collection.json"

#: The environment variable naming the default library.
LIBRARY_VARIABLE = "JUPYTER_WORKSHOP_LIBRARY"

#: The default library's directory under the home directory.
DEFAULT_LIBRARY_NAME = "Workshops"

#: The longest slug made from a collection id, before any suffix.
MAX_SLUG = 64

#: The trees of the previous layout, where each goes now, and what each
#: holds, in the order they are moved: the owner's tree first, since the
#: courses go inside it.
LEGACY_TREES: tuple[tuple[str, str, str], ...] = (
    ("personal", PERSONAL_WORKSHOPS_DIRECTORY, "workshop"),
    ("projects", COURSES_DIRECTORY, "course"),
    ("standalone", INSTALLED_WORKSHOPS_DIRECTORY, "workshop"),
    ("collections", COLLECTIONS_DIRECTORY, "collection"),
)

#: The key the previous format kept its courses under.
LEGACY_COURSES_KEY = "projects"

#: Why a library in the previous layout is not written to.
NEEDS_UPGRADE_MESSAGE = (
    "The workshop library was made by an earlier release and keeps its "
    "workshops in the previous layout; upgrade it from the workshop browser, "
    "or by starting it with jupyter workshop library, before changing it"
)

COURSE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

DIRECTORY_NAME = re.compile(r"^[a-z0-9][a-z0-9.-]*$")

#: Names Windows refuses for a file or directory, whatever follows a dot.
RESERVED = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{number}" for number in range(1, 10)}
    | {f"lpt{number}" for number in range(1, 10)}
)

#: The order keys are written in, matching the browser's writes.
KEY_ORDER = ("version", "collections", "catalogs", "directories", "courses")

#: The state directory of a workshop, where its environment is recorded.
_STATE_DIR = "_workshop"


class LibraryError(Exception):
    """A registry that cannot be read, written or understood."""


def empty_library() -> dict[str, Any]:
    """A new, empty registry."""

    return {"version": LIBRARY_VERSION}


def needs_upgrade(library: Mapping[str, Any]) -> bool:
    """Whether a registry is in the previous format, so its library keeps
    its workshops in the previous layout and must be upgraded first."""

    return library.get("version") != LIBRARY_VERSION


def normalize_workshops_directory(directory: str) -> str:
    """The workshops directory setting in the form paths are joined with.

    The root itself, given as ``.``, ``./`` or nothing, becomes the empty
    string, and surrounding slashes go.
    """

    trimmed = directory.strip().replace("\\", "/")

    while trimmed.startswith("./"):
        trimmed = trimmed[2:]

    trimmed = trimmed.strip("/")

    return "" if trimmed == "." else trimmed


def library_directory(root_dir: Path, directory: str) -> Path:
    """The workshops directory as a path under the JupyterLab root."""

    relative = normalize_workshops_directory(directory)

    return root_dir / relative if relative else root_dir


def library_file(root_dir: Path, directory: str) -> Path:
    """Where the registry of a workshops directory is, or would be."""

    return library_directory(root_dir, directory) / LIBRARY_FILE


def is_own_library_path(directory: str, path: str) -> bool:
    """Whether a workshop path, relative to the root, is the library owner's:
    under ``personal/workshops/``, or under ``personal/courses/``, whether
    a course cloned there or linked in.

    The same lexical rule as the browser's ``isOwnLibraryPath``, with the
    same test vectors; whether the directory is a library at all, and
    whether the workshop was downloaded, are for the caller to check.
    """

    base = normalize_workshops_directory(directory)
    target = normalize_workshops_directory(path)

    if ".." in target.split("/"):
        return False

    for tree in (PERSONAL_WORKSHOPS_DIRECTORY, COURSES_DIRECTORY):
        prefix = f"{base}/{tree}/" if base else f"{tree}/"

        if target.startswith(prefix) and len(target) > len(prefix):
            return True

    return False


def is_library(root_dir: Path, directory: str) -> bool:
    """Whether a workshops directory is a library: whether it has a registry."""

    return library_file(root_dir, directory).is_file()


def parse_library(data: Any, location: str = LIBRARY_FILE) -> dict[str, Any]:
    """Validate the JSON value of a registry and return it in normal form.

    The checks are made here rather than against the bundled schema,
    which a source checkout may not have built, and they match what the
    schema and the browser's parser accept. A registry in the previous
    format is accepted too, its ``projects`` read as ``courses`` and its
    version kept, so that its library can be seen to need upgrading.
    """

    if not isinstance(data, dict):
        raise LibraryError(f"{location} must contain an object")

    version = data.get("version")

    if version not in (LIBRARY_VERSION, LEGACY_LIBRARY_VERSION):
        raise LibraryError(
            f"{location} has unsupported version {version!r}, "
            f"expected {LIBRARY_VERSION}"
        )

    courses_key = LEGACY_COURSES_KEY if version == LEGACY_LIBRARY_VERSION else "courses"
    allowed = {courses_key if key == "courses" else key for key in KEY_ORDER}
    unknown = sorted(set(data) - allowed)

    if unknown:
        raise LibraryError(f"{location} has unknown keys {', '.join(unknown)}")

    library: dict[str, Any] = {"version": version}

    for key in ("collections", "catalogs"):
        if key not in data:
            continue

        value = data[key]

        if not isinstance(value, list) or not all(
            isinstance(item, str) and item for item in value
        ):
            raise LibraryError(f'{location}: "{key}" must be a list of locations')

        library[key] = list(value)

    if "directories" in data:
        library["directories"] = _parse_directories(data["directories"], location)

    if courses_key in data:
        library["courses"] = _parse_courses(data[courses_key], location)

    return library


def serialize_library(library: Mapping[str, Any]) -> str:
    """The text of a registry: two space indents, a final newline, and the
    keys in a fixed order, so the browser and the CLI write the same file.

    A registry that needs upgrading is never written, since the layout it
    describes is the previous one.
    """

    if needs_upgrade(library):
        raise LibraryError(NEEDS_UPGRADE_MESSAGE)

    ordered = {key: library[key] for key in KEY_ORDER if key in library}

    return json.dumps(ordered, indent=2, ensure_ascii=False) + "\n"


def read_library(root_dir: Path, directory: str) -> dict[str, Any] | None:
    """The registry of a workshops directory, or None if it is not a library."""

    path = library_file(root_dir, directory)

    if not path.is_file():
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise LibraryError(f"Unable to read {path}: {error}") from error

    return parse_library(data, str(path))


def write_library(root_dir: Path, directory: str, library: Mapping[str, Any]) -> None:
    """Write a registry, replacing the file in one step.

    The text goes to a temporary file beside it first, so a reader never
    sees half a registry and a failed write leaves the old one in place.
    """

    path = library_file(root_dir, directory)
    text = serialize_library(parse_library(dict(library), str(path)))

    path.parent.mkdir(parents=True, exist_ok=True)

    handle, temporary = tempfile.mkstemp(
        prefix=".library-", suffix=".json", dir=path.parent
    )

    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)

        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)

        raise


def update_library(
    root_dir: Path,
    directory: str,
    change: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    """Re-read the registry, apply a change and write it back.

    Reading just before writing keeps a change made meanwhile by the
    browser or another command, rather than overwriting it with an older
    copy. Raises when the directory is not a library, or is one that
    needs upgrading, whose layout a write would take for the current one.
    """

    library = read_library(root_dir, directory)

    if library is None:
        raise LibraryError(
            f"{library_directory(root_dir, directory)} is not a workshop library"
        )

    if needs_upgrade(library):
        raise LibraryError(NEEDS_UPGRADE_MESSAGE)

    changed = change(library)

    write_library(root_dir, directory, changed)

    return changed


def slugify_collection_id(collection_id: str) -> str | None:
    """A directory name made from a collection id, or None if unusable.

    Ids look like ``example.org/course``, so the slashes and anything else
    outside lower case letters, digits, dots and hyphens become hyphens,
    and a Windows reserved name is refused.
    """

    slug = re.sub(r"[^a-z0-9.-]+", "-", collection_id.lower())
    slug = re.sub(r"-{2,}", "-", slug).strip(".-")

    if len(slug) > MAX_SLUG:
        slug = slug[:MAX_SLUG].rstrip(".-")

    if not slug or not DIRECTORY_NAME.match(slug):
        return None

    if slug.split(".")[0] in RESERVED:
        return None

    return slug


def choose_collection_directory(location: str, collection_id: str | None) -> str:
    """The directory under ``installed/collections/`` for a collection that
    has none.

    The slug of its id followed by the location's hash, or the hash alone
    when there is no usable id. The hash makes it unique to the location,
    whatever id another collection claims.
    """

    digest = collection_hash(location)
    slug = slugify_collection_id(collection_id) if collection_id else None

    return digest if slug is None else f"{slug}-{digest}"


def download_key(kind: str, url: str, subdir: str = "") -> str:
    """What identifies a download, whatever revision of it was taken.

    Its kind, its URL compared as collection locations are with any
    ``.git`` dropped, and its subdirectory. A gist is named by its id
    alone, since its owner can be left out of the URL. Two downloads with
    the same key are the same workshop, so one may replace the other.
    """

    location = re.sub(r"\.git$", "", normalize_location(url))
    gist = re.match(r"^https://gist\.github\.com/(?:[^/]+/)?([0-9a-fA-F]+)$", location)

    if gist:
        location = f"https://gist.github.com/{gist.group(1).lower()}"

    path = "/".join(part for part in subdir.split("/") if part)

    return f"{kind}:{location}#{path}" if path else f"{kind}:{location}"


def standalone_directory(name: str, kind: str, url: str, subdir: str = "") -> str:
    """The directory under ``installed/workshops/`` for a workshop
    downloaded from a URL of its own: its name followed by the short hash
    of its download key, so the same source always lands in the same
    place and no other can."""

    digest = hashlib.sha256(download_key(kind, url, subdir).encode("utf-8"))

    return f"{name}-{digest.hexdigest()[:7]}"


def may_replace_download(
    record: Any, kind: str, url: str, subdir: str = "", collection: str = ""
) -> bool:
    """Whether a directory's source record says it is a download that a new
    download may replace: one from the same source, or one installed from
    the same collection, as an update of it is. Anything else, a local
    workshop above all, is never replaced."""

    if not isinstance(record, dict) or not isinstance(record.get("source"), dict):
        return False

    recorded = record["source"]

    if recorded.get("kind") not in {"git", "archive"} or not isinstance(
        recorded.get("url"), str
    ):
        return False

    if (
        collection
        and isinstance(record.get("collection"), str)
        and normalize_location(record["collection"]) == normalize_location(collection)
    ):
        return True

    recorded_subdir = recorded.get("subdir")

    return download_key(
        str(recorded["kind"]),
        recorded["url"],
        recorded_subdir if isinstance(recorded_subdir, str) else "",
    ) == download_key(kind, url, subdir)


def recorded_directory(library: Mapping[str, Any], location: str) -> str | None:
    """The directory recorded for a collection location, matched the way
    subscriptions are, or None when none has been chosen."""

    wanted = normalize_location(location)

    for key, directory in (library.get("directories") or {}).items():
        if normalize_location(key) == wanted:
            return str(directory)

    return None


def assign_collection_directory(
    library: Mapping[str, Any], location: str, collection_id: str | None
) -> tuple[str, dict[str, Any]]:
    """The directory a collection's workshops are installed into, choosing
    and recording one when it has none. Returns the directory and the
    registry to write back."""

    recorded = recorded_directory(library, location)

    if recorded is not None:
        return recorded, dict(library)

    directories = dict(library.get("directories") or {})
    directory = choose_collection_directory(location, collection_id)

    directories[location] = directory

    return directory, {**library, "directories": directories}


def course_entry(library: Mapping[str, Any], name: str) -> dict[str, Any]:
    """The registry entry for a course, or a bare one if it has none."""

    for course in library.get("courses") or []:
        if course.get("name") == name:
            return dict(course)

    return {"name": name}


def course_workshops(course: Mapping[str, Any]) -> str:
    """A course's workshops directory, relative to the course."""

    return str(course.get("workshops") or DEFAULT_COURSE_WORKSHOPS)


def course_path(base: str, target: str) -> str | None:
    """The path inside a course that a location in one of its index files
    names, resolved against the file's own path: None for a URL, an
    absolute path, or anything that climbs out of the course. The course
    itself is the empty string. Mirrors the browser's ``coursePath``."""

    if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.IGNORECASE) or target.startswith(
        "/"
    ):
        return None

    directory = base.rsplit("/", 1)[0] if "/" in base else ""
    segments: list[str] = []

    for part in f"{directory}/{target}".split("/"):
        if part in {"", "."}:
            continue

        if part == "..":
            if not segments:
                return None

            segments.pop()
        else:
            segments.append(part)

    return "/".join(segments)


def catalog_collections(catalog: Any, catalog_path: str) -> list[dict[str, str]]:
    """The collections a course's catalog lists that are inside the
    course, in catalog order, each as its ``path`` and ``title``. A
    collection named by URL is somewhere else and left out; anything
    unreadable is skipped rather than refusing the rest."""

    if not isinstance(catalog, dict) or not isinstance(
        catalog.get("collections"), list
    ):
        return []

    found: list[dict[str, str]] = []

    for item in catalog["collections"]:
        if not isinstance(item, dict) or not isinstance(item.get("url"), str):
            continue

        path = course_path(catalog_path, item["url"])

        if path:
            title = item.get("title")
            found.append(
                {
                    "path": path,
                    "title": title if isinstance(title, str) and title else path,
                }
            )

    return found


def collection_workshops(collection: Any) -> list[str]:
    """The directories, relative to the course, of the workshops a
    collection index in it lists, in index order: each entry's newest
    version, the first listed, names its directory with the ``subdir`` of
    its git source, or the course itself with none. An entry fetched as
    an archive, or one outside the course, is left out."""

    if not isinstance(collection, dict) or not isinstance(
        collection.get("workshops"), list
    ):
        return []

    found: list[str] = []

    for entry in collection["workshops"]:
        versions = entry.get("versions") if isinstance(entry, dict) else None
        newest = versions[0] if isinstance(versions, list) and versions else None
        source = newest.get("source") if isinstance(newest, dict) else None

        if not isinstance(source, dict) or not isinstance(source.get("git"), str):
            continue

        # A subdir is always within the repository, however it is written.
        subdir = source.get("subdir")
        path = course_path("", subdir.lstrip("/") if isinstance(subdir, str) else "")

        if path is not None and path not in found:
            found.append(path)

    return found


def collection_title(collection: Any, fallback: str) -> str:
    """The title a collection index gives itself, or the fallback."""

    title = collection.get("title") if isinstance(collection, dict) else None

    return title if isinstance(title, str) and title else fallback


def is_link(path: Path) -> bool:
    """Whether a path is a symbolic link or, on Windows, a directory junction."""

    return path.is_symlink() or path.is_junction()


def link_course(
    library_dir: Path,
    target: Path,
    name: str | None = None,
    workshops: str | None = None,
) -> dict[str, Any]:
    """Link a repository kept outside the library in as a course.

    Makes ``personal/courses/<name>`` a symbolic link to ``target``, or a
    directory junction on Windows where a symbolic link needs rights a
    user may not have, and records the course in the registry with its
    target, which is what makes the link trusted. Returns the entry.
    """

    target = target.expanduser().resolve()
    name = name or target.name

    if not COURSE_NAME.match(name):
        raise LibraryError(
            f"{name!r} is not a usable course name; give one with --name"
        )

    if not target.is_dir():
        raise LibraryError(f"{target} is not a directory")

    library = read_library(library_dir, "")

    if library is None:
        raise LibraryError(f"{library_dir} is not a workshop library")

    if needs_upgrade(library):
        raise LibraryError(NEEDS_UPGRADE_MESSAGE)

    link = library_dir / COURSES_DIRECTORY / name

    if is_link(link):
        if link.resolve() != target:
            raise LibraryError(f"{link} already links to {link.resolve()}")
    elif link.exists():
        raise LibraryError(f"{link} already exists and is not a link")
    else:
        link.parent.mkdir(parents=True, exist_ok=True)
        _make_link(link, target)

    entry: dict[str, Any] = {"name": name, "target": target.as_posix()}

    if workshops:
        entry["workshops"] = workshops

    def change(current: dict[str, Any]) -> dict[str, Any]:
        others = [
            course
            for course in current.get("courses") or []
            if course.get("name") != name
        ]

        return {**current, "courses": [*others, entry]}

    update_library(library_dir, "", change)

    return entry


def unlink_course(library_dir: Path, name: str) -> dict[str, Any]:
    """Remove a linked course's link and its registry entry.

    Only the link is removed, never anything it points to, and a link
    whose target has gone is removed all the same. Returns the entry
    that was removed.
    """

    library = read_library(library_dir, "")

    if library is None:
        raise LibraryError(f"{library_dir} is not a workshop library")

    if needs_upgrade(library):
        raise LibraryError(NEEDS_UPGRADE_MESSAGE)

    entry = course_entry(library, name)

    if "target" not in entry:
        raise LibraryError(f"{name} is not a linked course")

    link = library_dir / COURSES_DIRECTORY / name

    if is_link(link):
        _remove_link(link)
    elif link.exists():
        raise LibraryError(f"{link} is not a link, so it is left in place")

    update_library(
        library_dir,
        "",
        lambda current: {
            **current,
            "courses": [
                course
                for course in current.get("courses") or []
                if course.get("name") != name
            ],
        },
    )

    return entry


def repair_links(library_dir: Path) -> list[str]:
    """Recreate the links of linked courses whose link has gone but whose
    target is still there. Returns the names of the courses relinked. A
    library that needs upgrading is left alone, since its links are
    where the upgrade will move them from."""

    library = read_library(library_dir, "")

    if library is None or needs_upgrade(library):
        return []

    relinked: list[str] = []

    for course in library.get("courses") or []:
        target = course.get("target")
        link = library_dir / COURSES_DIRECTORY / str(course["name"])

        if not target or is_link(link) or link.exists():
            continue

        if Path(target).is_dir():
            link.parent.mkdir(parents=True, exist_ok=True)
            _make_link(link, Path(target))
            relinked.append(str(course["name"]))

    return relinked


def linked_course_path(root: Path, parts: list[str]) -> Path | None:
    """The path for ``parts`` under ``root`` when it lies behind a course
    link the registry vouches for, or None.

    A workshop in a linked course resolves outside the JupyterLab root,
    which the path checks otherwise refuse. It is let through only when
    some ancestor is ``<library>/personal/courses/<name>``, that is a
    link, the library's registry lists the course with a target, and the
    link points at that target; and then only for paths inside the
    target. The path is returned unresolved, so it still names the link.
    """

    tree = COURSES_DIRECTORY.split("/")

    for index in range(len(parts) - len(tree)):
        if parts[index : index + len(tree)] != tree:
            continue

        library_dir = root.joinpath(*parts[:index])
        resolved_library = library_dir.resolve()

        if resolved_library != root and root not in resolved_library.parents:
            continue

        name = parts[index + len(tree)]
        link = library_dir / COURSES_DIRECTORY / name

        if not is_link(link):
            continue

        try:
            library = read_library(library_dir, "")
        except LibraryError:
            continue

        target = course_entry(library or {}, name).get("target")

        if not target:
            continue

        real = link.resolve()

        if real != Path(target).expanduser().resolve():
            continue

        lexical = root.joinpath(*parts)
        resolved = lexical.resolve()

        if resolved == real or real in resolved.parents:
            return lexical

    return None


@dataclass(frozen=True)
class UpgradeMove:
    """One tree the upgrade of a library's layout moves."""

    #: The tree's path before the upgrade, relative to the root.
    source: str

    #: Its path afterwards.
    target: str

    #: What it holds, in a few words.
    contents: str

    def to_dict(self) -> dict[str, Any]:
        """A JSON friendly form, as the browser reads it."""

        return {"from": self.source, "to": self.target, "contents": self.contents}


@dataclass(frozen=True)
class UpgradePlan:
    """What upgrading a library from the previous layout does.

    The trees it moves, and the workshops whose isolated environments it
    removes: an environment holds the paths it was made at, so one that
    moved would not work, and it is made again when the workshop is next
    opened.
    """

    moves: list[UpgradeMove]

    #: The workshops, relative to the root, whose environments go.
    environments: list[str]

    def to_dict(self) -> dict[str, Any]:
        """A JSON friendly form, as the browser reads it."""

        return {
            "moves": [move.to_dict() for move in self.moves],
            "environments": list(self.environments),
        }


def plan_upgrade(root_dir: Path, directory: str) -> UpgradePlan | None:
    """What upgrading a library from the previous layout would do, without
    doing it, or None when the directory is not a library or is one in
    the current layout already."""

    library = read_library(root_dir, directory)

    if library is None or not needs_upgrade(library):
        return None

    library_dir = library_directory(root_dir, directory)
    base = normalize_workshops_directory(directory)
    moves: list[UpgradeMove] = []
    environments: list[str] = []

    for old, new, unit in LEGACY_TREES:
        tree = library_dir / old

        if not tree.is_dir():
            continue

        workshops = _legacy_workshops(tree, old, library)
        count = len(_containers(tree)) if unit != "workshop" else len(workshops)

        moves.append(
            UpgradeMove(
                source=_join_path(base, old),
                target=_join_path(base, new),
                contents=f"{count} {unit}{'' if count == 1 else 's'}",
            )
        )

        for workshop in workshops:
            if (workshop / _STATE_DIR / "environment.json").is_file():
                relative = workshop.relative_to(tree).as_posix()

                environments.append(_join_path(base, old, relative))

    return UpgradePlan(moves=moves, environments=environments)


def upgrade_library(root_dir: Path, directory: str) -> UpgradePlan:
    """Move a library from the previous layout to this one.

    Each tree of the previous layout is moved whole to where this release
    keeps it, progress and all, with the environments of the workshops
    it holds removed first, since they hold the paths they were made at;
    the registry is then written in the current format. Nothing is moved
    while anything is in the way, and a tree that is not there is simply
    not moved. Returns what was done.
    """

    from .environment import forget_environment

    plan = plan_upgrade(root_dir, directory)
    library = read_library(root_dir, directory)

    if plan is None or library is None:
        raise LibraryError(
            f"{library_directory(root_dir, directory)} is not a workshop library "
            "in the previous layout"
        )

    library_dir = library_directory(root_dir, directory)

    # The owner's tree is moved into a directory of the same name, so it
    # goes by way of a holding name; any other target in the way is a
    # reason to stop before anything has moved.
    for old, new, _ in LEGACY_TREES:
        target = library_dir / new

        inside_old = old == new.split("/")[0]

        if (library_dir / old).is_dir() and target.exists() and not inside_old:
            raise LibraryError(f"{target} is in the way of the upgrade")

    for path in plan.environments:
        forget_environment(root_dir / path)

    for old, new, _ in LEGACY_TREES:
        tree = library_dir / old

        if not tree.is_dir():
            continue

        target = library_dir / new
        held = library_dir / f".upgrade-{old}"

        try:
            tree.rename(held)
            target.parent.mkdir(parents=True, exist_ok=True)
            held.rename(target)
        except OSError as error:
            raise LibraryError(f"Unable to move {tree} to {target}: {error}") from error

    write_library(root_dir, directory, {**library, "version": LIBRARY_VERSION})

    return plan


def _legacy_workshops(tree: Path, old: str, library: Mapping[str, Any]) -> list[Path]:
    # The workshops a tree of the previous layout holds: directly under
    # the owner's and the standalone trees, one level down for the
    # collections, and wherever each course's own layout says.
    from .collection import MANIFEST_FILE, course_sections

    if old == "collections":
        return [
            workshop
            for collection in _containers(tree)
            for workshop in _containers(collection)
            if (workshop / MANIFEST_FILE).is_file()
        ]

    if old == "projects":
        found: list[Path] = []

        for course in _containers(tree):
            entry = course_entry(library, course.name)

            for _, paths in course_sections(course, entry):
                found.extend(course / path if path else course for path in paths)

        return found

    return [
        workshop
        for workshop in _containers(tree)
        if (workshop / MANIFEST_FILE).is_file()
    ]


def _containers(directory: Path) -> list[Path]:
    # The directories directly under a path, links included, in name order.
    if not directory.is_dir():
        return []

    return sorted(
        child
        for child in directory.iterdir()
        if not child.name.startswith(".") and (child.is_dir() or is_link(child))
    )


def _join_path(*parts: str) -> str:
    return "/".join(part for part in parts if part)


def _make_link(link: Path, target: Path) -> None:
    # A symbolic link where the system allows one; on Windows that needs
    # Developer Mode or an administrator, so fall back to a junction,
    # which any user may make for a directory on a local drive.
    try:
        link.symlink_to(target, target_is_directory=True)

        return
    except OSError as error:
        if sys.platform != "win32":
            raise LibraryError(f"Unable to link {link} to {target}: {error}") from error

    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise LibraryError(
            f"Unable to link {link} to {target}: "
            f"{(result.stderr or result.stdout).strip()}"
        )


def _remove_link(link: Path) -> None:
    # A junction is removed as an empty directory would be, and a
    # symbolic link by unlinking it; neither touches what it points to.
    if link.is_junction():
        os.rmdir(link)
    else:
        link.unlink()


def default_library(
    environ: Mapping[str, str] | None = None, home: Path | None = None
) -> Path:
    """The default library: ``JUPYTER_WORKSHOP_LIBRARY`` when it is set,
    else ``Workshops`` in the home directory."""

    if environ is None:
        environ = os.environ

    configured = environ.get(LIBRARY_VARIABLE, "").strip()

    if configured:
        return Path(configured).expanduser()

    return (home if home is not None else Path.home()) / DEFAULT_LIBRARY_NAME


def _parse_directories(value: Any, location: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise LibraryError(f'{location}: "directories" must be an object')

    directories: dict[str, str] = {}

    for key, directory in value.items():
        if not isinstance(directory, str) or not DIRECTORY_NAME.match(directory):
            raise LibraryError(
                f"{location}: the directory for {key} must be a lower case name"
            )

        directories[str(key)] = directory

    return directories


def _parse_courses(value: Any, location: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise LibraryError(f'{location}: "courses" must be a list')

    courses: list[dict[str, Any]] = []

    for index, item in enumerate(value, start=1):
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("name"), str)
            or not COURSE_NAME.match(item["name"])
        ):
            raise LibraryError(f'{location}: course {index} needs a valid "name"')

        unknown = sorted(set(item) - {"name", "target", "workshops"})

        if unknown:
            raise LibraryError(
                f"{location}: course {item['name']} has unknown keys "
                f"{', '.join(unknown)}"
            )

        course: dict[str, Any] = {"name": item["name"]}

        for key in ("target", "workshops"):
            if key not in item:
                continue

            if not isinstance(item[key], str) or not item[key]:
                raise LibraryError(
                    f'{location}: course {item["name"]} has an invalid "{key}"'
                )

            course[key] = item[key]

        courses.append(course)

    return courses
