# jupyterlab-workshop

Guided, interactive workshops inside JupyterLab.

Workshop instructions are shown in a JupyterLab side panel and contain
clickable actions that drive the live session: terminals, the file
browser, the editor, notebooks, kernels and layout. Workshops can check
what the learner has done, ask questions, collect values, hold pages
until requirements are met, and snapshot the working directory. The
concept comes from the [Educates Training Platform](https://educates.dev),
re-imagined so that a single workshop runs wherever JupyterLab runs,
without Kubernetes or containers.

```{warning}
This project is in an early phase of development. The documentation is
still being improved, the experience is still being polished, and the
workshop format, settings and command line can change between releases
without a compatibility path.
```

## Three ways in

- **Try it.** The [hosted demos](demo.md) run an example workshop in the
  browser with nothing to install, or on Binder with a real terminal.

- **Run workshops.** [Getting started](getting-started.md) installs the
  extension on your machine and walks through an example, and
  [Finding and installing workshops](registry.md) covers handing
  workshops to learners through the browser, registries and launch links.

- **Write workshops.** [How workshops work](concepts.md) explains the
  pieces, the [tutorial](tutorial.md) builds a small workshop from
  nothing and publishes it, and the writing section of the navigation
  has the reference for each part.

## What a workshop looks like

A workshop is a directory with a `workshop.yaml` manifest and Markdown
pages. The format is text based and git friendly:

````markdown
---
title: Your first commit
requires: [verify:first-commit]
---

Record the commit with a message describing the change.

```{execute}
git commit -m "Add README"
```

```{verify}
:id: first-commit
:label: You have made a commit
:trigger: terminal-output "Add README"
import subprocess
out = subprocess.run(["git", "log", "--oneline"], capture_output=True, text=True).stdout
assert out.strip(), "No commits yet: run git commit"
```
````

The `execute` block runs the command in a workshop terminal when
clicked. The `verify` block checks the result in a hidden kernel, runs
on its own when the terminal shows the commit message, and the page's
front matter asks for it to pass before the learner moves on.

## What it can do

- **Drive the session.** Actions run commands, open and edit files,
  create and run notebooks, execute code in kernels, arrange the window
  and point at parts of the interface.

- **Check progress.** Verifies run code or inspect files and the
  interface, quizzes ask questions, forms collect values, and pages can
  be gated on them. Checkpoints snapshot the files for a later restore.

- **Adapt.** Variables, platform variants and conditions let one
  workshop serve Linux, macOS, Windows and JupyterLite, and follow
  tracks the learner chooses.

- **Stay safe.** Every action needs a declared capability, the trust
  dialog says what a workshop asks for, and a restricted level turns
  commands into text to be typed rather than run.

- **Ship anywhere.** Publish to a registry, ship in a Binder or
  JupyterHub image, or build a JupyterLite site that runs entirely in
  the browser.

## Install

The package is a prebuilt JupyterLab 4 extension with its server
extension. Install it into a virtual environment alongside JupyterLab,
with uv or with pip:

```
uv add jupyterlab jupyterlab-workshop
```

```
pip install jupyterlab jupyterlab-workshop
```

The `test` extra adds the self-test, which also needs a browser
(`playwright install chromium`); the `mcp` extra adds the MCP server
for AI agents; and the `lite` extra adds the tools to build a
JupyterLite site. [Getting started](getting-started.md) walks through
the setup step by step.

```{toctree}
:hidden:
:caption: Start here

getting-started
concepts
demo
```

```{toctree}
:hidden:
:caption: Writing workshops

tutorial
pages
variables
actions
checks
layouts
platforms
lite
environment
authoring
publishing
```

```{toctree}
:hidden:
:caption: Running workshops

registry
trust
analytics
```

```{toctree}
:hidden:
:caption: Reference

reference/manifest
cli
```
