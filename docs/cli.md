# Command line

The package installs `jupyter workshop`, a command line tool for people
who write workshops. Its `lint`, `render` and `pages` commands run the
same TypeScript code the extension uses, bundled for Node.js and shipped
inside the package, so they need `node` (18 or newer) on the path. The
other commands are pure Python.

## init

```
jupyter workshop init my-workshop [--name NAME] [--title TITLE] [--ci]
                                  [--template starter|blank|notebook]
                                  [--platform NAME]... [--capability NAME]...
                                  [--gating off|soft|strict]
```

Creates a directory with a `workshop.yaml`, starter pages, a README and
a `.gitignore`. The `starter` template's pages show commands, a check,
a file write and a quiz; `blank` is one page of prose; `notebook`
creates a notebook, runs its cells and checks a value in its kernel. The
name defaults to a slug of the directory name. `--platform` and
`--capability` may be repeated and set the manifest lists (the defaults
are `linux` and `macos`, and the template's capabilities); `--gating`
sets the page gating. With `--ci` it also writes a GitHub Actions
workflow that lints and self-tests the workshop on Linux, macOS and
Windows.

## lint

```
jupyter workshop lint my-workshop [--json] [--platform linux|macos|windows|lite]
```

Parses the manifest and every page and reports problems: unknown
directives and options, missing bodies, capabilities used but not
declared (or declared but unused), invalid checks, quizzes and forms,
requirements that name nothing, variables used before the form that sets
them, danger heuristics such as piping a download into a shell, hosts
not in the declared `network` list, and platform variants missing for a
listed platform. Exits with 1 when there are errors. `--json` prints the
report as JSON for other tools. `--platform` renders the pages as that
platform sees them, selecting its command variants and built-in
variables, so a Linux CI job can check the Windows version of a workshop.

## render

```
jupyter workshop render my-workshop [PAGE] [--out FILE] [--platform NAME]
```

Renders the pages to a standalone HTML document for previewing or for
static hosting. Action blocks are shown as boxes with their type and
body. Give a page id or path to render one page, and `--platform` to
render another platform's command variants.

## pages

```
jupyter workshop pages my-workshop
```

Lists page ids, titles, paths and requirements.

## schema

```
jupyter workshop schema [--registry]
```

Prints the JSON schema of `workshop.yaml`, for editors and validators,
or with `--registry` the schema of a registry index file.

## publish

```
jupyter workshop publish my-workshop [--out dist] [--url URL]
```

Builds `dist/<name>-<version>.tar.gz` (excluding `_workshop`, `.git`,
`scratch` and similar), writes its SHA-256 next to it, and writes a
registry entry JSON snippet with the hash and, when given, the URL the
archive will be published at. The archive is built with fixed ownership
and timestamps so the hash is the same on every machine.

## registry

```
jupyter workshop registry index.json ENTRY... [--title TITLE]
```

Merges the entry files written by `publish` into a registry index,
creating it if needed. An entry for a name that is already listed
replaces the listing and keeps the earlier versions, newest first. See
[Finding and installing workshops](registry.md) for the index format and
how the extension uses it.

## index

```
jupyter workshop index [DIRECTORY...] [--root ROOT] [--out FILE] [--repo URL] [--ref REF] [--title TITLE]
```

Builds a registry index of every workshop found under the directories
given (the current directory by default), so a repository holding
several workshops can list them all without publishing archives. Each
entry's source is the workshop's path relative to `--root`, the git
checkout holding the first directory unless given, fetched from `--repo`
at `--ref`, which default to the checkout's origin and current branch; an
SSH remote is rewritten as the https URL. The index is written to
`registry.json` under the root, or `--out`, and an existing index is
updated: entries are replaced by name and their other versions kept.
Hidden directories, `node_modules`, build outputs and `_workshop` state
are not searched, nor are the contents of a workshop.
See [Several workshops in one repository](registry.md#several-workshops-in-one-repository).

## record

```
jupyter workshop record RECORDING DIRECTORY [--name NAME] [--title TITLE]
```

Writes draft pages from a recording saved by the Record button in
JupyterLab (a JSON file under the workshop's `_workshop/recordings/`).
When the directory is a workshop the pages are added to it and its
manifest gains the pages and capabilities they need; otherwise a new
workshop is created there. See [Writing workshops in
JupyterLab](authoring.md) for what the draft contains.

## mcp

```
jupyter workshop mcp [--url URL --token TOKEN]
```

Serves the tools to AI agents over the Model Context Protocol on
standard input and output; needs the `mcp` extra. Lint, render, test,
init, publish and draft work on directories. The live tools drive a
running JupyterLab that has a workshop open in author mode, found
through `jupyter server list` unless `--url` and `--token` name one. See
[Writing workshops in JupyterLab](authoring.md).

## lite

```
jupyter workshop lite my-workshop [other-workshop ...] [--out DIR]
                                  [--default NAME] [--trust LEVEL]
                                  [--registry URL] [--no-terminal]
                                  [--lite-dir DIR] [--serve] [--port PORT]
```

Builds a static [JupyterLite](lite.md) site carrying the workshops, with
the extension, the Pyodide kernel and the terminal, that any web host can
serve. Needs the `lite` extra; the terminal's build step needs `node`,
`npm` and `micromamba` unless `--no-terminal` is given. `--serve` serves
the result locally to try it out.

## test

```
jupyter workshop test my-workshop [--junit FILE] [--json FILE] [--in-place]
                                  [--headed] [--timeout SECONDS]
                                  [--action-timeout SECONDS]
                                  [--trust trusted|restricted|ask]
                                  [--lite] [--lite-dir DIR]
```

Runs the workshop in a real JupyterLab: it copies the workshop to a
temporary directory (unless `--in-place`), starts a JupyterLab server on a
free port with trust forced to the chosen level, opens it in a headless
Chromium through Playwright, and runs the extension's self-test command.
That command walks every page, runs every action in order, waits for
each terminal command to finish, answers quizzes correctly, submits forms
with their defaults, and runs every check. Each action is reported as
pass, fail or skip, and the exit code is 1 when anything failed. `--junit`
writes a JUnit XML report for CI, `--json` the full results.

An action that is still running after `--action-timeout` seconds (default 300) is reported as failed and the run stops there, since later actions
would build on an unknown state. `--timeout` (default 1200) bounds the
whole run: when it passes, the harness collects the results gathered so
far, records the action in flight as failed, and exits with code 1. Both
limits exist so that a stuck action in CI produces a report naming it
rather than a job that never ends.

Requirements: the `test` extra (`pip install
"jupyterlab-workshop[test]"`) and a browser (`playwright install
chromium`). Terminals started by the test use a non-interactive pager so
commands such as `git diff` do not wait for a key press.

Commands in the tested workshop should not need input. A check that
depends on something only a person would do fails the self-test, which
is the point: the self-test is what a workshop's CI runs.

The self-test runs on Windows as well, where terminals are PowerShell
and `:windows:` command variants are selected; the workflow written by
`init --ci` covers Linux, macOS and Windows. `--lite` builds a JupyterLite
site with the workshop instead of starting a server, serves it from a
static file server and drives that, with `:lite:` variants selected; see
[JupyterLite](lite.md) for what it needs.
