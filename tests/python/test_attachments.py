import base64
from pathlib import Path

import pytest

from jupyterlab_workshop.attachments import (
    IMAGE_LIMIT,
    Attachment,
    AttachmentError,
    message_content,
    parse_attachments,
    safe_name,
    save_attachments,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16


def _sent(name: str, media_type: str, data: bytes) -> dict:
    return {
        "name": name,
        "type": media_type,
        "data": base64.b64encode(data).decode("ascii"),
    }


def test_attachments_are_parsed_and_checked() -> None:
    parsed = parse_attachments(
        [
            _sent("shot.png", "image/png", PNG),
            _sent("notes", "text/plain; charset=utf-8", b"hello"),
            _sent("../deck.pdf", "application/pdf", b"%PDF-1.4"),
        ]
    )

    assert [(a.name, a.media_type, a.kind) for a in parsed] == [
        ("shot.png", "image/png", "image"),
        ("notes.txt", "text/plain", "text"),
        ("deck.pdf", "application/pdf", "document"),
    ]
    assert parsed[1].text() == "hello"
    assert parsed[0].describe() == {"name": "shot.png", "type": "image/png", "size": 24}
    assert parse_attachments(None) == []

    for sent, message in (
        ("x", "must be a list"),
        (["x"], "must be an object"),
        ([_sent("a.exe", "application/octet-stream", b"x")], "cannot be attached"),
        ([{"name": "a.png", "type": "image/png", "data": "***"}], "not sent as base64"),
        ([_sent("big.png", "image/png", b"\0" * (IMAGE_LIMIT + 1))], "too large"),
    ):
        with pytest.raises(AttachmentError, match=message):
            parse_attachments(sent)


def test_names_are_made_safe() -> None:
    assert safe_name("C:\\Users\\me\\My Shot (1).PNG", "image/png") == "My-Shot-1-.PNG"
    assert safe_name("", "image/jpeg") == "attachment.jpg"
    assert safe_name("..", "text/plain") == "attachment.txt"
    assert safe_name("notes", "text/x-python") == "notes.txt"
    assert safe_name("x" * 200, "text/plain") == "x" * 100


def test_attachments_are_saved_without_overwriting(tmp_path: Path) -> None:
    first = save_attachments(tmp_path, [Attachment("shot.png", "image/png", PNG)])
    second = save_attachments(
        tmp_path,
        [
            Attachment("shot.png", "image/png", b"other"),
            Attachment("README", "text/plain", b"read me"),
        ],
    )

    assert first[0].path == tmp_path / "_workshop" / "attachments" / "shot.png"
    assert first[0].path.read_bytes() == PNG
    assert [a.name for a in second] == ["shot-2.png", "README"]
    assert second[0].path is not None and second[0].path.read_bytes() == b"other"

    # Nothing is made for a message without attachments.
    assert save_attachments(tmp_path / "empty", []) == []
    assert not (tmp_path / "empty").exists()


def test_the_message_shows_images_and_text_and_names_every_file(
    tmp_path: Path,
) -> None:
    saved = save_attachments(
        tmp_path,
        [
            Attachment("shot.png", "image/png", PNG),
            Attachment("notes.md", "text/markdown", b"# Notes\n"),
            Attachment("deck.pdf", "application/pdf", b"%PDF-1.4"),
        ],
    )
    blocks = message_content("Use these", saved)

    assert blocks[0] == {"type": "text", "text": "Use these"}
    assert blocks[1]["type"] == "image"
    assert blocks[1]["source"] == {
        "type": "base64",
        "media_type": "image/png",
        "data": base64.b64encode(PNG).decode("ascii"),
    }
    assert blocks[2] == {
        "type": "text",
        "text": "Attached file notes.md:\n\n# Notes\n",
    }

    note = blocks[3]["text"]

    # The note says where the files are in each one's own path, as the
    # platform writes it, rather than naming the directory.
    assert "attachments directory, at the path given" in note

    for item in saved:
        assert f"{item.name} ({item.media_type}" in note
        assert str(item.path) in note

    # A PDF is only named, for the agent to read from its file, and a
    # message of files alone has no empty words before them.
    assert len(blocks) == 4
    assert message_content("", saved[2:])[0]["type"] == "text"
    assert "deck.pdf" in message_content("", saved[2:])[0]["text"]
