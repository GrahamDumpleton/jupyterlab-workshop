import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
import yaml

from jupyterlab_workshop.gist import (
    DEFAULT_SITE,
    GIST_URL_PLACEHOLDER,
    LAUNCHER_PYTHONS,
    LAUNCHER_SITE,
    FlatWorkshop,
    GistError,
    create_gist,
    flat_name,
    flatten_workshop,
    gist_id,
    launcher_site,
    render_readme,
    resolve_token,
    rewrite_manifest,
    rewrite_options,
    update_gist,
    write_flat,
)

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
    (directory / "pages" / "02-files.md").write_text("# Files\n")
    (directory / "03-flat.md").write_text("# Flat\n")
    (directory / "templates").mkdir()
    (directory / "templates" / "notes.md").write_text("notes\n")
    (directory / "verify").mkdir()
    (directory / "verify" / "check.py").write_text("print('ok')\n")
    (directory / "env").mkdir()
    (directory / "env" / "requirements.txt").write_text("rich\n")
    (directory / "README.md").write_text("about\n")
    (directory / "_workshop").mkdir()
    (directory / "_workshop" / "state.json").write_text("{}")

    return directory


REFERENCED = ["templates/notes.md", "verify/check.py", "notes.md"]


def test_flat_name_joins_directories_and_refuses_the_separator() -> None:
    assert flat_name("pages/01-intro.md") == "pages--01-intro.md"
    assert flat_name("pages/part1/01.md") == "pages--part1--01.md"
    assert flat_name("03-flat.md") == "03-flat.md"

    with pytest.raises(GistError, match='contains "--"'):
        flat_name("pages/odd--name.md")

    with pytest.raises(GistError, match="reserves"):
        flat_name("gistfile1.md")


def test_flatten_renames_and_rewrites(tmp_path: Path) -> None:
    flat = flatten_workshop(make_workshop(tmp_path / "ws"), REFERENCED)

    assert flat.name == "demo"
    assert flat.title == "Demo"
    assert sorted(flat.files) == [
        "03-flat.md",
        "README.md",
        "env--requirements.txt",
        "pages--01-intro.md",
        "pages--02-files.md",
        "templates--notes.md",
        "verify--check.py",
        "workshop.yaml",
    ]
    assert flat.renames == {
        "pages/01-intro.md": "pages--01-intro.md",
        "pages/02-files.md": "pages--02-files.md",
        "templates/notes.md": "templates--notes.md",
        "verify/check.py": "verify--check.py",
        "env/requirements.txt": "env--requirements.txt",
    }
    assert flat.left_out == ["README.md"]

    # The generated README stands in for the author's unless asked to
    # keep theirs below it, and names a gist that does not exist yet.
    assert "about" not in flat.files["README.md"]
    assert GIST_URL_PLACEHOLDER in flat.files["README.md"]

    appended = flatten_workshop(tmp_path / "ws", REFERENCED, append_readme=True)

    assert appended.files["README.md"].endswith("\n---\n\nabout\n")
    assert appended.left_out == []

    # Options that named a renamed file follow it; the rest stay put.
    page = flat.files["pages--01-intro.md"]

    assert ":from: templates--notes.md" in page
    assert ":script:   verify--check.py" in page
    assert ":path: notes.md" in page

    # The manifest keeps its comment and quoting and parses as expected.
    manifest = flat.files["workshop.yaml"]

    assert "# The pages, in order." in manifest
    assert '- "pages--02-files.md"' in manifest
    assert "Mentions pages/01-intro.md nowhere else." in manifest
    assert yaml.safe_load(manifest)["pages"] == [
        "pages--01-intro.md",
        "pages--02-files.md",
        "03-flat.md",
    ]
    assert yaml.safe_load(manifest)["environment"] == {
        "requirements": "env--requirements.txt"
    }


def test_flatten_refuses_what_a_gist_cannot_hold(tmp_path: Path) -> None:
    starter = make_workshop(tmp_path / "starter")
    (starter / "files").mkdir()
    (starter / "files" / "data.csv").write_text("a,b\n")

    with pytest.raises(GistError, match="starter files"):
        flatten_workshop(starter)

    binary = make_workshop(tmp_path / "binary")
    (binary / "templates" / "notes.md").write_bytes(b"\x00\x01\xff")

    with pytest.raises(GistError, match="not a text file"):
        flatten_workshop(binary, REFERENCED)

    taken = make_workshop(tmp_path / "taken")
    (taken / "pages--01-intro.md").write_text("# Looks flat already\n")

    with pytest.raises(GistError, match='contains "--"'):
        flatten_workshop(taken, ["pages--01-intro.md"])

    missing = make_workshop(tmp_path / "missing")
    (missing / "pages" / "02-files.md").unlink()

    with pytest.raises(GistError, match="does not exist"):
        flatten_workshop(missing)


def test_flatten_leaves_unrenamed_workshops_alone(tmp_path: Path) -> None:
    directory = tmp_path / "flat"
    directory.mkdir()
    (directory / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: flat\ntitle: Flat\n"
        "pages: [01.md]\n"
    )
    (directory / "01.md").write_text("# One\n")

    flat = flatten_workshop(directory)

    assert flat.renames == {}
    assert flat.files["workshop.yaml"].endswith("pages: [01.md]\n")


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

    # The author's README goes under a rule.
    assert render_readme(manifest, gist, extra="Mine.\n").endswith("\n---\n\nMine.\n")


def test_rewrite_options_only_touches_whole_values() -> None:
    renames = {"pages/01.md": "pages--01.md"}

    assert rewrite_options(":from: pages/01.md\n", renames) == ":from: pages--01.md\n"
    assert (
        rewrite_options("  :from: pages/01.md  \n", renames)
        == "  :from: pages--01.md  \n"
    )
    assert (
        rewrite_options(":path: pages/01.md/extra\n", renames)
        == ":path: pages/01.md/extra\n"
    )
    assert rewrite_options(":id: pages/01.md\n", renames) == ":id: pages/01.md\n"
    assert rewrite_options("See pages/01.md for more.\n", renames) == (
        "See pages/01.md for more.\n"
    )


def test_rewrite_manifest_handles_inline_lists_and_refuses_wider_changes() -> None:
    source = "name: x\ntitle: pages/01.md\npages: [pages/01.md, pages/02.md]\n"
    manifest = yaml.safe_load(source)
    renames = {"pages/01.md": "pages--01.md", "pages/02.md": "pages--02.md"}

    assert rewrite_manifest(source, manifest, renames) == (
        "name: x\ntitle: pages/01.md\npages: [pages--01.md, pages--02.md]\n"
    )

    listed = "name: x\ntags:\n  - pages/01.md\npages:\n  - pages/01.md\n"

    with pytest.raises(GistError, match="rename them by hand"):
        rewrite_manifest(listed, yaml.safe_load(listed), renames)


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
