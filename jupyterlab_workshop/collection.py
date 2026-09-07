"""Collection indexes and the list of installed workshops.

A collection is a published list of workshops. Its index is a JSON file,
``collection.json`` by convention, listing the workshops in the order they
are shown and where each version can be fetched from, with a title,
description, publisher and icon for the collection itself. The frontend
reads indexes through the server so that they can live on any host
without CORS headers, and so that an index can also be a file under the
server root for local or classroom use. The ``jupyter workshop
collection`` command builds indexes from the entry files that ``jupyter
workshop publish`` writes, and ``jupyter workshop index`` from the
workshops in a repository.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yaml

from .fetch import Downloader, FetchError, _relative, _resolve_inside, download
from .publish import PublishError, flatten_capabilities, read_manifest

COLLECTION_VERSION = 1

#: The file name a collection index is published under by convention.
COLLECTION_FILE = "collection.json"

#: Descriptive fields of a collection, in the order they are written.
METADATA_KEYS = ("title", "description", "publisher", "homepage", "icon", "tags")

MANIFEST_FILE = "workshop.yaml"

STATE_DIR = "_workshop"

MAX_INDEX_BYTES = 5 * 1024 * 1024

#: Directories never searched for workshops when indexing a repository.
INDEX_EXCLUDES = {"node_modules", STATE_DIR, "site", "dist", "build"}

#: Remote URLs in scp-like form, such as git@github.com:org/repo.git.
SCP_REMOTE = re.compile(r"^(?:[^@/]+@)?([^:/]+):(.+)$")


class CollectionError(Exception):
    """A collection index could not be read or built."""


@dataclass(frozen=True)
class CollectionMetadata:
    """The descriptive fields of a collection an author can set.

    An empty value leaves what the existing index says; ``tags`` replaces
    the list when given.
    """

    title: str = ""
    description: str = ""
    publisher: str = ""
    publisher_url: str = ""
    homepage: str = ""
    icon: str = ""
    tags: tuple[str, ...] | None = None

    def apply(self, index: dict[str, Any], existing: dict[str, Any] | None) -> None:
        """Write the metadata into ``index``, keeping ``existing`` values."""

        previous = existing or {}

        for key in ("title", "description", "homepage", "icon"):
            value = getattr(self, key) or previous.get(key)

            if value:
                index[key] = value

        publisher: Any = previous.get("publisher")

        if self.publisher:
            publisher = {"name": self.publisher}

            if self.publisher_url:
                publisher["url"] = self.publisher_url
        elif self.publisher_url and isinstance(publisher, dict):
            publisher = {**publisher, "url": self.publisher_url}

        if publisher:
            index["publisher"] = publisher

        tags = list(self.tags) if self.tags is not None else previous.get("tags")

        if tags:
            index["tags"] = tags


def load_collection(
    location: str, root_dir: Path, downloader: Downloader | None = None
) -> dict[str, Any]:
    """Read a collection index from a URL or a path under the server root.

    The result is checked just enough to be an index of the supported
    version; the frontend validates the entries in full.
    """

    scheme = urlsplit(location).scheme.lower()

    if scheme in {"http", "https"}:
        try:
            data = (downloader or download)(location)
        except FetchError as error:
            raise CollectionError(str(error)) from error

        if len(data) > MAX_INDEX_BYTES:
            raise CollectionError(
                f"The collection at {location} is larger than the limit"
            )

        text = data.decode("utf-8", errors="replace")
    elif scheme:
        raise CollectionError(f"Unsupported collection location {location}")
    else:
        try:
            path = _resolve_inside(root_dir, location)
        except FetchError as error:
            raise CollectionError(str(error)) from error

        if not path.is_file():
            raise CollectionError(f"There is no collection file at {location}")

        text = path.read_text(encoding="utf-8")

    return parse_collection(text, location)


def parse_collection(text: str, location: str = "collection") -> dict[str, Any]:
    """Parse the JSON text of an index and check its version and shape."""

    try:
        data = json.loads(text)
    except ValueError as error:
        raise CollectionError(f"{location} is not valid JSON: {error}") from error

    if not isinstance(data, dict):
        raise CollectionError(f"{location} must contain a JSON object")

    if data.get("version") != COLLECTION_VERSION:
        raise CollectionError(
            f"{location} has collection version {data.get('version')!r}; "
            f"expected {COLLECTION_VERSION}"
        )

    workshops = data.get("workshops")

    if not isinstance(workshops, list) or not all(
        isinstance(item, dict) for item in workshops
    ):
        raise CollectionError(f"{location} needs a list of workshops")

    return data


def collection_metadata(index: dict[str, Any]) -> dict[str, Any]:
    """The descriptive fields of an index, as a catalog restates them."""

    return {key: index[key] for key in METADATA_KEYS if index.get(key)}


def build_collection(
    existing: dict[str, Any] | None,
    entries: Iterable[dict[str, Any]],
    metadata: CollectionMetadata | None = None,
) -> dict[str, Any]:
    """Merge entry records into an index, replacing entries by name.

    The order of the index is kept: an entry already listed is updated in
    place and a new one is appended, so an author can order the file once
    and the tools respect it. Versions of an existing entry are kept and
    combined with the new ones, newest first, so publishing a new version
    adds to the list rather than replacing it.
    """

    workshops: list[dict[str, Any]] = [
        item
        for item in (existing or {}).get("workshops", [])
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    ]
    positions = {item["name"]: index for index, item in enumerate(workshops)}

    for entry in entries:
        name = entry.get("name")

        if not isinstance(name, str) or not name:
            raise CollectionError("Each collection entry needs a name")

        if not isinstance(entry.get("versions"), list) or not entry["versions"]:
            raise CollectionError(f"Collection entry {name} needs at least one version")

        position = positions.get(name)
        previous = workshops[position] if position is not None else {}
        merged = {**previous, **entry}

        merged["versions"] = _merge_versions(
            entry["versions"], previous.get("versions", [])
        )

        if position is None:
            positions[name] = len(workshops)
            workshops.append(merged)
        else:
            workshops[position] = merged

    index: dict[str, Any] = {"version": COLLECTION_VERSION}

    (metadata or CollectionMetadata()).apply(index, existing)
    index["workshops"] = workshops

    return index


def find_workshops(root: Path) -> list[Path]:
    """Find every workshop directory below ``root``, in path order.

    Hidden directories, build outputs and workshop state directories are
    skipped, and a workshop's own subdirectories are not searched.
    """

    found: list[Path] = []

    def walk(directory: Path) -> None:
        if (directory / MANIFEST_FILE).is_file():
            found.append(directory)

            return

        for child in sorted(directory.iterdir()):
            if (
                child.is_dir()
                and not child.name.startswith(".")
                and child.name not in INDEX_EXCLUDES
            ):
                walk(child)

    walk(root)

    return found


def index_entry(directory: Path, subdir: str, repo: str, ref: str) -> dict[str, Any]:
    """Build the collection entry for a workshop fetched from a repository.

    The metadata comes from the manifest and the single version points at
    ``subdir`` of ``repo`` at ``ref``.
    """

    try:
        manifest = read_manifest(directory)
    except PublishError as error:
        raise CollectionError(str(error)) from error

    name = str(manifest.get("name") or "")

    if not name:
        raise CollectionError(f"The manifest in {directory} has no name")

    source: dict[str, str] = {"git": repo, "ref": ref}

    if subdir not in ("", "."):
        source["subdir"] = subdir

    return {
        "name": name,
        "title": manifest.get("title", name),
        "description": manifest.get("description", ""),
        "tags": manifest.get("tags", []),
        "platforms": manifest.get("platforms", []),
        "capabilities": flatten_capabilities(manifest.get("capabilities")),
        "duration": manifest.get("duration", ""),
        "authors": manifest.get("authors", []),
        "versions": [
            {"version": str(manifest.get("version") or "0.0.0"), "source": source}
        ],
    }


def index_repository(
    root: Path,
    directories: Iterable[Path],
    repo: str,
    ref: str,
    existing: dict[str, Any] | None = None,
    metadata: CollectionMetadata | None = None,
) -> dict[str, Any]:
    """Build or update an index of the workshops under ``directories``.

    ``root`` is the repository checkout; each workshop becomes an entry
    whose source is its directory relative to the root, so learners fetch
    it straight from the forge. Entries for names already in ``existing``
    are updated in place, keeping their position and other versions, and
    new ones are appended in the order found.
    """

    root = root.resolve()
    found: list[Path] = []

    for directory in directories:
        resolved = directory.resolve()

        if not resolved.is_dir():
            raise CollectionError(f"{directory} is not a directory")

        if not resolved.is_relative_to(root):
            raise CollectionError(f"{directory} is outside the repository root {root}")

        found.extend(find_workshops(resolved))

    if not found:
        raise CollectionError("No workshop.yaml found in the directories given")

    entries = [
        index_entry(directory, directory.relative_to(root).as_posix(), repo, ref)
        for directory in found
    ]

    return build_collection(existing, entries, metadata)


def checkout_root(path: Path) -> Path | None:
    """The top of the git checkout containing ``path``, or None."""

    output = _git(path, "rev-parse", "--show-toplevel")

    return Path(output) if output else None


def guess_repository(root: Path) -> tuple[str, str]:
    """The origin URL and current branch of the git checkout at ``root``.

    Either is empty when git or the information is unavailable. An SSH
    remote is rewritten as the https URL learners can fetch archives from.
    """

    # The symbolic ref names the branch even before its first commit, and
    # is empty on a detached HEAD, where no branch name would be right.
    remote = _git(root, "remote", "get-url", "origin")
    branch = _git(root, "symbolic-ref", "--short", "HEAD")

    return https_remote(remote), branch


def _git(path: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(path), *args],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return ""

    return result.stdout.strip() if result.returncode == 0 else ""


def https_remote(remote: str) -> str:
    """Rewrite a git remote URL as a plain https URL without ``.git``."""

    if not remote:
        return ""

    if remote.startswith("ssh://"):
        parts = urlsplit(remote)
        remote = f"https://{parts.hostname}{parts.path}"
    elif not re.match(r"^[a-z]+://", remote):
        match = SCP_REMOTE.match(remote)

        if match:
            remote = f"https://{match.group(1)}/{match.group(2)}"

    return remote.removesuffix(".git").rstrip("/")


def list_installed(root_dir: Path, directory: str) -> list[dict[str, Any]]:
    """Describe every workshop directory directly under ``directory``.

    Each record carries the manifest summary, the download source and the
    collection it was installed from when the workshop was fetched, and
    the learner's progress from the state file. Records are in title
    order; the frontend orders them by collection.
    """

    try:
        parent = _resolve_inside(root_dir, directory)
    except FetchError as error:
        raise CollectionError(str(error)) from error

    if not parent.is_dir():
        return []

    records: list[dict[str, Any]] = []

    for child in sorted(parent.iterdir()):
        manifest_path = child / MANIFEST_FILE

        if child.is_dir() and manifest_path.is_file():
            record = describe_installed(root_dir, child)

            if record is not None:
                records.append(record)

    records.sort(key=lambda record: str(record.get("title", "")).lower())

    return records


def describe_installed(root_dir: Path, workshop: Path) -> dict[str, Any] | None:
    """The record for one workshop directory, or None if it is unreadable."""

    try:
        manifest = yaml.safe_load((workshop / MANIFEST_FILE).read_text("utf-8"))
    except (OSError, yaml.YAMLError):
        return None

    if not isinstance(manifest, dict) or not isinstance(manifest.get("name"), str):
        return None

    pages = manifest.get("pages")
    page_count = len(pages) if isinstance(pages, list) else 0
    source = _read_json(workshop / STATE_DIR / "source.json")
    state = _read_json(workshop / STATE_DIR / "state.json")
    raw_progress = state.get("pages")
    progress: dict[str, Any] = raw_progress if isinstance(raw_progress, dict) else {}

    # The frontend records which pages its `when` conditions leave
    # visible; progress counts those, or every page for older state.
    visible = state.get("visiblePages")

    if isinstance(visible, list) and all(isinstance(item, str) for item in visible):
        page_count = len(visible)
        done = len(
            [
                page_id
                for page_id in visible
                if isinstance(progress.get(page_id), dict)
                and progress[page_id].get("done") is True
            ]
        )
    else:
        done = len(
            [
                item
                for item in progress.values()
                if isinstance(item, dict) and item.get("done") is True
            ]
        )

    return {
        "path": _relative(root_dir, workshop),
        "name": manifest["name"],
        "title": str(manifest.get("title") or manifest["name"]),
        "version": str(manifest.get("version") or ""),
        "description": str(manifest.get("description") or ""),
        "tags": [str(tag) for tag in manifest.get("tags") or []],
        "platforms": [str(item) for item in manifest.get("platforms") or []],
        "source": source.get("source")
        if isinstance(source.get("source"), dict)
        else None,
        "sha256": str(source.get("sha256") or ""),
        "collection": str(source.get("collection") or "") or None,
        "pages": page_count,
        "done": done,
        "currentPage": str(state.get("currentPage") or ""),
        "trust": str(state.get("trust") or ""),
        "started": bool(state),
    }


def _merge_versions(
    incoming: list[dict[str, Any]], existing: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    seen: set[str] = set()
    versions: list[dict[str, Any]] = []

    for item in [*incoming, *existing]:
        if not isinstance(item, dict):
            continue

        version = str(item.get("version", ""))

        if version not in seen:
            seen.add(version)
            versions.append({**item, "version": version})

    versions.sort(key=lambda item: _version_key(str(item["version"])), reverse=True)

    return versions


def _version_key(version: str) -> tuple[tuple[int, str], ...]:
    # Numeric parts compare as numbers and anything else as text after
    # them, so 1.10 sorts above 1.9 and pre-release tags sort below.
    parts: list[tuple[int, str]] = []

    for part in version.split("."):
        parts.append((int(part), "") if part.isdigit() else (-1, part))

    return tuple(parts)


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}

    return data if isinstance(data, dict) else {}
