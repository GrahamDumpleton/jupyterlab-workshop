"""Files written by ``jupyter workshop init``."""

from __future__ import annotations

import re
from pathlib import Path


def slug(text: str) -> str:
    """Turn a title into a name of lower case letters, digits and hyphens."""

    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")

    return cleaned or "workshop"


def manifest(name: str, title: str) -> str:
    """The starting ``workshop.yaml``."""

    return f"""apiVersion: workshop.educates.dev/v1alpha1
name: {name}
title: {title}
version: 0.1.0
description: Describe what the learner will do in a sentence or two.
authors: []
tags: []
duration: 30m
platforms: [linux, macos]
capabilities:
  - terminal
  - write-files: [workspace]
requires:
  tools: []
layout: default
gating: soft
variables:
  - name: work_dir
    type: path
    default: work
    description: Directory the exercises are done in
pages:
  - pages/01-welcome.md
  - pages/02-first-steps.md
"""


def welcome_page(title: str) -> str:
    """The first page, introducing the panel."""

    return f"""---
title: Welcome
---

# {title}

This workshop runs inside JupyterLab. The instructions are on this side,
and the actions in boxes drive the session: click one and it runs. You can
also type the commands yourself.

Start by checking which directory you are in.

```{{execute}}
pwd
```

Create the directory the exercises use. The name comes from the
`work_dir` variable declared in `workshop.yaml`.

```{{execute}}
mkdir -p {{{{ work_dir }}}} && cd {{{{ work_dir }}}}
```

The check below passes once the directory exists. It runs after the
command above and can also be run with the Check button.

```{{verify}}
:id: work-dir-exists
:label: The working directory exists
:substrate: contents
:trigger: after:welcome-2
exists {{{{ work_dir }}}}
```
"""


def first_steps_page() -> str:
    """A second page showing a file write and a quiz."""

    return """---
title: First steps
requires: [quiz:panel-quiz]
---

# First steps

Write a file into the working directory and open it in the editor.

```{file-write}
:path: {{ work_dir }}/notes.md
:open: true
# Notes

- Files written by actions open in the editor when asked to.
```

A quick question to finish.

```{quiz}
:id: panel-quiz
:title: How actions run
question: What happens when you click a command block?
options:
  - { text: It runs in a terminal, correct: true }
  - text: It is copied to the clipboard
    explanation: Copying is what the copy role does.
  - { text: Nothing }
explanation: Command blocks run in a workshop terminal.
```
"""


def readme(name: str, title: str) -> str:
    """A README for the workshop repository."""

    return f"""# {title}

A guided workshop for JupyterLab, built with educates-jupyterlab-workshop.

## Try it

Install the extension into a JupyterLab environment and open this
directory as a workshop:

```
pip install educates-jupyterlab-workshop
jupyter lab
```

Then use "Open Workshop…" in the Workshop panel, or right-click this
directory in the file browser and choose "Open as Workshop".

## Check it

```
jupyter workshop lint .
jupyter workshop test .
```

`lint` needs Node.js on the path. `test` needs the `test` extra and a
browser: `pip install "educates-jupyterlab-workshop[test]"` and
`playwright install chromium`.

Workshop name: `{name}`.
"""


def gitignore() -> str:
    """Ignore what running the workshop creates."""

    return """# Runtime state written by the workshop extension
_workshop/

# Exercise output
work/
"""


def ci_workflow() -> str:
    """A GitHub Actions workflow that lints and self-tests the workshop."""

    return """name: workshop

on:
  push:
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Install the workshop extension
        run: |
          python -m pip install --upgrade pip
          python -m pip install "educates-jupyterlab-workshop[test]"
          python -m playwright install --with-deps chromium
      - name: Lint
        run: jupyter workshop lint .
      - name: Self-test
        run: jupyter workshop test . --junit results.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: results-${{ matrix.os }}
          path: results.xml
"""


def write_scaffold(directory: Path, name: str, title: str, ci: bool) -> list[Path]:
    """Write the starting files, refusing to overwrite any that exist."""

    files: dict[Path, str] = {
        directory / "workshop.yaml": manifest(name, title),
        directory / "pages" / "01-welcome.md": welcome_page(title),
        directory / "pages" / "02-first-steps.md": first_steps_page(),
        directory / "README.md": readme(name, title),
        directory / ".gitignore": gitignore(),
    }

    if ci:
        files[directory / ".github" / "workflows" / "workshop.yml"] = ci_workflow()

    existing = [path for path in files if path.exists()]

    if existing:
        names = ", ".join(str(path.relative_to(directory)) for path in existing)

        raise FileExistsError(f"Refusing to overwrite existing files: {names}")

    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    return list(files)
