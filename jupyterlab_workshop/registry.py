"""Registry indexes and the list of installed workshops.

A registry index is a JSON file listing workshops and where each version
can be fetched from. The frontend reads indexes through the server so that
they can live on any host without CORS headers, and so that an index can
also be a file under the server root for local or classroom use. The
``jupyter workshop registry`` command builds indexes from the entry files
that ``jupyter workshop publish`` writes.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yaml

from .fetch import Downloader, FetchError, _relative, _resolve_inside, download

REGISTRY_VERSION = 1

MANIFEST_FILE = "workshop.yaml"

STATE_DIR = "_workshop"

MAX_INDEX_BYTES = 5 * 1024 * 1024


class RegistryError(Exception):
    """A registry index could not be read or built."""


def load_registry(
    location: str, root_dir: Path, downloader: Downloader | None = None
) -> dict[str, Any]:
    """Read a registry index from a URL or a path under the server root.

    The result is checked just enough to be an index of the supported
    version; the frontend validates the entries in full.
    """

    scheme = urlsplit(location).scheme.lower()

    if scheme in {"http", "https"}:
        try:
            data = (downloader or download)(location)
        except FetchError as error:
            raise RegistryError(str(error)) from error

        if len(data) > MAX_INDEX_BYTES:
            raise RegistryError(f"The registry at {location} is larger than the limit")

        text = data.decode("utf-8", errors="replace")
    elif scheme:
        raise RegistryError(f"Unsupported registry location {location}")
    else:
        try:
            path = _resolve_inside(root_dir, location)
        except FetchError as error:
            raise RegistryError(str(error)) from error

        if not path.is_file():
            raise RegistryError(f"There is no registry file at {location}")

        text = path.read_text(encoding="utf-8")

    return parse_registry(text, location)


def parse_registry(text: str, location: str = "registry") -> dict[str, Any]:
    """Parse the JSON text of an index and check its version and shape."""

    try:
        data = json.loads(text)
    except ValueError as error:
        raise RegistryError(f"{location} is not valid JSON: {error}") from error

    if not isinstance(data, dict):
        raise RegistryError(f"{location} must contain a JSON object")

    if data.get("version") != REGISTRY_VERSION:
        raise RegistryError(
            f"{location} has registry version {data.get('version')!r}; "
            f"expected {REGISTRY_VERSION}"
        )

    workshops = data.get("workshops")

    if not isinstance(workshops, list) or not all(
        isinstance(item, dict) for item in workshops
    ):
        raise RegistryError(f"{location} needs a list of workshops")

    return data


def build_registry(
    existing: dict[str, Any] | None,
    entries: Iterable[dict[str, Any]],
    title: str | None = None,
) -> dict[str, Any]:
    """Merge entry records into an index, replacing entries by name.

    Versions of an existing entry are kept and combined with the new ones,
    newest first, so publishing a new version adds to the list rather
    than replacing it.
    """

    workshops: dict[str, dict[str, Any]] = {}

    for item in (existing or {}).get("workshops", []):
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            workshops[item["name"]] = item

    for entry in entries:
        name = entry.get("name")

        if not isinstance(name, str) or not name:
            raise RegistryError("Each registry entry needs a name")

        if not isinstance(entry.get("versions"), list) or not entry["versions"]:
            raise RegistryError(f"Registry entry {name} needs at least one version")

        previous = workshops.get(name, {})
        merged = {**previous, **entry}

        merged["versions"] = _merge_versions(
            entry["versions"], previous.get("versions", [])
        )
        workshops[name] = merged

    index: dict[str, Any] = {"version": REGISTRY_VERSION}
    chosen_title = title or (existing or {}).get("title")

    if chosen_title:
        index["title"] = chosen_title

    index["workshops"] = [workshops[name] for name in sorted(workshops)]

    return index


def list_installed(root_dir: Path, directory: str) -> list[dict[str, Any]]:
    """Describe every workshop directory directly under ``directory``.

    Each record carries the manifest summary, the download source when the
    workshop was fetched, and the learner's progress from the state file.
    """

    try:
        parent = _resolve_inside(root_dir, directory)
    except FetchError as error:
        raise RegistryError(str(error)) from error

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
