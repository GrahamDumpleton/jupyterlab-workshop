# Agent guidance for jupyterlab-workshop

## Project

jupyterlab-workshop is a JupyterLab extension for running guided,
interactive workshops inside JupyterLab. Workshop instructions are shown in
a side panel and contain clickable actions that drive the live JupyterLab
session: terminals, the file browser, the editor, notebooks, kernels and
layout. Workshops can verify learner progress, gate pages on that progress,
and include forms and quizzes. The concept comes from the Educates Training
Platform (educates.dev), re-imagined so that a single workshop runs wherever
JupyterLab runs, without Kubernetes or containers. See README.md for the
project goals.

A workshop is a directory containing a `workshop.yaml` manifest and
MyST-flavoured Markdown pages. The format is text based and git friendly.

The repository is a monorepo with three main parts:

- `packages/core/` is `@jupyterlab-workshop/core`, pure TypeScript with no
  JupyterLab dependencies: workshop format parsing, action definitions,
  variable substitution, lint rules and JSON schemas. Keep it free of
  JupyterLab imports so the CLI and other tooling can reuse it under Node.

- `packages/labextension/` is `@jupyterlab-workshop/labextension`, the
  JupyterLab frontend extension: instructions panel, renderer, action
  implementations, verify engine, trust manager, loader and state.

- `jupyterlab_workshop/` is the Python package: the
  `jupyter_server` extension (platform detection, fetching, script
  verifies, checkpoints) and the `jupyter workshop` CLI.

README.md is the long description shown on PyPI, so it stays short and
user facing and links to the documentation site; development setup and
workflow belong in CONTRIBUTING.md, and the full documentation is under
`docs/` and published on Read the Docs.

Example workshops live in `examples/` and double as test fixtures. Tests
live in `tests/` (Python and Galata UI tests) and alongside the source in
`packages/core/`. See TESTING.md for where tests are, how to run them, and
conventions for adding new ones.

The scratch/ directory is not part of the git repo. It holds temporary
working files, such as reference material given to an agent or plans an
agent is asked to generate. Its contents come and go, so never reference
scratch/ files by name from code or documentation that will be committed.

## Tooling: always use uv and jlpm

All Python environment and package management in this project is done with
[uv](https://docs.astral.sh/uv/). Never use the Python venv module, bare
pip, or python -m build directly.

- Run commands in the project environment: `uv run <command>`
  (e.g. `uv run pytest`, `uv run jupyter lab`)

- Run a Python interpreter: `uv run python`

- Build sdist and wheel: `uv build`

- Add or remove dependencies (updates pyproject.toml): `uv add <package>`,
  `uv remove <package>`

- Sync the environment from pyproject.toml: `uv sync`

All JavaScript and TypeScript package management is done with `jlpm`, the
pinned Yarn that ships with JupyterLab. Never use npm or a system yarn
directly, and never commit a lockfile produced by them. jlpm is installed
into the project environment with JupyterLab, so run it as `uv run jlpm`.

- Install workspace dependencies: `uv run jlpm install`

- Add a dependency to one workspace package: run `uv run jlpm add <package>`
  from inside that package's directory (for example `packages/core`)

- Build all packages: `uv run jlpm build`

## Common tasks: use the Justfile

The Justfile defines targets for the common development tasks, wrapping
the correct uv and jlpm invocations (including details like linking the
labextension into JupyterLab in development mode and running the Galata
tests against a live server). Prefer these targets over synthesizing the
underlying commands yourself; run `just --list` to see everything.

- `just install` sets up the development environment: syncs the Python
  environment, installs JavaScript dependencies and links the extension
  into JupyterLab in development mode.

- `just build` builds the TypeScript packages and the labextension bundle.
  `just watch` rebuilds on change; run it alongside `just lab`.

- `just lab` starts JupyterLab from the repository root with the extension
  loaded, so the example workshops are reachable through the contents API.

- `just test` runs the fast test suites: the Jest tests for `packages/core`
  and the pytest suite for the Python package. Extra arguments pass
  through to pytest, so a specific file or test is
  `just test tests/python/test_fetch.py` or `just test -k pattern`.

- `just test-core` runs only the Jest tests; `just test-python` runs only
  pytest; `just test-ui` runs the Galata browser tests against a real
  JupyterLab (slow; run before finishing frontend work, not on every edit).

- `just lint` checks TypeScript with eslint and prettier and Python with
  the ruff linter and formatter; `just format` reformats and applies
  auto-fixes in both.

- `just typecheck` runs tsc for the TypeScript packages and mypy for
  Python.

- `just docs` builds the documentation with Sphinx into `docs/_build/html`
  (the pages are MyST Markdown under `docs/`, and the manifest reference is
  generated from the JSON schema on every build); `just docs-serve` rebuilds
  on change; `just docs-clean` clears a stale build after structural changes
  such as renamed or removed pages.

- `just pages` assembles the GitHub Pages site into `site/`: the landing
  page from `github-pages/`, the JSON schemas under `schemas/v1alpha1/`,
  and the example workshop as a JupyterLite site under `demo/`.

- `just clean` removes build outputs only. `just clean-examples` removes
  what running the example workshops leaves behind (`_workshop` state,
  `scratch` and `demo` directories) so a later run starts fresh.
  `just distclean` does both and also removes `node_modules`, `.venv`,
  caches, built docs and sites, returning the tree to a fresh checkout;
  run `just install` afterwards.

## Style

- Do not use emdashes in any files in this project. Rephrase with commas,
  parentheses, colons, or separate sentences instead.

- In bulleted lists where items run to multiple lines, put a blank
  line between the bullets: in docstrings, markdown files, and any
  other prose. This is about the raw file being readable, not the
  rendered form, which can look fine either way. Be consistent within
  a list: if one item needs the spacing, space every item in that
  list, never a mix.

- Python code must always use type hints. Add them to all function
  and method signatures (parameters and return types), and to attributes
  and variables where the type is not obvious from the assignment. When
  adding or modifying code that lacks type hints, add them.

- TypeScript code must be explicitly typed at its boundaries: every
  exported function, method, class member and module-level constant has
  an explicit type or return type. Never use `any`; use `unknown` and
  narrow it. Do not disable strict compiler options.

- Use vertical white space liberally inside function and method bodies,
  in both Python and TypeScript. Write code in paragraphs: group the
  statements that together perform one step, and separate each group
  from the next with a blank line. Natural paragraph boundaries include
  setup versus the main work versus the result, before and after a
  conditional or loop, and around a with or try block. Do not cram a body
  into one contiguous blob, and equally do not put a blank line between
  every single statement; the blank lines should mark where one thought
  ends and the next begins.

- Where it helps the reader, start a paragraph of code with a short
  comment saying what that step does or why it is needed. Prefer one
  comment per logical block over line-by-line commentary, and skip the
  comment entirely when the code already says it plainly.

- Put a blank line between such a block comment and the code below it:
  the comment introduces the paragraph rather than sitting flush against
  its first line.

- Put a blank line between a function or method docstring and the first
  line of code in the body.

- Every function, method or property that is part of the public API must
  have a docstring (Python) or a TSDoc comment (TypeScript) saying what it
  does. The exceptions are cases that are truly trivial and obvious, such
  as an accessor property named for the attribute it returns, and dunder
  methods implementing standard protocols.

- Every directive, action type or option added to the workshop format must
  be reflected in the JSON schema, the lint rules and the format
  documentation in the same change.

- Verify JupyterLab API names against the installed version's TypeScript
  definitions (under `node_modules/@jupyterlab/*/lib/`) before using them.
  Use only public tokens and APIs.

## Git

- Git commit messages must never include a co-authored-by agent message or
  any similar agent attribution trailer.

- An AI agent must never commit changes on its own initiative. Finish the
  piece of work, summarize it, and wait to be told to commit. Permission to
  commit applies only to the work it was given for; it does not carry
  forward to later steps of a multi-step plan, each of which needs its own
  review and its own instruction to commit. Uncommitted changes are how the
  review happens: once work is committed it can no longer be reviewed as
  the pending diff, so committing early makes review harder, not easier.

- A release bumps the version in four files together, in one commit on
  develop: the root `package.json` (the Python package reads its version
  from it), `packages/core/package.json`,
  `packages/labextension/package.json`, and the
  `jupyterlab-workshop==<version>` pin in `binder/requirements.txt`. The
  pin matters because mybinder caches the image it builds for a commit of
  main, so an unpinned install would freeze whichever release PyPI served
  at the first launch. Then fast-forward main, wait for CI, and push the
  bare version tag; the release workflow refuses a tag that does not
  match `package.json`.

- When merging a feature branch back to main and pushing to the remote,
  do not treat the work as landed until the CI workflow on GitHub has run
  against the pushed merge and passed. Check the run (for example with
  `gh run list --branch main` and `gh run watch`), and only once it is
  green report that the changes are on the remote and clean up the feature
  branch. If CI fails, leave the feature branch in place, report the
  failure, and wait for instructions rather than deleting anything.
