import base64
import json
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop.gist import (
    BINDER_BADGE,
    BINDER_LAUNCHER,
    DEFAULT_SITE,
    GIST_URL_PLACEHOLDER,
    LAUNCHER_PYTHONS,
    LAUNCHER_SITE,
    FlatWorkshop,
    GistError,
    binder_link,
    create_gist,
    flat_name,
    flatten_workshop,
    gist_id,
    launcher_site,
    render_readme,
    resolve_token,
    update_gist,
    write_flat,
)
from jupyterlab_workshop.tree import TREE_FILE, restore_tree

MANIFEST = """\
apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
description: Mentions pages/01-intro.md nowhere else.
# The pages, in order.
pages:
  - pages/01-intro.md
  - "pages/02-files.md"
  - 03-flat.md
environment:
  requirements: env/requirements.txt
"""

INTRO = """\
---
title: Intro
---

# Intro

```{file-write}
:path: notes.md
:from: templates/notes.md
```

```{verify}
:id: checked
:script:   verify/check.py
```
"""


def make_workshop(directory: Path, manifest: str = MANIFEST) -> Path:
    directory.mkdir()
    (directory / "workshop.yaml").write_text(manifest)
    (directory / "pages").mkdir()
    (directory / "pages" / "01-intro.md").write_text(INTRO)
    (directory / "pages" / "02-files.md").write_text("# Files\n![](../images/a.svg)\n")
    (directory / "03-flat.md").write_text("# Flat\n")
    (directory / "templates").mkdir()
    (directory / "templates" / "notes.md").write_text("notes\n")
    (directory / "verify").mkdir()
    (directory / "verify" / "check.py").write_text("print('ok')\n")
    (directory / "env").mkdir()
    (directory / "env" / "requirements.txt").write_text("rich\n")
    (directory / "images").mkdir()
    (directory / "images" / "a.svg").write_text("<svg/>\n")
    (directory / "files" / "pkg").mkdir(parents=True)
    (directory / "files" / ".gitkeep").write_text("")
    (directory / "files" / "pkg" / "__init__.py").write_text("")
    (directory / "files" / "pkg" / "blank.txt").write_text("\n")
    (directory / "files" / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00")
    (directory / "README.md").write_text("about\n")
    (directory / ".gitignore").write_text("_workshop/\n")
    (directory / "notes.md~").write_text("backup\n")
    (directory / "_workshop").mkdir()
    (directory / "_workshop" / "state.json").write_text("{}")
    (directory / "work").mkdir()
    (directory / "work" / "mine.py").write_text("x = 1\n")

    return directory


def test_flat_name_joins_directories() -> None:
    assert flat_name("pages/01-intro.md") == "pages--01-intro.md"
    assert flat_name("pages/part1/01.md") == "pages--part1--01.md"
    assert flat_name("03-flat.md") == "03-flat.md"


def test_flatten_stores_files_flat_and_leaves_them_as_written(tmp_path: Path) -> None:
    directory = make_workshop(tmp_path / "ws")
    flat = flatten_workshop(directory)

    assert flat.name == "demo"
    assert flat.title == "Demo"
    assert sorted(flat.files) == [
        "03-flat.md",
        "README.md",
        "env--requirements.txt",
        "files--logo.png.base64",
        "files--pkg--blank.txt.base64",
        "images--a.svg",
        "pages--01-intro.md",
        "pages--02-files.md",
        "templates--notes.md",
        "verify--check.py",
        TREE_FILE,
        "workshop.yaml",
    ]

    # Nothing is rewritten: the manifest and pages are as written, line
    # endings included, as they are on disk wherever the tests run.
    def on_disk(path: str) -> str:
        return (directory / path).read_bytes().decode()

    assert flat.files["workshop.yaml"] == on_disk("workshop.yaml")
    assert flat.files["pages--01-intro.md"] == on_disk("pages/01-intro.md")
    assert flat.renames["pages/01-intro.md"] == "pages--01-intro.md"
    assert "03-flat.md" not in flat.renames

    # The tree maps every path back, binaries and blank files as base64
    # and the empty file with no gist file at all.
    tree = json.loads(flat.files[TREE_FILE])

    assert tree["version"] == 1
    assert {"path": "files/pkg/__init__.py", "empty": True} in tree["files"]
    assert {
        "path": "files/logo.png",
        "name": "files--logo.png.base64",
        "encoding": "base64",
    } in tree["files"]
    assert {"path": "workshop.yaml", "name": "workshop.yaml"} in tree["files"]
    assert base64.b64decode(flat.files["files--logo.png.base64"]) == (
        b"\x89PNG\r\n\x1a\n\x00"
    )

    # Hidden files, droppings, the state and workspace directories are
    # left out silently; the author's README is reported.
    assert flat.left_out == ["README.md"]

    # The generated README stands in for the author's unless asked to
    # keep theirs below it, names a gist that does not exist yet, and
    # says how the files go back.
    assert "about" not in flat.files["README.md"]
    assert GIST_URL_PLACEHOLDER in flat.files["README.md"]
    assert f"`{TREE_FILE}` says where each one goes back" in flat.files["README.md"]

    appended = flatten_workshop(directory, append_readme=True)

    assert appended.files["README.md"].endswith("\n---\n\nabout\n")
    assert appended.left_out == []


def test_flat_copy_restores_to_the_workshop_as_written(tmp_path: Path) -> None:
    directory = make_workshop(tmp_path / "ws")

    # Line endings come back as written, CRLF as well as LF.
    (directory / "templates" / "crlf.md").write_bytes(b"# CRLF\r\nline\r\n")

    target = write_flat(flatten_workshop(directory), tmp_path / "out")
    restored = tmp_path / "restored"

    restore_tree(target, restored)

    def listing(root: Path) -> dict[str, bytes]:
        return {
            path.relative_to(root).as_posix(): path.read_bytes()
            for path in sorted(root.rglob("*"))
            if path.is_file()
        }

    expected = {
        path: data
        for path, data in listing(directory).items()
        if not path.startswith(("_workshop/", "work/", ".", "files/.gitkeep"))
        and path not in {"README.md", "notes.md~"}
    }

    assert listing(restored) == expected


def test_flatten_refuses_what_a_gist_cannot_hold(tmp_path: Path) -> None:
    taken = make_workshop(tmp_path / "taken")
    (taken / "pages--01-intro.md").write_text("# Looks flat already\n")

    with pytest.raises(GistError, match="would both be named pages--01-intro.md"):
        flatten_workshop(taken)

    cased = make_workshop(tmp_path / "cased")
    (cased / "Pages--02-files.md").write_text("# Differs only in case\n")

    with pytest.raises(GistError, match="would both be named"):
        flatten_workshop(cased)

    readme = make_workshop(tmp_path / "readme")
    (readme / "README.md").unlink()
    (readme / "readme.md").write_text("lower case\n")

    with pytest.raises(GistError, match="which the gist has its own of"):
        flatten_workshop(readme)

    reserved = make_workshop(tmp_path / "reserved")
    (reserved / "gistfile1.md").write_text("# Reserved\n")

    with pytest.raises(GistError, match="reserves"):
        flatten_workshop(reserved)

    tree = make_workshop(tmp_path / "tree")
    (tree / TREE_FILE).write_text("{}")

    with pytest.raises(GistError, match="the gist's own"):
        flatten_workshop(tree)

    missing = make_workshop(tmp_path / "missing")
    (missing / "pages" / "02-files.md").unlink()

    with pytest.raises(GistError, match="does not exist"):
        flatten_workshop(missing)


def test_launcher_site_follows_the_python_requirement() -> None:
    newest = LAUNCHER_PYTHONS[0]
    url = LAUNCHER_SITE.format(python=newest)

    # Nothing said, or a requirement the newest launcher meets, picks it.
    assert launcher_site({}) == (newest, url)
    assert launcher_site({"requires": {"tools": [{"name": "git"}]}}) == (newest, url)
    assert launcher_site(
        {"requires": {"tools": [{"name": "python", "version": ">=3.12"}]}}
    ) == (newest, url)
    assert launcher_site(
        {"requires": {"tools": [{"name": "python3", "version": f"=={newest}"}]}}
    ) == (newest, url)

    # A requirement for JupyterLab only says nothing about the launcher.
    assert launcher_site(
        {
            "requires": {
                "tools": [
                    {"name": "python", "version": "<3", "frontends": ["jupyterlab"]}
                ]
            }
        }
    ) == (newest, url)

    # One no launcher meets is an error rather than a wrong button.
    with pytest.raises(GistError, match="requires Python <3"):
        launcher_site({"requires": {"tools": [{"name": "python", "version": "<3"}]}})

    # Naming a version wins, but only a published one.
    assert launcher_site(
        {"requires": {"tools": [{"name": "python", "version": "<3"}]}}, newest
    ) == (newest, url)

    with pytest.raises(GistError, match="No launcher is published for Python 2.7"):
        launcher_site({}, "2.7")


def test_flatten_records_the_launcher_or_the_site_given(tmp_path: Path) -> None:
    directory = tmp_path / "ws"
    directory.mkdir()
    (directory / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: w\ntitle: W\n"
        "frontends: [jupyterlab, jupyterlite]\npages: [01.md]\n"
    )
    (directory / "01.md").write_text("# One\n")

    chosen = flatten_workshop(directory)

    assert chosen.python == LAUNCHER_PYTHONS[0]
    assert chosen.site == DEFAULT_SITE
    assert DEFAULT_SITE in chosen.files["README.md"]

    given = flatten_workshop(directory, site="https://lite.example.org/lab/")

    assert chosen.binder == BINDER_LAUNCHER
    assert "Launch on Binder" in chosen.files["README.md"]

    unbound = flatten_workshop(directory, binder="")

    assert "Launch on Binder" not in unbound.files["README.md"]
    assert (
        "Launch on Binder" not in unbound.with_gist_url("https://x").files["README.md"]
    )

    assert given.python == ""
    assert given.site == "https://lite.example.org/lab/"


def test_render_readme_describes_the_workshop_and_how_to_open_it() -> None:
    manifest = {
        "name": "demo",
        "title": "Demo",
        "description": "A demo.",
        "version": "1.2.0",
        "authors": ["Ada", "Grace"],
        "duration": "20m",
        "tags": ["python"],
        "platforms": ["linux"],
        "frontends": ["jupyterlab", "jupyterlite"],
        "homepage": "https://example.org/demo",
    }
    gist = "https://gist.github.com/ada/abc"
    readme = render_readme(manifest, gist, "https://lite.example.org/lab/index.html")

    assert readme.startswith(
        "# Demo\n\nA demo.\n\n| | |\n| --- | --- |\n| Version | 1.2.0 |\n"
    )
    assert "| Authors | Ada, Grace |" in readme
    assert "| Frontends | jupyterlab, jupyterlite |" in readme
    assert (
        "](https://lite.example.org/lab/index.html?reset&workshop="
        "https://gist.github.com/ada/abc&restart=force)" in readme
    )
    assert f"jupyter workshop launch {gist}" in readme
    assert "[Homepage](https://example.org/demo)" in readme
    assert "Issues" not in readme

    # Without JupyterLite among the frontends there is no button to press.
    plain = render_readme({"name": "demo", "pages": []}, gist)

    assert plain.startswith("# demo\n\n## Open this workshop\n")
    assert "Launch in JupyterLite" not in plain
    assert DEFAULT_SITE not in plain
    assert "Open Workshop from URL" in plain

    # The Binder button opens the launcher with the launch link encoded
    # in urlpath, whatever the JupyterLite button does.
    binder = (
        f"{BINDER_LAUNCHER}?urlpath="
        "lab%3Fworkshop%3Dhttps%3A%2F%2Fgist.github.com%2Fada%2Fabc"
    )

    assert binder_link(BINDER_LAUNCHER, gist) == binder

    # Both buttons share one line, and one paragraph says what each opens.
    section = readme.split("## Open this workshop\n\n", 1)[1].split("\n\n")

    assert section[0].startswith("[![Launch in JupyterLite](")
    assert " [![Launch on Binder](" in section[0]
    assert section[1].startswith("The JupyterLite button opens the workshop in ")
    assert "The Binder button opens it in JupyterLab on [mybinder.org]" in section[1]
    assert "The button opens the workshop in JupyterLab" in plain
    assert f"[![Launch on Binder]({BINDER_BADGE})]({binder})" in readme
    assert f"]({binder})" in plain

    # It is left out when asked, and when the workshop cannot run there:
    # JupyterLite only, or platforms without Linux.
    assert "Launch on Binder" not in render_readme(manifest, gist, binder="")
    assert "Launch on Binder" not in render_readme(
        {**manifest, "frontends": ["jupyterlite"]}, gist
    )
    assert "Launch on Binder" not in render_readme(
        {**manifest, "platforms": ["macos", "windows"]}, gist
    )
    assert "Launch on Binder" in render_readme(
        {**manifest, "platforms": ["linux", "macos"]}, gist
    )

    # A launcher of the author's own is used as given.
    assert "](https://mybinder.org/v2/gh/me/mine/HEAD?urlpath=lab%3F" in (
        render_readme(manifest, gist, binder="https://mybinder.org/v2/gh/me/mine/HEAD")
    )

    # The author's README goes under a rule.
    assert render_readme(manifest, gist, extra="Mine.\n").endswith("\n---\n\nMine.\n")


def test_write_flat_replaces_an_earlier_copy_only(tmp_path: Path) -> None:
    flat = FlatWorkshop("demo", "Demo", "", {"workshop.yaml": "name: demo\n"}, {}, [])

    target = write_flat(flat, tmp_path / "out")
    (target / "stale.md").write_text("old\n")

    assert write_flat(flat, tmp_path / "out") == target
    assert not (target / "stale.md").exists()
    assert (target / "workshop.yaml").read_text() == "name: demo\n"

    (tmp_path / "other" / "demo").mkdir(parents=True)
    (tmp_path / "other" / "demo" / "mine.txt").write_text("keep\n")

    with pytest.raises(GistError, match="not an earlier flat copy"):
        write_flat(flat, tmp_path / "other")


def test_gist_id_reads_urls_and_ids() -> None:
    identifier = "fee514f3051b532e3f790c2ae7068ed7"

    assert gist_id(identifier) == identifier
    assert (
        gist_id("https://gist.github.com/ada/FEE514F3051B532E3F790C2AE7068ED7/")
        == "fee514f3051b532e3f790c2ae7068ed7"
    )
    assert gist_id("https://gist.github.com/ada/abc123/def456") == "abc123"

    with pytest.raises(GistError):
        gist_id("https://github.com/ada/repo")


def test_resolve_token_tries_the_argument_environment_and_gh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert resolve_token("given", environ={"GH_TOKEN": "env"}) == "given"
    assert resolve_token(environ={"GITHUB_TOKEN": "env"}) == "env"
    assert resolve_token(environ={"GH_TOKEN": "first", "GITHUB_TOKEN": "x"}) == "first"

    def fake_run(
        command: list[str], **_kwargs: Any
    ) -> subprocess.CompletedProcess[str]:
        assert command[1:] == ["auth", "token"]

        return subprocess.CompletedProcess(command, 0, "from-gh\n", "")

    monkeypatch.setattr(
        "jupyterlab_workshop.gist.shutil.which", lambda _name: "/bin/gh"
    )

    assert resolve_token(environ={}, run=fake_run) == "from-gh"

    monkeypatch.setattr("jupyterlab_workshop.gist.shutil.which", lambda _name: None)

    with pytest.raises(GistError, match="No GitHub token"):
        resolve_token(environ={})


def test_create_and_update_send_the_files() -> None:
    manifest = {"name": "demo", "title": "Demo", "frontends": ["jupyterlite"]}
    flat = FlatWorkshop(
        "demo",
        "Demo",
        "A demo.",
        {
            "workshop.yaml": "name: demo\n",
            "pages--01.md": "# One\n",
            "README.md": render_readme(manifest, GIST_URL_PLACEHOLDER),
        },
        {"pages/01.md": "pages--01.md"},
        [],
        manifest=manifest,
    )
    final_readme = render_readme(manifest, "https://gist.github.com/ada/abc")
    calls: list[tuple[str, str, Mapping[str, Any] | None]] = []

    def fake_request(
        method: str, url: str, body: Mapping[str, Any] | None, token: str
    ) -> dict[str, Any]:
        assert token == "tok"
        calls.append((method, url, body))

        if method == "GET":
            return {
                "files": {"workshop.yaml": {}, "old.md": {}},
                "html_url": "https://gist.github.com/ada/abc",
            }

        return {"id": "abc", "html_url": "https://gist.github.com/ada/abc"}

    # Creating sends the files, then the README again once the address
    # is known.
    created = create_gist(flat, "tok", public=True, request=fake_request)

    assert created.url == "https://gist.github.com/ada/abc"
    assert created.created
    assert calls == [
        (
            "POST",
            "https://api.github.com/gists",
            {
                "description": "Demo: A demo.",
                "public": True,
                "files": {
                    "workshop.yaml": {"content": "name: demo\n"},
                    "pages--01.md": {"content": "# One\n"},
                    "README.md": {"content": flat.files["README.md"]},
                },
            },
        ),
        (
            "PATCH",
            "https://api.github.com/gists/abc",
            {"files": {"README.md": {"content": final_readme}}},
        ),
    ]
    assert "https://gist.github.com/ada/abc&restart=force" in final_readme

    calls.clear()
    updated = update_gist(
        "https://gist.github.com/ada/abc", flat, "tok", request=fake_request
    )

    assert not updated.created
    assert [call[:2] for call in calls] == [
        ("GET", "https://api.github.com/gists/abc"),
        ("PATCH", "https://api.github.com/gists/abc"),
    ]
    assert calls[1][2] == {
        "description": "Demo: A demo.",
        "files": {
            "workshop.yaml": {"content": "name: demo\n"},
            "pages--01.md": {"content": "# One\n"},
            "README.md": {"content": final_readme},
            "old.md": None,
        },
    }
