"""The tree file of a workshop published as a gist.

A gist holds no directories, so ``jupyter workshop gist`` stores each
file under a flat name and writes ``workshop-tree.json`` beside them,
mapping every workshop-relative path to the gist file that holds it. A
download of the gist puts each file back at its path, so the workshop
arrives exactly as it was written. The map is authoritative: a gist file
it does not list is left out.

The map comes from the gist, so it is untrusted: every path must stay
inside the workshop directory, and nothing may be written into the
workshop's state directory. The rules are the core package's
``parseWorkshopTree``, which JupyterLite applies in the browser.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TREE_FILE = "workshop-tree.json"

TREE_VERSION = 1

MANIFEST_FILE = "workshop.yaml"

#: The extension's state directory, which a download never writes into.
STATE_DIR = "_workshop"

#: The one encoding a gist file may hold content in.
BASE64 = "base64"

_ENTRY_KEYS = {"path", "name", "encoding", "empty"}

_BASE64_TEXT = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")


class TreeError(Exception):
    """A tree file is malformed or would write somewhere it must not."""


@dataclass(frozen=True)
class TreeEntry:
    """One file of the workshop and where the gist holds it."""

    #: Workshop-relative POSIX path the file is restored to.
    path: str

    #: The gist file holding the content; empty for an empty file.
    name: str = ""

    #: ``base64`` when the gist file holds an encoding of the content.
    encoding: str = ""

    #: Set for an empty file, which a gist cannot hold.
    empty: bool = False

    def to_dict(self) -> dict[str, Any]:
        """The entry as the tree file holds it."""

        if self.empty:
            return {"path": self.path, "empty": True}

        entry: dict[str, Any] = {"path": self.path, "name": self.name}

        if self.encoding:
            entry["encoding"] = self.encoding

        return entry


def tree_document(entries: list[TreeEntry]) -> dict[str, Any]:
    """The JSON value of a tree file listing ``entries``."""

    return {"version": TREE_VERSION, "files": [entry.to_dict() for entry in entries]}


def parse_tree(data: object) -> list[TreeEntry]:
    """Validate the JSON value of a tree file and return its entries.

    Anything that could write outside the workshop directory or into its
    state directory is refused, as is anything that leaves the result
    ambiguous: two entries for one path (compared without case, as macOS
    and Windows file systems do), a path that is both a file and a
    directory, or two entries reading one gist file. The first problem
    found is raised, naming the entry.
    """

    if not isinstance(data, dict):
        raise TreeError(f"{TREE_FILE} must be an object")

    if data.get("version") != TREE_VERSION:
        raise TreeError(
            f"Unsupported {TREE_FILE} version {data.get('version')!r}, "
            f"expected {TREE_VERSION}"
        )

    files = data.get("files")

    if not isinstance(files, list):
        raise TreeError(f'{TREE_FILE} needs a "files" list')

    entries = [_parse_entry(item, index) for index, item in enumerate(files)]

    # Paths are compared folded, since a case-insensitive file system
    # would write two that differ only in case to the same file.
    paths: dict[str, str] = {}
    names: dict[str, str] = {}

    for entry in entries:
        folded = entry.path.lower()

        if folded in paths:
            raise TreeError(
                f"{TREE_FILE} lists {entry.path} and {paths[folded]}, "
                "which are the same file"
            )

        paths[folded] = entry.path

        if entry.name:
            taken = names.get(entry.name.lower())

            if taken is not None:
                raise TreeError(
                    f"{TREE_FILE} reads {entry.name} for both {taken} and {entry.path}"
                )

            names[entry.name.lower()] = entry.path

    # A path that is also the directory of another cannot be both.
    for entry in entries:
        parts = entry.path.lower().split("/")

        for end in range(1, len(parts)):
            directory = paths.get("/".join(parts[:end]))

            if directory is not None:
                raise TreeError(
                    f"{TREE_FILE} lists {directory} as a file and as the "
                    f"directory of {entry.path}"
                )

    if MANIFEST_FILE not in paths:
        raise TreeError(f"{TREE_FILE} does not list {MANIFEST_FILE}")

    return entries


def is_restorable_path(value: str) -> bool:
    """Whether a value is a workshop-relative path a download may write.

    It must be a relative POSIX path with no empty, ``.`` or ``..``
    parts, no backslash or drive letter, outside the state directory and
    not inside a ``.git`` directory.
    """

    if (
        not value
        or "\\" in value
        or "\0" in value
        or value.startswith("/")
        or re.match(r"^[A-Za-z]:", value)
    ):
        return False

    parts = value.split("/")

    if any(part in {"", ".", ".."} for part in parts):
        return False

    if parts[0].lower() == STATE_DIR:
        return False

    if any(part.lower() == ".git" for part in parts):
        return False

    return value != TREE_FILE


def decode_base64(text: str) -> bytes:
    """The bytes a base64 gist file holds, ignoring its line breaks."""

    cleaned = "".join(text.split())

    if len(cleaned) % 4 or not _BASE64_TEXT.match(cleaned):
        raise TreeError("The content is not valid base64")

    try:
        return base64.b64decode(cleaned, validate=True)
    except binascii.Error as error:
        raise TreeError("The content is not valid base64") from error


def restore_tree(source: Path, target: Path) -> None:
    """Put the flat files in ``source`` back at their paths under ``target``.

    ``source`` holds the gist's files with ``workshop-tree.json`` among
    them; ``target`` must not exist yet. Every entry is checked, and
    every gist file read, before anything is written, so a bad tree
    leaves nothing behind. Gist files the tree does not list, the
    generated README among them, are left out.
    """

    try:
        data = json.loads((source / TREE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise TreeError(f"Unable to read {TREE_FILE}: {error}") from error

    entries = parse_tree(data)

    # Read everything first: each gist file must be a regular file at the
    # top of the download, not a link to somewhere else.
    contents: dict[str, bytes] = {}

    for entry in entries:
        if entry.empty:
            contents[entry.path] = b""

            continue

        file = source / entry.name

        if file.is_symlink() or not file.is_file():
            raise TreeError(
                f"{TREE_FILE} names {entry.name} for {entry.path}, "
                "which the gist does not hold"
            )

        data_bytes = file.read_bytes()

        if entry.encoding == BASE64:
            try:
                data_bytes = decode_base64(data_bytes.decode("ascii"))
            except (UnicodeDecodeError, TreeError) as error:
                raise TreeError(
                    f"{entry.name}, holding {entry.path}, is not valid base64"
                ) from error

        contents[entry.path] = data_bytes

    # The paths were checked as text; check where they land as well, so
    # nothing on disk can redirect a write outside the target.
    target.mkdir(parents=True)
    root = target.resolve()

    for path, content in contents.items():
        destination = target.joinpath(*path.split("/"))

        destination.parent.mkdir(parents=True, exist_ok=True)

        resolved = destination.resolve()

        if root not in resolved.parents:
            raise TreeError(f"{path} would be written outside the workshop")

        destination.write_bytes(content)


def _parse_entry(item: object, index: int) -> TreeEntry:
    where = f"{TREE_FILE} entry {index + 1}"

    if not isinstance(item, dict):
        raise TreeError(f"{where} must be an object")

    unknown = sorted(set(item) - _ENTRY_KEYS)

    if unknown:
        raise TreeError(f'{where} has an unknown field "{unknown[0]}"')

    path = item.get("path")

    if not isinstance(path, str) or not is_restorable_path(path):
        raise TreeError(
            f"{where} has a path that is not a file inside the workshop: "
            f"{json.dumps(path)}"
        )

    # An empty file has nothing for a gist file to hold.
    if "empty" in item:
        if item["empty"] is not True:
            raise TreeError(f'{where} ({path}) has "empty", which can only be true')

        if "name" in item or "encoding" in item:
            raise TreeError(f"{where} ({path}) is empty, so names no gist file")

        return TreeEntry(path=path, empty=True)

    name = item.get("name")

    if not isinstance(name, str) or not _is_gist_file_name(name):
        raise TreeError(
            f"{where} ({path}) has a gist file name that is not one: {json.dumps(name)}"
        )

    encoding = item.get("encoding")

    if encoding is not None and encoding != BASE64:
        raise TreeError(
            f"{where} ({path}) has an unknown encoding {json.dumps(encoding)}"
        )

    return TreeEntry(path=path, name=name, encoding=encoding or "")


def _is_gist_file_name(value: str) -> bool:
    return (
        value not in {"", ".", "..", TREE_FILE}
        and "/" not in value
        and "\\" not in value
        and "\0" not in value
    )
