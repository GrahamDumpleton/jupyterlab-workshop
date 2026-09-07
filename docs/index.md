# jupyterlab-workshop

Guided, interactive workshops inside JupyterLab.

```{warning}
Early in development: the documentation and the experience are still
being polished, and the workshop format, settings and command line can
change between releases without a compatibility path.
```

## Why

JupyterLab is a natural place to teach, and the usual way to do it is a
notebook: paragraphs of explanation with code cells between them, handed
to the learner to run. It works up to a point, and then it does not.
The learner reads down the page pressing Shift+Enter, or Run All, and
finishes having done nothing. Everything has to be a cell in the
notebook's one language, so a lesson cannot ask for a shell command, a
file edited by hand, a second notebook, or anything JupyterLab itself
does. The instructions and the work are the same document, so the
notebook the learner ends up with is neither a clean set of notes nor a
clean piece of work, and there is no way to tell, from either side,
whether a step was done, done right, or skipped.

This extension separates the two. The instructions live in a side
panel, one page at a time, and the rest of the window is the ordinary
JupyterLab session the learner works in. Each step in the instructions
is a clickable action that does something real in that session: run a
command in a terminal, write or edit a file, create a notebook and run
its cells, execute code in a kernel, open a panel or arrange the
window. The learner can click it, or type it themselves; the workshop
checks the result either way. A page can hold checks that verify what
was done, quizzes, and forms that collect values, and can wait for them
before moving on. A workshop can snapshot the files for a later reset,
adapt to the platform and to choices the learner makes, and be shipped
to a class through a registry, a Binder link, or as a static site that
runs entirely in the browser.

The subject can be anything JupyterLab can host: a language, a library,
a command line tool such as git, a data workflow, or JupyterLab itself.

## Three ways in

- **Try it.** The [hosted demos](demo.md) run an example workshop in the
  browser with nothing to install, or on Binder with a real terminal.

- **Run workshops.** [Getting started](getting-started.md) installs the
  extension on your machine and walks through an example,
  [Using workshops](using.md) is the learner's guide, and
  [Deploying workshops](deploying.md) covers Binder, JupyterHub and
  locked-down images.

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
troubleshooting
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

using
registry
deploying
trust
analytics
```

```{toctree}
:hidden:
:caption: Reference

reference/manifest
settings
cli
```
