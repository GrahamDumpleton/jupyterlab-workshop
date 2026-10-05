import base64
import json
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop.tree import (
    TREE_FILE,
    TreeEntry,
    TreeError,
    decode_base64,
    is_restorable_path,
    parse_tree,
    restore_tree,
    tree_document,
)


def tree(*entries: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 1,
        "files": [{"path": "workshop.yaml", "name": "workshop.yaml"}, *entries],
    }


def test_parse_tree_reads_entries_of_each_kind() -> None:
    entries = parse_tree(
        tree(
            {"path": "pages/01.md", "name": "pages--01.md"},
            {"path": "files/logo.png", "name": "logo.base64", "encoding": "base64"},
            {"path": "files/__init__.py", "empty": True},
        )
    )

    assert entries == [
        TreeEntry("workshop.yaml", "workshop.yaml"),
        TreeEntry("pages/01.md", "pages--01.md"),
        TreeEntry("files/logo.png", "logo.base64", "base64"),
        TreeEntry("files/__init__.py", empty=True),
    ]
    assert tree_document(entries)["files"][1:] == [
        {"path": "pages/01.md", "name": "pages--01.md"},
        {"path": "files/logo.png", "name": "logo.base64", "encoding": "base64"},
        {"path": "files/__init__.py", "empty": True},
    ]


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/etc/passwd",
        "../outside.md",
        "pages/../../outside.md",
        "pages/./01.md",
        "pages//01.md",
        "pages\\01.md",
        "C:/temp/x.md",
        "c:x.md",
        "_workshop/source.json",
        "_Workshop/state.json",
        ".git/config",
        "files/.GIT/hooks/post-checkout",
        TREE_FILE,
        "nul\0byte",
    ],
)
def test_paths_that_escape_or_reach_the_state_are_refused(path: str) -> None:
    assert not is_restorable_path(path)

    with pytest.raises(TreeError, match="not a file inside the workshop"):
        parse_tree(tree({"path": path, "name": "x.md"}))


def test_restorable_paths() -> None:
    assert is_restorable_path("pages/01.md")
    assert is_restorable_path("files/.gitignore")
    assert is_restorable_path("_workshop.md")
    assert is_restorable_path("docs/_workshop/x.md")


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ([], "must be an object"),
        ({"version": 2, "files": []}, "Unsupported"),
        ({"version": 1}, '"files" list'),
        ({"version": 1, "files": ["x"]}, "entry 1 must be an object"),
        (tree({"path": "a.md", "name": "a.md", "mode": 1}), 'unknown field "mode"'),
        (tree({"path": "a.md"}), "gist file name"),
        (tree({"path": "a.md", "name": "pages/a.md"}), "gist file name"),
        (tree({"path": "a.md", "name": ".."}), "gist file name"),
        (tree({"path": "a.md", "name": TREE_FILE}), "gist file name"),
        (tree({"path": "a.md", "name": "a", "encoding": "gzip"}), "encoding"),
        (tree({"path": "a.md", "empty": False}), "can only be true"),
        (tree({"path": "a.md", "empty": True, "name": "a"}), "names no gist file"),
        (
            tree({"path": "a.md", "name": "a"}, {"path": "A.md", "name": "b"}),
            "the same file",
        ),
        (
            tree({"path": "a.md", "name": "a"}, {"path": "b.md", "name": "A"}),
            "reads A for both",
        ),
        (
            tree({"path": "a", "name": "a"}, {"path": "A/b.md", "name": "b"}),
            "as a file and as the directory",
        ),
        ({"version": 1, "files": [{"path": "a.md", "name": "a"}]}, "workshop.yaml"),
    ],
)
def test_malformed_trees_are_refused(data: object, message: str) -> None:
    with pytest.raises(TreeError, match=message):
        parse_tree(data)


def test_decode_base64_ignores_line_breaks_and_refuses_the_rest() -> None:
    encoded = base64.b64encode(b"\x00\x01binary\xff").decode()

    assert decode_base64(encoded[:8] + "\n" + encoded[8:] + "\n") == (
        b"\x00\x01binary\xff"
    )

    for bad in ("abc", "ab$=", "a===", "=abc"):
        with pytest.raises(TreeError, match="not valid base64"):
            decode_base64(bad)


def write_gist(directory: Path, files: dict[str, str], document: object) -> Path:
    directory.mkdir()

    for name, text in files.items():
        (directory / name).write_text(text)

    (directory / TREE_FILE).write_text(json.dumps(document))

    return directory


def test_restore_tree_puts_files_back_and_leaves_the_rest_out(tmp_path: Path) -> None:
    source = write_gist(
        tmp_path / "gist",
        {
            "workshop.yaml": "name: demo\n",
            "pages--01.md": "# One\n",
            "logo.base64": base64.b64encode(b"\x89PNG").decode() + "\n",
            "README.md": "# Generated\n",
            "stray.md": "added in the web editor\n",
        },
        tree(
            {"path": "pages/01.md", "name": "pages--01.md"},
            {"path": "files/img/logo.png", "name": "logo.base64", "encoding": "base64"},
            {"path": "files/__init__.py", "empty": True},
        ),
    )
    target = tmp_path / "restored"

    restore_tree(source, target)

    assert sorted(
        path.relative_to(target).as_posix()
        for path in target.rglob("*")
        if path.is_file()
    ) == ["files/__init__.py", "files/img/logo.png", "pages/01.md", "workshop.yaml"]
    assert (target / "files" / "img" / "logo.png").read_bytes() == b"\x89PNG"
    assert (target / "files" / "__init__.py").read_bytes() == b""


def test_restore_tree_writes_nothing_when_a_file_is_missing_or_a_link(
    tmp_path: Path,
) -> None:
    source = write_gist(
        tmp_path / "gist",
        {"workshop.yaml": "name: demo\n"},
        tree({"path": "pages/01.md", "name": "pages--01.md"}),
    )

    with pytest.raises(TreeError, match="does not hold"):
        restore_tree(source, tmp_path / "missing")

    assert not (tmp_path / "missing").exists()

    secret = tmp_path / "secret.txt"
    secret.write_text("private\n")
    (source / "pages--01.md").symlink_to(secret)

    with pytest.raises(TreeError, match="does not hold"):
        restore_tree(source, tmp_path / "linked")

    assert not (tmp_path / "linked").exists()


def test_restore_tree_refuses_bad_base64(tmp_path: Path) -> None:
    source = write_gist(
        tmp_path / "gist",
        {"workshop.yaml": "name: demo\n", "logo.base64": "not base64!\n"},
        tree({"path": "logo.png", "name": "logo.base64", "encoding": "base64"}),
    )

    with pytest.raises(TreeError, match="logo.base64, holding logo.png"):
        restore_tree(source, tmp_path / "restored")

    assert not (tmp_path / "restored").exists()


def test_restore_tree_needs_a_readable_tree(tmp_path: Path) -> None:
    source = tmp_path / "gist"
    source.mkdir()
    (source / TREE_FILE).write_text("{not json")

    with pytest.raises(TreeError, match="Unable to read"):
        restore_tree(source, tmp_path / "restored")
