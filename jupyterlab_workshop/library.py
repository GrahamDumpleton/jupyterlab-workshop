"""Workshop libraries: a workshops directory with a registry of its own.

A library is the workshops directory, ``<JupyterLab root>/<workshops
directory>``, when it holds ``library.json``. The registry records the
collections and catalogs its owner subscribes to, in order, the
directory under ``installed/`` each collection's workshops go into, and
the projects whose workshops it shows. Downloaded workshops live under
``installed/<collection>/``, the owner's own under ``personal/``, and
repositories being worked on under ``projects/``. A workshops directory
without the registry is a plain one and behaves exactly as before.

The browser applies the same rules through the core package's
``library`` module; the two must choose the same directory names, which
the shared test vectors check.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

from .collection import collection_hash, normalize_location

#: The registry file that makes a workshops directory a library.
LIBRARY_FILE = "library.json"

#: The registry format version this package understands.
LIBRARY_VERSION = 1

#: Where downloaded workshops go, one directory per collection.
INSTALLED_DIRECTORY = "installed"

#: Where the owner's own workshops go.
PERSONAL_DIRECTORY = "personal"

#: Where projects go, cloned in or linked from elsewhere.
PROJECTS_DIRECTORY = "projects"

#: A project's workshops directory when its entry does not name one.
DEFAULT_PROJECT_WORKSHOPS = "workshops"

#: The environment variable naming the default library.
LIBRARY_VARIABLE = "JUPYTER_WORKSHOP_LIBRARY"

#: The default library's directory under the home directory.
DEFAULT_LIBRARY_NAME = "Workshops"

#: The longest slug made from a collection id, before any suffix.
MAX_SLUG = 64

PROJECT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

DIRECTORY_NAME = re.compile(r"^[a-z0-9][a-z0-9.-]*$")

#: Names Windows refuses for a file or directory, whatever follows a dot.
RESERVED = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{number}" for number in range(1, 10)}
    | {f"lpt{number}" for number in range(1, 10)}
)

#: The order keys are written in, matching the browser's writes.
KEY_ORDER = ("version", "collections", "catalogs", "directories", "projects")


class LibraryError(Exception):
    """A registry that cannot be read, written or understood."""


def empty_library() -> dict[str, Any]:
    """A new, empty registry."""

    return {"version": LIBRARY_VERSION}


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


def is_library(root_dir: Path, directory: str) -> bool:
    """Whether a workshops directory is a library: whether it has a registry."""

    return library_file(root_dir, directory).is_file()


def parse_library(data: Any, location: str = LIBRARY_FILE) -> dict[str, Any]:
    """Validate the JSON value of a registry and return it in normal form.

    The checks are made here rather than against the bundled schema,
    which a source checkout may not have built, and they match what the
    schema and the browser's parser accept.
    """

    if not isinstance(data, dict):
        raise LibraryError(f"{location} must contain an object")

    if data.get("version") != LIBRARY_VERSION:
        raise LibraryError(
            f"{location} has unsupported version {data.get('version')!r}, "
            f"expected {LIBRARY_VERSION}"
        )

    unknown = sorted(set(data) - set(KEY_ORDER))

    if unknown:
        raise LibraryError(f"{location} has unknown keys {', '.join(unknown)}")

    library: dict[str, Any] = {"version": LIBRARY_VERSION}

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

    if "projects" in data:
        library["projects"] = _parse_projects(data["projects"], location)

    return library


def serialize_library(library: Mapping[str, Any]) -> str:
    """The text of a registry: two space indents, a final newline, and the
    keys in a fixed order, so the browser and the CLI write the same file."""

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
    copy. Raises when the directory is not a library.
    """

    library = read_library(root_dir, directory)

    if library is None:
        raise LibraryError(
            f"{library_directory(root_dir, directory)} is not a workshop library"
        )

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


def choose_collection_directory(
    location: str, collection_id: str | None, taken: Iterable[str]
) -> str:
    """The directory under ``installed/`` for a collection that has none.

    The slug of its id, with the location's hash appended when another
    collection has that directory already, or the hash alone when there
    is no usable id.
    """

    digest = collection_hash(location)
    slug = slugify_collection_id(collection_id) if collection_id else None

    if slug is None:
        return digest

    used = {name.lower() for name in taken}

    return f"{slug}-{digest}" if slug in used else slug


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
    directory = choose_collection_directory(
        location, collection_id, directories.values()
    )

    directories[location] = directory

    return directory, {**library, "directories": directories}


def project_entry(library: Mapping[str, Any], name: str) -> dict[str, Any]:
    """The registry entry for a project, or a bare one if it has none."""

    for project in library.get("projects") or []:
        if project.get("name") == name:
            return dict(project)

    return {"name": name}


def project_workshops(project: Mapping[str, Any]) -> str:
    """A project's workshops directory, relative to the project."""

    return str(project.get("workshops") or DEFAULT_PROJECT_WORKSHOPS)


def is_link(path: Path) -> bool:
    """Whether a path is a symbolic link or, on Windows, a directory junction."""

    return path.is_symlink() or path.is_junction()


def link_project(
    library_dir: Path,
    target: Path,
    name: str | None = None,
    workshops: str | None = None,
) -> dict[str, Any]:
    """Link a directory kept outside the library in as a project.

    Makes ``projects/<name>`` a symbolic link to ``target``, or a
    directory junction on Windows where a symbolic link needs rights a
    user may not have, and records the project in the registry with its
    target, which is what makes the link trusted. Returns the entry.
    """

    target = target.expanduser().resolve()
    name = name or target.name

    if not PROJECT_NAME.match(name):
        raise LibraryError(
            f"{name!r} is not a usable project name; give one with --name"
        )

    if not target.is_dir():
        raise LibraryError(f"{target} is not a directory")

    link = library_dir / PROJECTS_DIRECTORY / name

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

    def change(library: dict[str, Any]) -> dict[str, Any]:
        others = [
            project
            for project in library.get("projects") or []
            if project.get("name") != name
        ]

        return {**library, "projects": [*others, entry]}

    update_library(library_dir, "", change)

    return entry


def unlink_project(library_dir: Path, name: str) -> dict[str, Any]:
    """Remove a linked project's link and its registry entry.

    Only the link is removed, never anything it points to, and a link
    whose target has gone is removed all the same. Returns the entry
    that was removed.
    """

    library = read_library(library_dir, "")

    if library is None:
        raise LibraryError(f"{library_dir} is not a workshop library")

    entry = project_entry(library, name)

    if "target" not in entry:
        raise LibraryError(f"{name} is not a linked project")

    link = library_dir / PROJECTS_DIRECTORY / name

    if is_link(link):
        _remove_link(link)
    elif link.exists():
        raise LibraryError(f"{link} is not a link, so it is left in place")

    update_library(
        library_dir,
        "",
        lambda current: {
            **current,
            "projects": [
                project
                for project in current.get("projects") or []
                if project.get("name") != name
            ],
        },
    )

    return entry


def repair_links(library_dir: Path) -> list[str]:
    """Recreate the links of linked projects whose link has gone but whose
    target is still there. Returns the names of the projects relinked."""

    library = read_library(library_dir, "")

    if library is None:
        return []

    relinked: list[str] = []

    for project in library.get("projects") or []:
        target = project.get("target")
        link = library_dir / PROJECTS_DIRECTORY / str(project["name"])

        if not target or is_link(link) or link.exists():
            continue

        if Path(target).is_dir():
            link.parent.mkdir(parents=True, exist_ok=True)
            _make_link(link, Path(target))
            relinked.append(str(project["name"]))

    return relinked


def linked_project_path(root: Path, parts: list[str]) -> Path | None:
    """The path for ``parts`` under ``root`` when it lies behind a project
    link the registry vouches for, or None.

    A workshop in a linked project resolves outside the JupyterLab root,
    which the path checks otherwise refuse. It is let through only when
    some ancestor is ``<library>/projects/<name>``, that is a link, the
    library's registry lists the project with a target, and the link
    points at that target; and then only for paths inside the target.
    The path is returned unresolved, so it still names the link.
    """

    for index, part in enumerate(parts[:-1]):
        if part != PROJECTS_DIRECTORY or index + 1 >= len(parts):
            continue

        library_dir = root.joinpath(*parts[:index])
        resolved_library = library_dir.resolve()

        if resolved_library != root and root not in resolved_library.parents:
            continue

        name = parts[index + 1]
        link = library_dir / PROJECTS_DIRECTORY / name

        if not is_link(link):
            continue

        try:
            library = read_library(library_dir, "")
        except LibraryError:
            continue

        target = project_entry(library or {}, name).get("target")

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


def _parse_projects(value: Any, location: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise LibraryError(f'{location}: "projects" must be a list')

    projects: list[dict[str, Any]] = []

    for index, item in enumerate(value, start=1):
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("name"), str)
            or not PROJECT_NAME.match(item["name"])
        ):
            raise LibraryError(f'{location}: project {index} needs a valid "name"')

        unknown = sorted(set(item) - {"name", "target", "workshops"})

        if unknown:
            raise LibraryError(
                f"{location}: project {item['name']} has unknown keys "
                f"{', '.join(unknown)}"
            )

        project: dict[str, Any] = {"name": item["name"]}

        for key in ("target", "workshops"):
            if key not in item:
                continue

            if not isinstance(item[key], str) or not item[key]:
                raise LibraryError(
                    f'{location}: project {item["name"]} has an invalid "{key}"'
                )

            project[key] = item[key]

        projects.append(project)

    return projects
