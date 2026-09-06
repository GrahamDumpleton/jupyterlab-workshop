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

## Where to start

- [Try the demo](demo.md) to see the example workshops running.

- [Actions](actions.md) lists every directive a page can use.

- [Checks, forms and checkpoints](checks.md) covers verifying progress,
  quizzes, forms, gating and checkpoints.

- [Layouts](layouts.md) covers arranging the JupyterLab window when a
  workshop opens: sidebars, their widths, and what the main area holds.

- [Platforms](platforms.md) covers command variants for Linux, macOS,
  Windows and JupyterLite, paths and terminal shells.

- [JupyterLite](lite.md) covers running and publishing workshops as a
  static site with no server.

- [Isolated environments](environment.md) describes giving a workshop
  its own Python environment and kernel.

- [Manifest reference](reference/manifest.md) documents `workshop.yaml`.

- [Finding and installing workshops](registry.md) covers the workshop
  browser, registries and launch links.

- [Loading and trust](trust.md) explains where workshops come from and
  what the trust levels allow.

- [Progress events](analytics.md) describes what is recorded, the export,
  and reporting to a sink.

- [Command line](cli.md) covers `jupyter workshop` for creating,
  checking, self-testing and publishing workshops.

- [Writing workshops in JupyterLab](authoring.md) covers author mode,
  recording a session into pages, and the MCP server and skill for AI
  agents.

## Install

```
pip install jupyterlab-workshop
```

The package is a prebuilt JupyterLab 4 extension with its server
extension; nothing else needs installing. Add the `test` extra and a
browser to self-test workshops:

```
pip install "jupyterlab-workshop[test]"
playwright install chromium
```

The `mcp` extra adds the MCP server for AI agents, and the `lite` extra
the tools to build a JupyterLite site.

```{toctree}
:hidden:

demo
```

```{toctree}
:hidden:
:caption: Writing workshops

actions
checks
layouts
platforms
lite
environment
reference/manifest
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
:caption: Tools

cli
authoring
```
