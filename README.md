# jupyterlab-workshop

Guided, interactive workshops inside JupyterLab.

Workshop instructions are shown in a JupyterLab side panel and contain
clickable actions that drive the live JupyterLab session: terminals, the
file browser, the editor, notebooks, kernels and layout. The concept comes
from the [Educates Training Platform](https://educates.dev), re-imagined so
that a single workshop runs wherever JupyterLab runs, without Kubernetes or
containers.

This project is at the proof-of-concept stage. See `docs/demo.md` for how
to try the example workshop, `docs/actions.md` for the actions a workshop
page can use, `docs/checks.md` for verifies, quizzes, forms, gating and
checkpoints, `docs/platforms.md` for Windows and macOS variants of
commands, `docs/lite.md` for running and publishing workshops as a
static JupyterLite site, `docs/environment.md` for isolated Python
environments,
`docs/registry.md` for the workshop browser, registries and launch links,
`docs/trust.md` for how workshops are loaded from repositories and
archives, what capabilities they declare, and how the trust levels change
what actions do, `docs/analytics.md` for the progress events a workshop
records, `docs/cli.md` for the `jupyter workshop` command line tool
that creates, lints, renders, self-tests and publishes workshops, and
`docs/authoring.md` for author mode in JupyterLab, session recording,
and the MCP server and `skills/workshop-author` skill for AI agents.
`just docs` builds these into a site.

## Writing a workshop

```
pip install "jupyterlab-workshop[test]"
playwright install chromium
jupyter workshop init my-workshop
jupyter workshop lint my-workshop
jupyter workshop test my-workshop
```

`lint` needs Node.js on the path; `test` runs every action of the
workshop in a real JupyterLab and reports each one. Inside JupyterLab,
"Workshop: Author Mode" adds an editing toolbar to the panel, and
`jupyter workshop mcp` (with the `mcp` extra) serves the same tools to AI
agents.

## Development

Requires [uv](https://docs.astral.sh/uv/) and [just](https://just.systems/).

```
just install
just lab
```

Then open the Workshop panel in the right sidebar (the `panelSide`
setting, or dragging the tab, moves it to the left). See `just --list` for the
other development tasks.
