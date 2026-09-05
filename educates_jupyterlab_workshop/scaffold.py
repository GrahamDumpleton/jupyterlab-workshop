"""Files written by ``jupyter workshop init`` and the new workshop wizard."""

from __future__ import annotations

import re
from pathlib import Path

TEMPLATES = ("starter", "blank", "notebook")

PLATFORMS = ("linux", "macos", "windows", "lite")

GATING = ("off", "soft", "strict")

DEFAULT_PLATFORMS = ["linux", "macos"]

DEFAULT_CAPABILITIES: dict[str, list[str]] = {
    "starter": ["terminal", "write-files:workspace"],
    "blank": [],
    "notebook": ["write-files:workspace", "kernel-exec"],
}


def slug(text: str) -> str:
    """Turn a title into a name of lower case letters, digits and hyphens."""

    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")

    return cleaned or "workshop"


def capability_lines(capabilities: list[str]) -> list[str]:
    """Manifest list lines for capabilities given as ``name`` or ``name:scope``."""

    grouped: dict[str, list[str]] = {}

    for item in capabilities:
        name, _, scope = item.partition(":")
        scopes = grouped.setdefault(name, [])

        if scope and scope not in scopes:
            scopes.append(scope)

    lines = []

    for name, scopes in grouped.items():
        lines.append(f"  - {name}: [{', '.join(scopes)}]" if scopes else f"  - {name}")

    return lines


def manifest(
    name: str,
    title: str,
    *,
    platforms: list[str] | None = None,
    capabilities: list[str] | None = None,
    gating: str = "soft",
    variables: str = "",
    pages: list[str] | None = None,
    requires: str = "  tools: []\n",
) -> str:
    """The starting ``workshop.yaml``."""

    listed = platforms or DEFAULT_PLATFORMS
    capability_block = capability_lines(capabilities or [])
    capability_text = (
        "capabilities:\n" + "\n".join(capability_block) + "\n"
        if capability_block
        else "capabilities: []\n"
    )
    page_text = "\n".join(f"  - {page}" for page in pages or [])

    return f"""apiVersion: workshop.educates.dev/v1alpha1
name: {name}
title: {title}
version: 0.1.0
description: Describe what the learner will do in a sentence or two.
authors: []
tags: []
duration: 30m
platforms: [{", ".join(listed)}]
{capability_text}requires:
{requires}layout: default
gating: {gating}
{variables}pages:
{page_text}
"""


def starter_variables() -> str:
    """Variables declared by the starter template."""

    return """variables:
  - name: work_dir
    type: path
    default: work
    description: Directory the exercises are done in
"""


def notebook_variables() -> str:
    """Variables declared by the notebook template."""

    return """variables:
  - name: notebook
    type: path
    default: exercise.ipynb
    description: The notebook the exercises are done in
"""


def welcome_page(title: str) -> str:
    """The first page of the starter template, introducing the panel."""

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
    """The second page of the starter template: a file write and a quiz."""

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


def blank_page(title: str) -> str:
    """The only page of the blank template."""

    return f"""---
title: Welcome
---

# {title}

Describe what the learner will do. Add actions with the author toolbar,
or write directives such as the one below by hand:

```{{hint}}
:title: Writing pages
Pages are Markdown with fenced directives. See the documentation for the
actions, checks, quizzes and forms a page can use.
```
"""


def notebook_page(title: str) -> str:
    """The first page of the notebook template."""

    return f"""---
title: Welcome
requires: [verify:total-computed]
---

# {title}

This workshop works in a notebook. The action below creates it with a few
cells and opens it in the main area.

```{{notebook-create}}
:path: {{{{ notebook }}}}
:open: true
- markdown: |
    # Exercise
    Run the cells below.
- code: |
    numbers = list(range(1, 11))
    numbers
- code: |
    total = sum(numbers)
    total
  tags: [total]
```

Run every cell. The kernel starts if it has not already.

```{{cell-run-all}}
:id: run-all
:path: {{{{ notebook }}}}
```

The check below asks the notebook's kernel for the value of `total`. It
runs again whenever the tagged cell is executed.

```{{verify}}
:id: total-computed
:label: The total has been computed
:substrate: learner-kernel
:path: {{{{ notebook }}}}
:trigger: after:run-all; cell-executed total
total == 55
```
"""


def notebook_explore_page() -> str:
    """The second page of the notebook template: insert a cell and a quiz."""

    return """---
title: Explore
requires: [quiz:cells-quiz]
---

# Explore

Insert a new cell after the one tagged `total` and run it.

```{cell-insert}
:path: {{ notebook }}
:at: after:total
:tags: [average]
:run: true
average = total / len(numbers)
average
```

```{quiz}
:id: cells-quiz
:title: Cells
question: Which action runs every cell of a notebook?
options:
  - { text: cell-run-all, correct: true }
  - { text: cell-run, explanation: cell-run runs one cell. }
  - { text: kernel-restart }
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

# Published archives
dist/

# Exercise output
work/
"""


def ci_workflow() -> str:
    """A GitHub Actions workflow that lints and self-tests the workshop.

    The matrix covers Linux, macOS and Windows so platform variants get
    exercised; drop an operating system the workshop does not support.
    """

    return """name: workshop

on:
  push:
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
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


def scaffold_files(
    directory: Path,
    name: str,
    title: str,
    ci: bool,
    template: str = "starter",
    platforms: list[str] | None = None,
    capabilities: list[str] | None = None,
    gating: str = "soft",
) -> dict[Path, str]:
    """The files a template writes, keyed by path."""

    if template not in TEMPLATES:
        raise ValueError(f'Unknown template "{template}"; expected one of {TEMPLATES}')

    if gating not in GATING:
        raise ValueError(f'Unknown gating "{gating}"; expected one of {GATING}')

    for platform in platforms or []:
        if platform not in PLATFORMS:
            raise ValueError(f'Unknown platform "{platform}"')

    listed = DEFAULT_CAPABILITIES[template] if capabilities is None else capabilities

    # Each template contributes its pages and variables; the manifest,
    # README and ignore file are shared.
    if template == "starter":
        pages = {
            "pages/01-welcome.md": welcome_page(title),
            "pages/02-first-steps.md": first_steps_page(),
        }
        variables = starter_variables()
    elif template == "notebook":
        pages = {
            "pages/01-welcome.md": notebook_page(title),
            "pages/02-explore.md": notebook_explore_page(),
        }
        variables = notebook_variables()
    else:
        pages = {"pages/01-welcome.md": blank_page(title)}
        variables = ""

    files: dict[Path, str] = {
        directory / "workshop.yaml": manifest(
            name,
            title,
            platforms=platforms,
            capabilities=listed,
            gating=gating,
            variables=variables,
            pages=list(pages),
        )
    }

    for relative, content in pages.items():
        files[directory / relative] = content

    files[directory / "README.md"] = readme(name, title)
    files[directory / ".gitignore"] = gitignore()

    if ci:
        files[directory / ".github" / "workflows" / "workshop.yml"] = ci_workflow()

    return files


def write_scaffold(
    directory: Path,
    name: str,
    title: str,
    ci: bool,
    template: str = "starter",
    platforms: list[str] | None = None,
    capabilities: list[str] | None = None,
    gating: str = "soft",
) -> list[Path]:
    """Write the starting files, refusing to overwrite any that exist."""

    files = scaffold_files(
        directory,
        name,
        title,
        ci,
        template=template,
        platforms=platforms,
        capabilities=capabilities,
        gating=gating,
    )
    existing = [path for path in files if path.exists()]

    if existing:
        names = ", ".join(str(path.relative_to(directory)) for path in existing)

        raise FileExistsError(f"Refusing to overwrite existing files: {names}")

    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    return list(files)
