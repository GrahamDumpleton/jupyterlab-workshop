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

import hashlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .collection import CollectionError, list_installed, load_collection
from .fetch import Downloader, FetchError, fetch_workshop, parse_source

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


def normalize_location(location: str) -> str:
    """The form of a collection location the browser compares by.

    Mirrors the core package: surrounding space and trailing slashes go,
    and for an http(s) URL the scheme and host are lower-cased.
    """

    trimmed = location.strip().rstrip("/")
    parts = urlsplit(trimmed)

    if parts.scheme.lower() not in {"http", "https"}:
        return trimmed

    query = f"?{parts.query}" if parts.query else ""

    return f"{parts.scheme.lower()}://{parts.netloc.lower()}{parts.path}{query}"


def same_location(a: str, b: str) -> bool:
    """Whether two collection locations name the same collection."""

    return normalize_location(a) == normalize_location(b)


def collection_hash(location: str) -> str:
    """The short hash the browser appends to a directory name on a clash."""

    digest = hashlib.sha256(normalize_location(location).encode("utf-8"))

    return digest.hexdigest()[:7]


def is_installed_from(record: dict[str, Any], collection: str, name: str) -> bool:
    """Whether an installed record is a collection's entry of that name.

    A record that names its collection must name this one; a record with
    none, a local directory or an older install, matches by name alone,
    as the browser does.
    """

    if record.get("name") != name:
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
    downloader: Downloader | None = None,
    report: Reporter | None = None,
) -> list[InstallOutcome]:
    """Install the workshops of a collection that are not installed yet.

    Entries are taken in the collection's order. ``only`` restricts the
    run to the named workshops and ``platform`` skips entries that list
    platforms without it. Each outcome is reported as it happens through
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
        installed = list_installed(root_dir, directory)
    except CollectionError as error:
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

        if platform and platforms and platform not in platforms:
            note(InstallOutcome(name, title, "skipped", f"not for {platform}"))

            continue

        # The newest version is the first listed, as the browser installs.
        versions = entry.get("versions") or []
        chosen = versions[0] if versions and isinstance(versions[0], dict) else {}
        spec = dict(chosen.get("source") or {})

        if chosen.get("sha256"):
            spec["sha256"] = chosen["sha256"]

        try:
            source = parse_source(spec)
            result = fetch_workshop(
                source,
                root_dir,
                directory,
                name=install_name(name, recorded, installed),
                downloader=downloader,
                collection=recorded,
            )
        except FetchError as error:
            note(InstallOutcome(name, title, "failed", str(error)))

            continue

        # Later clashes see this install the way a fresh listing would.
        installed.append({"name": name, "collection": recorded})
        note(InstallOutcome(name, title, "installed", result.path))

    return outcomes
