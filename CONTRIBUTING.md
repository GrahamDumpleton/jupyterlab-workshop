# Contributing

Development setup and workflow for jupyterlab-workshop. The user-facing
documentation is under `docs/` and published at
<https://jupyterlab-workshop.readthedocs.io/>; this file is about working
on the project itself.

## Setup

Requires [uv](https://docs.astral.sh/uv/), [just](https://just.systems/),
Node.js and git.

```
just install
just lab
```

`just install` creates the Python environment, installs the JavaScript
workspace, builds the extension and links it into JupyterLab in
development mode. `just lab` starts JupyterLab with the repository root
as its root directory, which is where the example workshops live. Open
the Workshop panel in the right sidebar (the `panelSide` setting, or
dragging the tab, moves it to the left).

To rebuild while editing the TypeScript, run `just watch` in a second
terminal and refresh the browser after each rebuild. `just --list` shows
every task.

## Running the examples from a checkout

With `just lab` running, the `examples/git-basics` workshop opens
automatically: the path is the `defaultWorkshop` setting of the
extension, which the shipped settings point at the example. Change it
under Settings, use the folder button in the panel header to pick a
different workshop directory, or right-click a directory in the file
browser and choose "Open as Workshop".

1. On page one, click each command block in turn. The first click starts
   a terminal named `git` in a split beneath the main area and runs the
   command there. Every block shows exactly the text sent to the
   terminal.

2. On page two, the first action writes `README.md` into the `demo`
   directory and opens it in the editor above the terminal. The final
   action highlights the terminal with a short callout.

3. Page three appends a line to the open file through the editor and
   saves it, then opens a second terminal named `log` beside the first.

4. Pages four and five branch, merge, create a conflict, open the file at
   the conflict marker and resolve it by rewriting the file. The last
   action shows a success notification.

5. Use the arrows or the page dropdown to move between pages. Reload the
   browser tab: the panel reopens on the same page.

`examples/hello-jupyterlab` exercises notebooks, kernels, the interface,
files, variables, tracks and automatic runs, and writes its files into
`examples/hello-jupyterlab/scratch`. The git example creates
`examples/git-basics/demo`, and every example keeps its progress under
its `_workshop` directory. All of these are ignored by git; the Restart
button in the panel header puts a workshop back, and `just
clean-examples` removes what every example left behind.

## Layout

- `packages/core/` is `@jupyterlab-workshop/core`, pure TypeScript with no
  JupyterLab dependencies: the workshop format, actions, variables, lint
  rules and JSON schemas.

- `packages/labextension/` is `@jupyterlab-workshop/labextension`, the
  JupyterLab frontend extension.

- `jupyterlab_workshop/` is the Python package: the `jupyter_server`
  extension and the `jupyter workshop` command line.

- `examples/` holds the example workshops, which double as test fixtures.

- `docs/` is the Sphinx documentation and `github-pages/` the landing page
  of the project site.

## Checks and tests

```
just lint
just typecheck
just test
```

`just test` runs the Jest tests for `packages/core` and the pytest suite.
`just test-ui` runs the Galata browser tests against a real JupyterLab,
`just selftest` runs every action of the example workshops in JupyterLab,
and `just selftest-lite` does the same in a JupyterLite build. See
TESTING.md for where the tests live and how to add more.

Python is managed with uv and JavaScript with `jlpm`, the Yarn that ships
with JupyterLab, run as `uv run jlpm`. Do not use pip, npm or a system
yarn directly. AGENTS.md records the coding conventions the project
follows.

## Documentation and the project site

`just docs` builds the documentation into `docs/_build/html`, and
`just docs-serve` rebuilds it on change. The manifest reference page is
generated from the JSON schema on every build.

`just pages` assembles the GitHub Pages site into `site/`: the landing
page, the JSON schemas and the example workshop built as a JupyterLite
site under `demo/`. Building the JupyterLite terminal needs `node`, `npm`
and `micromamba` on the path; pass `--no-terminal` to leave it out.

## Releases

The version is read from the root `package.json` by the Python build, so
bump it there, in the two workspace `package.json` files, and in the
`jupyterlab-workshop==<version>` pin of `binder/requirements.txt`
together (mybinder caches the image built for a commit, so the pin keeps
the Binder image on the matching release).
Releases are made by pushing a tag that is the bare version string, such
as `0.1.0`, with no `v` prefix. The release workflow refuses to build if
the tag does not match the version in `package.json`, then builds the
wheel and sdist, attaches them to a GitHub release and publishes to PyPI.
