"""Install every workshop of a collection from the command line.

The ``jupyter workshop install`` command is the browser's Install all for
images and scripts: it reads a collection index, skips what is installed
already, downloads the rest one at a time into the workshops directory
and records the collection each came from, with the same directory
naming as the browser so a later session matches the installs to their
entries. Everything is a plain function with the downloader as a
parameter so the tests need no network.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .collection import (
    CollectionError,
    collection_hash,
    list_installed,
    load_collection,
    same_location,
)
from .fetch import (
    Downloader,
    FetchError,
    _resolve_inside,
    fetch_workshop,
    parse_source,
    remove_tree,
    remove_workshop,
)
from .library import (
    INSTALLED_DIRECTORY,
    LibraryError,
    assign_collection_directory,
    is_library,
    normalize_workshops_directory,
    update_library,
)

#: Where the browser installs to when the settings do not say.
DEFAULT_DIRECTORY = "workshops"

Reporter = Callable[[str], None]


@dataclass(frozen=True)
class InstallOutcome:
    """What happened to one entry of the collection."""

    name: str
    title: str

    #: ``installed``, ``skipped`` or ``failed``.
    status: str

    #: The directory it landed in, or why it was skipped or failed.
    detail: str


def is_installed_from(record: dict[str, Any], collection: str, name: str) -> bool:
    """Whether an installed record is a collection's entry of that name.

    A record that names its collection must name this one; a record with
    none, a local directory or an older install, matches by name alone,
    as the browser does.
    """

    # A workshop library's own and project workshops are never a
    # collection's, whatever they are called.
    if record.get("name") != name or record.get("kind") in {"personal", "project"}:
        return False

    recorded = record.get("collection")

    return not recorded or same_location(str(recorded), collection)


def install_name(
    name: str, collection: str, installed: Sequence[dict[str, Any]]
) -> str:
    """The directory to install under: the entry's name, or the name with
    the collection's hash appended when another collection's workshop of
    that name is installed already."""

    clash = any(
        record.get("name") == name
        and record.get("collection")
        and not same_location(str(record["collection"]), collection)
        for record in installed
    )

    return f"{name}-{collection_hash(collection)}" if clash else name


def install_destination(
    root_dir: Path,
    directory: str,
    collection: str,
    collection_id: str | None,
    name: str,
    installed: Sequence[dict[str, Any]],
) -> tuple[str, str]:
    """Where a collection's workshop is installed: the directory, relative
    to the root, and the name of the workshop's directory within it.

    In a workshop library each collection has a directory of its own
    under ``installed/``, chosen from its id the first time and recorded
    in the registry, so workshops of the same name from two collections
    never clash. In a plain workshops directory the workshop goes
    directly in it, named as the browser names it there.
    """

    if not is_library(root_dir, directory):
        return directory, install_name(name, collection, installed)

    chosen: dict[str, str] = {}

    def change(library: dict[str, Any]) -> dict[str, Any]:
        chosen["directory"], updated = assign_collection_directory(
            library, collection, collection_id
        )

        return updated

    update_library(root_dir, directory, change)

    parts = [normalize_workshops_directory(directory), INSTALLED_DIRECTORY]

    return "/".join(part for part in [*parts, chosen["directory"]] if part), name


def subscribe(
    root_dir: Path, directory: str, location: str, kind: str = "collections"
) -> bool:
    """Add a collection or catalog to a workshop library's subscriptions.

    ``kind`` is ``collections`` or ``catalogs``. A location the library
    already subscribes to, however it is spelled, is left where it is.
    Returns whether the subscriptions changed. Raises LibraryError when
    the directory is not a library.
    """

    added: list[bool] = []

    def change(library: dict[str, Any]) -> dict[str, Any]:
        current = list(library.get(kind) or [])

        if any(same_location(item, location) for item in current):
            return library

        added.append(True)

        return {**library, kind: [*current, location]}

    update_library(root_dir, directory, change)

    return bool(added)


def unsubscribe(
    root_dir: Path, directory: str, location: str, kind: str = "collections"
) -> bool:
    """Remove a collection or catalog from a workshop library's
    subscriptions, matched however it is spelled. Returns whether it was
    subscribed. Raises LibraryError when the directory is not a library."""

    removed: list[bool] = []

    def change(library: dict[str, Any]) -> dict[str, Any]:
        current = list(library.get(kind) or [])
        kept = [item for item in current if not same_location(item, location)]

        if len(kept) == len(current):
            return library

        removed.append(True)

        return {**library, kind: kept}

    update_library(root_dir, directory, change)

    return bool(removed)


def collection_location(location: str, root_dir: Path) -> tuple[str, str, Path]:
    """Where to read a collection from and how to record it.

    Returns the location to load (a URL, or a file name relative to its
    directory), the location to record with each install, and the root
    the loader resolves the file against. A file under the JupyterLab
    root is recorded by its path relative to the root, which is what a
    browser subscribed to the same file would record; any other file is
    recorded by its absolute path.
    """

    if urlsplit(location).scheme.lower() in {"http", "https"}:
        return location, location, root_dir

    path = Path(location).resolve()

    try:
        recorded = path.relative_to(root_dir.resolve()).as_posix()
    except ValueError:
        recorded = path.as_posix()

    return path.name, recorded, path.parent


def install_collection(
    location: str,
    root_dir: Path,
    directory: str = DEFAULT_DIRECTORY,
    only: Sequence[str] = (),
    platform: str = "",
    frontend: str = "",
    downloader: Downloader | None = None,
    report: Reporter | None = None,
) -> list[InstallOutcome]:
    """Install the workshops of a collection that are not installed yet.

    Entries are taken in the collection's order. ``only`` restricts the
    run to the named workshops, ``platform`` skips entries that list
    platforms without it, and ``frontend`` skips entries that do not
    support it, where an entry listing no frontends supports JupyterLab
    only. JupyterLite is a frontend rather than an operating system, so
    for it the platforms list is not consulted and the frontends list
    alone decides. Each outcome is reported as it happens through
    ``report`` when given, and the list of outcomes is returned; the
    caller decides what a failure means.
    """

    load_as, recorded, load_root = collection_location(location, root_dir)
    outcomes: list[InstallOutcome] = []

    def note(outcome: InstallOutcome) -> None:
        outcomes.append(outcome)

        if report is not None:
            report(f"{outcome.status} {outcome.name}: {outcome.detail}")

    try:
        index = load_collection(load_as, load_root, downloader)
        installed = list_installed(root_dir, directory, library=True)
    except CollectionError as error:
        raise FetchError(str(error)) from error

    collection_id = str(index.get("id") or "") or None

    # In a workshop library an install subscribes to its collection, so
    # the browser lists it and orders its workshops by the collection.
    if is_library(root_dir, directory):
        try:
            subscribe(root_dir, directory, recorded)
        except LibraryError as error:
            raise FetchError(str(error)) from error

    wanted = set(only)
    unknown = wanted - {
        str(entry.get("name") or "") for entry in index.get("workshops", [])
    }

    if unknown:
        raise FetchError("The collection does not list " + ", ".join(sorted(unknown)))

    for entry in index.get("workshops", []):
        name = str(entry.get("name") or "")
        title = str(entry.get("title") or name)

        if wanted and name not in wanted:
            continue

        if any(is_installed_from(record, recorded, name) for record in installed):
            note(InstallOutcome(name, title, "skipped", "installed already"))

            continue

        platforms = [str(item) for item in entry.get("platforms") or []]

        # JupyterLite is a frontend rather than an operating system, so
        # the platforms list is not held against an entry there and the
        # frontends list below decides.
        if (
            platform
            and platforms
            and platform not in platforms
            and frontend != "jupyterlite"
        ):
            note(InstallOutcome(name, title, "skipped", f"not for {platform}"))

            continue

        frontends = [str(item) for item in entry.get("frontends") or []] or [
            "jupyterlab"
        ]

        if frontend and frontend not in frontends:
            note(InstallOutcome(name, title, "skipped", f"not for {frontend}"))

            continue

        # The newest version is the first listed, as the browser installs.
        versions = entry.get("versions") or []
        chosen = versions[0] if versions and isinstance(versions[0], dict) else {}
        spec = dict(chosen.get("source") or {})

        if chosen.get("sha256"):
            spec["sha256"] = chosen["sha256"]

        try:
            source = parse_source(spec)
            destination, directory_name = install_destination(
                root_dir, directory, recorded, collection_id, name, installed
            )
            result = fetch_workshop(
                source,
                root_dir,
                destination,
                name=directory_name,
                downloader=downloader,
                collection=recorded,
            )
        except (FetchError, LibraryError) as error:
            note(InstallOutcome(name, title, "failed", str(error)))

            continue

        # Later clashes see this install the way a fresh listing would.
        installed.append({"name": name, "collection": recorded})
        note(InstallOutcome(name, title, "installed", result.path))

    return outcomes


@dataclass(frozen=True)
class Update:
    """A newer version of an installed workshop that its collection offers."""

    #: The installed workshop's record, as ``list_installed`` gives it.
    record: dict[str, Any]

    #: The collection entry's newest version.
    version: str

    #: Where that version is fetched from, as the index gives it.
    source: dict[str, Any]


def select_installed(
    records: Sequence[dict[str, Any]], wanted: Sequence[str]
) -> list[dict[str, Any]]:
    """The installed records named by path or by workshop name, in the
    order named; all of them when nothing is named.

    A name two installs share, such as the same workshop from two
    collections in a library, is refused as ambiguous, so the caller
    names the path instead.
    """

    if not wanted:
        return list(records)

    chosen: list[dict[str, Any]] = []

    for item in wanted:
        by_path = [record for record in records if record["path"] == item]
        matches = by_path or [record for record in records if record["name"] == item]

        if not matches:
            raise FetchError(f"No installed workshop is called {item}")

        if len(matches) > 1:
            paths = ", ".join(record["path"] for record in matches)

            raise FetchError(f"{item} is ambiguous; name one of {paths}")

        if matches[0] not in chosen:
            chosen.append(matches[0])

    return chosen


def find_updates(
    root_dir: Path,
    records: Sequence[dict[str, Any]],
    downloader: Downloader | None = None,
) -> list[Update]:
    """The installed workshops whose collection offers another version.

    Only workshops installed from a collection can be updated, as in the
    browser, and only when the newest version the collection lists
    differs from the installed one. Each collection is read once.
    """

    indexes: dict[str, dict[str, Any] | None] = {}
    updates: list[Update] = []

    for record in records:
        location = record.get("collection")

        if not location or record.get("kind") in {"personal", "project"}:
            continue

        if location not in indexes:
            try:
                indexes[location] = load_collection(location, root_dir, downloader)
            except CollectionError:
                indexes[location] = None

        index = indexes[location]

        if index is None:
            continue

        entry = next(
            (
                item
                for item in index.get("workshops", [])
                if item.get("name") == record["name"]
            ),
            None,
        )
        versions = (entry or {}).get("versions") or []

        if not versions or not isinstance(versions[0], dict):
            continue

        newest = versions[0]
        version = str(newest.get("version") or "")

        if version and version != record.get("version"):
            spec = dict(newest.get("source") or {})

            if newest.get("sha256"):
                spec["sha256"] = newest["sha256"]

            updates.append(Update(record, version, spec))

    return updates


def apply_update(
    root_dir: Path, update: Update, downloader: Downloader | None = None
) -> str:
    """Install the newer version in place of the installed one.

    The workshop is fetched into the same directory under the same name,
    replacing it, which resets its progress as the browser's Update does.
    Returns the path it is installed at.
    """

    path = str(update.record["path"])
    parent, _, name = path.rpartition("/")
    result = fetch_workshop(
        parse_source(update.source),
        root_dir,
        parent,
        name=name,
        overwrite=True,
        downloader=downloader,
        collection=str(update.record.get("collection") or ""),
    )

    return result.path


def remove_installed(root_dir: Path, record: dict[str, Any]) -> str:
    """Remove an installed workshop as the browser does.

    A workshop the extension downloaded is deleted whole. Any other, a
    local directory, the library owner's own or a project's, may hold
    work that is nowhere else, so only its recorded progress goes.
    Returns what was removed: the workshop's path, or its state directory.
    """

    source = record.get("source")

    if isinstance(source, dict) and source.get("kind") not in {None, "local"}:
        return remove_workshop(root_dir, str(record["path"]))

    state = _resolve_inside(root_dir, str(record["path"])) / "_workshop"

    if state.is_dir():
        remove_tree(state)

    return f"{record['path']}/_workshop"
