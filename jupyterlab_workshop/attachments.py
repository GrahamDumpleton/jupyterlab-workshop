"""Files attached to a message in a conversation with the agent.

The panel attaches a file pasted or dropped into the message box, or a
long piece of pasted text, and sends it with the message. Each is saved
under `_workshop/attachments/` beside the conversation's record, in the
workshop for a workshop's conversation and in the draft's own directory
for a draft, where the agent may read it without asking and copy it into
the workshop when asked. The agent is also shown the file in the message
itself: an image as an image, a text file as its text, and a PDF by its
path, which the agent reads with its own tools.

The conversation's record keeps only each attachment's name, type and
size: the agent's own session holds what it was shown.
"""

from __future__ import annotations

import base64
import binascii
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal

from .collection import STATE_DIR

# Where a conversation's attachments are saved, under _workshop/.
ATTACHMENTS_DIR = "attachments"

# The images the agent is shown as images.
IMAGE_TYPES: frozenset[str] = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp"}
)

# Documents the agent reads from the saved file.
DOCUMENT_TYPES: frozenset[str] = frozenset({"application/pdf"})

# Types besides text/* whose content is text.
TEXT_TYPES: frozenset[str] = frozenset(
    {
        "application/json",
        "application/x-yaml",
        "application/yaml",
        "application/toml",
        "application/xml",
        "application/javascript",
        "application/x-sh",
        "application/x-ipynb+json",
    }
)

# The largest an attachment may be, by kind: the image limit is the
# model's own, and text beyond its limit is better given as a file to read.
IMAGE_LIMIT = 5 * 1024 * 1024
DOCUMENT_LIMIT = 10 * 1024 * 1024
TEXT_LIMIT = 1024 * 1024

# The most one message may carry in all.
MESSAGE_LIMIT = 24 * 1024 * 1024

# How much of a text attachment is put in the message itself; the rest is
# in the saved file.
INLINE_TEXT_LIMIT = 100_000

# How many attachments one message may carry.
COUNT_LIMIT = 20

# The extension a file gets when its name has none, by type.
EXTENSIONS: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "application/json": ".json",
}

Kind = Literal["image", "document", "text"]


class AttachmentError(ValueError):
    """An attachment that cannot be taken as sent."""


@dataclass(frozen=True)
class Attachment:
    """One file attached to a message."""

    name: str
    media_type: str
    data: bytes

    # Where it was saved, once it has been.
    path: Path | None = None

    @property
    def size(self) -> int:
        """How many bytes the file holds."""

        return len(self.data)

    @property
    def kind(self) -> Kind:
        """How the agent is shown it: an image, a document or text."""

        return attachment_kind(self.media_type)

    def text(self) -> str:
        """The content as text, for a text attachment."""

        return self.data.decode("utf-8", errors="replace")

    def describe(self) -> dict[str, Any]:
        """What the history keeps of it: the name, type and size."""

        return {"name": self.name, "type": self.media_type, "size": self.size}


def attachment_kind(media_type: str) -> Kind:
    """How a type is shown to the agent."""

    if media_type in IMAGE_TYPES:
        return "image"

    if media_type in DOCUMENT_TYPES:
        return "document"

    return "text"


def is_supported(media_type: str) -> bool:
    """Whether files of a type can be attached."""

    return (
        media_type in IMAGE_TYPES
        or media_type in DOCUMENT_TYPES
        or media_type in TEXT_TYPES
        or media_type.startswith("text/")
    )


def parse_attachments(value: object) -> list[Attachment]:
    """The attachments of a message as the panel sent them.

    Each is a dict of `name`, `type` and base64 `data`. Anything that is
    not, or that is of an unsupported type or too large, is refused as
    an `AttachmentError`.
    """

    if value is None:
        return []

    if not isinstance(value, list):
        raise AttachmentError("Attachments must be a list")

    if len(value) > COUNT_LIMIT:
        raise AttachmentError(f"At most {COUNT_LIMIT} files can be attached at once")

    attachments: list[Attachment] = []
    total = 0

    for item in value:
        if not isinstance(item, dict):
            raise AttachmentError("An attachment must be an object")

        media_type = str(item.get("type") or "").split(";")[0].strip().lower()
        name = safe_name(str(item.get("name") or ""), media_type)

        if not is_supported(media_type):
            raise AttachmentError(
                f"{name} cannot be attached: only images, PDFs and text files can"
            )

        try:
            data = base64.b64decode(str(item.get("data") or ""), validate=True)
        except (binascii.Error, ValueError) as error:
            raise AttachmentError(f"{name} was not sent as base64") from error

        attachment = Attachment(name=name, media_type=media_type, data=data)
        limit = _limit(attachment.kind)

        if attachment.size > limit:
            raise AttachmentError(
                f"{name} is too large: {_describe_size(attachment.size)}, "
                f"and {attachment.kind} attachments can be at most "
                f"{_describe_size(limit)}"
            )

        total += attachment.size

        if total > MESSAGE_LIMIT:
            raise AttachmentError(
                f"One message can carry at most {_describe_size(MESSAGE_LIMIT)} "
                "of attachments"
            )

        attachments.append(attachment)

    return attachments


def safe_name(name: str, media_type: str) -> str:
    """A file name the attachment can be saved under.

    Only the last part of a path is kept, odd characters become hyphens,
    and a name without an extension gets one for its type.
    """

    base = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-.")

    if not base:
        base = "attachment"

    if "." not in base:
        fallback = ".txt" if media_type.startswith("text/") else ""
        base += EXTENSIONS.get(media_type, fallback)

    return base[:100]


def attachments_directory(directory: Path, state: str = STATE_DIR) -> Path:
    """Where a conversation held in `directory` keeps its attachments:
    under its state directory, `_workshop/` for a workshop and
    `.workshop/` for a course."""

    return directory / state / ATTACHMENTS_DIR


def save_attachments(
    directory: Path, attachments: Sequence[Attachment], state: str = STATE_DIR
) -> list[Attachment]:
    """Save attachments beside a conversation's record, each under its name.

    A name already taken gets a number, so nothing attached earlier is
    overwritten. Returns the attachments with their paths.
    """

    target = attachments_directory(directory, state)
    saved: list[Attachment] = []

    if attachments:
        target.mkdir(parents=True, exist_ok=True)

    for attachment in attachments:
        path = _unique(target, attachment.name)

        path.write_bytes(attachment.data)

        saved.append(replace(attachment, name=path.name, path=path))

    return saved


def message_content(
    text: str, attachments: Sequence[Attachment]
) -> list[dict[str, Any]]:
    """The content blocks of a message with attachments, as the model takes them.

    The person's words come first, then each image as an image block,
    each text file as its text, and a note saying where every file was
    saved, so the agent can read a PDF or copy an image into the workshop.
    """

    blocks: list[dict[str, Any]] = []

    if text:
        blocks.append({"type": "text", "text": text})

    for attachment in attachments:
        if attachment.kind == "image":
            blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": attachment.media_type,
                        "data": base64.b64encode(attachment.data).decode("ascii"),
                    },
                }
            )

        elif attachment.kind == "text":
            content = attachment.text()
            note = ""

            if len(content) > INLINE_TEXT_LIMIT:
                content = content[:INLINE_TEXT_LIMIT]
                note = " (the start of it; read the file for the rest)"

            blocks.append(
                {
                    "type": "text",
                    "text": f"Attached file {attachment.name}{note}:\n\n{content}",
                }
            )

    blocks.append({"type": "text", "text": describe_attachments(attachments)})

    return blocks


def describe_attachments(attachments: Sequence[Attachment]) -> str:
    """The note telling the agent where the attachments were saved."""

    lines = [
        f"- {attachment.name} ({attachment.media_type}, "
        f"{_describe_size(attachment.size)}) at {attachment.path or attachment.name}"
        for attachment in attachments
    ]

    return (
        "The person attached these files to this message. Each is saved in "
        "this conversation's attachments directory, at the path given, where "
        "you may read it; an image shown above is the same file. Copy a file "
        "into the workshop only when they ask for it to be used:\n" + "\n".join(lines)
    )


def _limit(kind: Kind) -> int:
    if kind == "image":
        return IMAGE_LIMIT

    if kind == "document":
        return DOCUMENT_LIMIT

    return TEXT_LIMIT


def _unique(directory: Path, name: str) -> Path:
    path = directory / name

    if not path.exists():
        return path

    stem, dot, suffix = name.rpartition(".")

    if not dot or not stem:
        stem, suffix = name, ""
    else:
        suffix = "." + suffix

    number = 2

    while (directory / f"{stem}-{number}{suffix}").exists():
        number += 1

    return directory / f"{stem}-{number}{suffix}"


def _describe_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"

    if size >= 1024:
        return f"{size / 1024:.0f} KB"

    return f"{size} bytes"
