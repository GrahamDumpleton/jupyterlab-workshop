"""Building a distributable archive of a workshop.

Used by ``jupyter workshop publish`` and by the server endpoint behind
the author mode Publish button.
"""

from __future__ import annotations

import hashlib
import json
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

PUBLISH_EXCLUDES = {"_workshop", ".git", ".github", "scratch", "dist", "node_modules"}

#: The learner's workspace directory when the manifest names none.
DEFAULT_WORKSPACE = "work"


class PublishError(Exception):
    """The workshop could not be archived."""


@dataclass(frozen=True)
class PublishResult:
    """What publishing wrote."""

    archive: Path
    sha256: str
    entry_path: Path
    entry: dict[str, Any]

    def to_dict(self, relative_to: Path | None = None) -> dict[str, Any]:
        """The result as JSON, with paths relative to a directory if given."""

        def show(path: Path) -> str:
            if relative_to is None:
                return str(path)

            try:
                return path.resolve().relative_to(relative_to.resolve()).as_posix()
            except ValueError:
                return str(path)

        return {
            "archive": show(self.archive),
            "sha256": self.sha256,
            "entryPath": show(self.entry_path),
            "entry": self.entry,
        }


def read_manifest(directory: Path) -> dict[str, object]:
    """Read ``workshop.yaml`` as a mapping without validating it."""

    try:
        data = yaml.safe_load((directory / "workshop.yaml").read_text(encoding="utf-8"))
    except OSError as error:
        raise PublishError(f"{directory} has no readable workshop.yaml") from error
    except yaml.YAMLError as error:
        raise PublishError(f"workshop.yaml is not valid YAML: {error}") from error

    if not isinstance(data, dict):
        raise PublishError("workshop.yaml must be a mapping")

    return data


def publish_workshop(directory: Path, out: Path, url: str = "") -> PublishResult:
    """Archive a workshop into ``out`` with its hash and a collection entry."""

    manifest = read_manifest(directory)
    name = str(manifest.get("name") or "")
    version = str(manifest.get("version") or "0.0.0")

    if not name:
        raise PublishError("The manifest has no name")

    out.mkdir(parents=True, exist_ok=True)

    archive = out / f"{name}-{version}.tar.gz"

    # The workspace is generated when the workshop opens, so it is no
    # more part of the archive than the state directory is.
    workspace = str(manifest.get("workspace") or DEFAULT_WORKSPACE).strip("/")

    with tarfile.open(archive, "w:gz") as tar:
        for entry in sorted(directory.iterdir()):
            if entry.name in PUBLISH_EXCLUDES or entry.name == workspace:
                continue

            tar.add(entry, arcname=f"{name}-{version}/{entry.name}", filter=_clean_tar)

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()

    (out / f"{archive.name}.sha256").write_text(f"{digest}  {archive.name}\n")

    collection_entry: dict[str, Any] = {
        "name": name,
        "title": manifest.get("title", name),
        "description": manifest.get("description", ""),
        "tags": manifest.get("tags", []),
        "platforms": manifest.get("platforms", []),
        "capabilities": flatten_capabilities(manifest.get("capabilities")),
        "duration": manifest.get("duration", ""),
        "authors": manifest.get("authors", []),
        **manifest_links(manifest),
        "versions": [
            {
                "version": version,
                "source": {"archive": url or f"<url of {archive.name}>"},
                "sha256": digest,
            }
        ],
    }
    entry_path = out / f"{name}-{version}.collection.json"

    entry_path.write_text(json.dumps(collection_entry, indent=2) + "\n")

    return PublishResult(
        archive=archive,
        sha256=digest,
        entry_path=entry_path,
        entry=collection_entry,
    )


def manifest_links(manifest: dict[str, Any]) -> dict[str, str]:
    """The ``homepage`` and ``issues`` links of a manifest, as collection
    entry fields, leaving out any that are absent or empty."""

    links: dict[str, str] = {}

    for field in ("homepage", "issues"):
        value = manifest.get(field)

        if value:
            links[field] = str(value)

    return links


def flatten_capabilities(value: object) -> list[str]:
    """Flatten manifest capabilities to ``name`` and ``name:scope`` strings."""

    # The manifest writes scoped capabilities as single-key mappings; the
    # collection lists them as name:scope strings.
    names: list[str] = []

    if not isinstance(value, list):
        return names

    for item in value:
        if isinstance(item, str):
            names.append(item)
        elif isinstance(item, dict):
            for key, scopes in item.items():
                listed = scopes if isinstance(scopes, list) else [scopes]

                names.extend(f"{key}:{scope}" for scope in listed)

    return names


def _clean_tar(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    # Leave out editor and OS droppings and normalise ownership so the
    # archive hash is stable across machines.
    base = Path(info.name).name

    if base in {".DS_Store", "Thumbs.db"} or base.endswith("~"):
        return None

    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0

    return info
