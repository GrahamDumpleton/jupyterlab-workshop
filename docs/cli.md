# Command line

The package installs `jupyter workshop`, a command line tool for people
who write workshops. Its `lint`, `render` and `pages` commands run the
same TypeScript code the extension uses, bundled for Node.js and shipped
inside the package, so they need `node` (18 or newer) on the path. The
other commands are pure Python.

## init

```
jupyter workshop init my-workshop [--name NAME] [--title TITLE] [--ci]
```

Creates a directory with a `workshop.yaml`, two starter pages showing
commands, a check, a file write and a quiz, a README and a `.gitignore`.
The name defaults to a slug of the directory name. With `--ci` it also
writes a GitHub Actions workflow that lints and self-tests the workshop on
Linux and macOS.

## lint

```
jupyter workshop lint my-workshop [--json]
```

Parses the manifest and every page and reports problems: unknown
directives and options, missing bodies, capabilities used but not
declared (or declared but unused), invalid checks, quizzes and forms,
requirements that name nothing, variables used before the form that sets
them, danger heuristics such as piping a download into a shell, and hosts
not in the declared `network` list. Exits with 1 when there are errors.
`--json` prints the report as JSON for other tools.

## render

```
jupyter workshop render my-workshop [PAGE] [--out FILE]
```

Renders the pages to a standalone HTML document for previewing or for
static hosting. Action blocks are shown as boxes with their type and
body. Give a page id or path to render one page.

## pages

```
jupyter workshop pages my-workshop
```

Lists page ids, titles, paths and requirements.

## schema

```
jupyter workshop schema
```

Prints the JSON schema of `workshop.yaml`, for editors and validators.

## publish

```
jupyter workshop publish my-workshop [--out dist] [--url URL]
```

Builds `dist/<name>-<version>.tar.gz` (excluding `_workshop`, `.git`,
`scratch` and similar), writes its SHA-256 next to it, and writes a
registry entry JSON snippet with the hash and, when given, the URL the
archive will be published at. The archive is built with fixed ownership
and timestamps so the hash is the same on every machine.

## test

```
jupyter workshop test my-workshop [--junit FILE] [--json FILE] [--in-place]
                                  [--headed] [--timeout SECONDS]
                                  [--trust trusted|restricted|ask]
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

Requirements: the `test` extra (`pip install
"educates-jupyterlab-workshop[test]"`) and a browser (`playwright install
chromium`). Terminals started by the test use a non-interactive pager so
commands such as `git diff` do not wait for a key press.

Commands in the tested workshop should not need input. A check that
depends on something only a person would do fails the self-test, which
is the point: the self-test is what a workshop's CI runs.
