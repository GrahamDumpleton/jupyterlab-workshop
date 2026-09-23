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
                                  [--platform NAME]... [--frontend NAME]...
                                  [--capability NAME]... [--gating off|soft|strict]
```

Creates a directory with a `workshop.yaml`, starter pages, an empty
`files/` for starter files (copied into the learner's `work/`
[workspace](concepts.md#the-workspace) when the workshop opens), a
README and a `.gitignore`. The `starter` template's pages show commands,
a check,
a file write and a quiz; `blank` is one page of prose; `notebook`
creates a notebook, runs its cells and checks a value in its kernel. The
name defaults to a slug of the directory name. `--platform`,
`--frontend` and `--capability` may be repeated and set the manifest
lists (the defaults are `linux` and `macos`, JupyterLab only, which
needs no `frontends` list, and the template's capabilities); `--gating`
sets the page gating. With `--ci` it also writes a GitHub Actions
workflow that lints and self-tests the workshop on Linux, macOS and
Windows. Each job runs on a fresh runner, which is also the safest place
to self-test a workshop that changes anything outside its own directory;
see the warning under [test](#test).

## lint

```
jupyter workshop lint my-workshop [--json] [--platform linux|macos|windows] [--frontend jupyterlab|jupyterlite]
jupyter workshop lint collection.json [--json]
jupyter workshop lint catalog.json [--json]
```

Given a workshop directory, parses the manifest and every page and
reports problems: unknown
directives and options, missing bodies, capabilities used but not
declared (or declared but unused), invalid checks, quizzes and forms,
requirements that name nothing, variables used before the form that sets
them, danger heuristics such as piping a download into a shell,
variants missing for a listed platform or frontend, and actions a
listed frontend cannot run. Exits
with 1 when there are errors. `--json` prints the report as JSON for
other tools. `--platform` renders the pages as that platform sees them,
selecting its command variants and built-in variables, so a Linux CI
job can check the Windows version of a workshop; `--frontend
jupyterlite` does the same for JupyterLite, whose platform is always
`emscripten`, and switches on the JupyterLite rules.

Given a `collection.json` or `catalog.json` file, checks that it parses
as one, and for a catalog that every collection it names can be read
from where the catalog says it is, relative to the catalog file when not
a URL. Exits with 1 when something is wrong, which gives a repository of
workshops a CI check.

## render

```
jupyter workshop render my-workshop [PAGE] [--out FILE] [--platform NAME] [--frontend NAME]
```

Renders the pages to a standalone HTML document for previewing or for
static hosting. Action blocks are shown as boxes with their type and
body. Give a page id or path to render one page, and `--platform` or
`--frontend` to render another platform's or frontend's command
variants.

## pages

```
jupyter workshop pages my-workshop
```

Lists page ids, titles, paths and requirements.

## schema

```
jupyter workshop schema [--collection | --catalog | --events]
```

Prints the JSON schema of `workshop.yaml`, for editors and validators,
or with `--collection` the schema of a collection index file, with
`--catalog` the schema of a catalog, or with `--events` the schema of
the [progress events](analytics.md) a workshop reports, for a service
that receives them.

## publish

```
jupyter workshop publish my-workshop [--out dist] [--url URL]
```

Builds `dist/<name>-<version>.tar.gz` (excluding `_workshop`, `.git`,
`scratch` and similar), writes its SHA-256 next to it, and writes a
collection entry JSON snippet, `<name>-<version>.collection.json`, with
the hash and, when given, the URL the archive will be published at. The
archive is built with fixed ownership and timestamps so the hash is the
same on every machine.

## collection

```
jupyter workshop collection collection.json ENTRY... [METADATA...]
```

Merges the entry files written by `publish` into a collection index,
creating it if needed. An entry for a name that is already listed is
updated in place, keeping its position and the earlier versions, newest
first; a new entry is appended. The metadata options set the
collection's own fields and keep an existing index's values when not
given: `--title`, `--description`, `--publisher`, `--publisher-url`,
`--homepage`, `--icon` (a URL, a path relative to the file, or a `data:`
URI) and `--tag`, which may be repeated; `--ordered` says the workshops
form a sequence to take in the order listed, and `--unordered` takes
that back. See [Finding and installing workshops](collections.md) for
the index format and how the extension uses it.

## index

```
jupyter workshop index [DIRECTORY...] [--root ROOT] [--out FILE] [--repo URL] [--ref REF] [METADATA...]
```

Builds a collection index of every workshop found under the directories
given (the current directory by default), so a repository holding
several workshops can list them all without publishing archives. Each
entry's source is the workshop's path relative to `--root`, the git
checkout holding the first directory unless given, fetched from `--repo`
at `--ref`, which default to the checkout's origin and current branch; an
SSH remote is rewritten as the https URL. The index is written to
`collection.json` under the root, or `--out`, and an existing index is
updated: entries already listed keep their position and other versions,
new ones are appended in the order found, which for a directory that is
searched is path order. When every directory given is itself a workshop
directory, and between them they account for every workshop already
listed, the index is instead written in the order they are given, which
sets the order of a new index, moves a new workshop into the middle of
an existing one, or rearranges it. The metadata options are those
of `collection`. A `collection.yaml` in the root supplies what the
manifests cannot, the collection's `analytics` block, which is checked
and copied into the index; an existing index's block is kept when the
file is absent. Hidden directories, `node_modules`, build outputs and
`_workshop` state are not searched, nor are the contents of a workshop.
See [Several workshops in one repository](collections.md#several-workshops-in-one-repository).

## catalog

```
jupyter workshop catalog catalog.json [COLLECTION...] [--relative] [METADATA...]
```

Builds or refreshes a catalog from collection indexes. Each collection,
given as a URL or a file, is read and its entry written or refreshed
from the index's own title, description, publisher, icon and tags,
keeping an existing entry's position and appending new ones. With no
collections named, every entry already listed is re-read from where the
catalog says it is. `--relative` records a file by its path relative to
the catalog, for a repository that holds a catalog and its collections.
The metadata options set the catalog's own fields: `--title`,
`--description`, `--publisher`, `--publisher-url`, `--homepage` and
`--icon`. See [Catalogs](collections.md#catalogs).

## install

```
jupyter workshop install COLLECTION [--root ROOT] [--directory DIR] [--only NAME...] [--platform PLATFORM] [--frontend FRONTEND]
```

Installs every workshop of a collection that is not installed yet, the
way the browser's "Install all" does, for building an image or setting
up a classroom machine from a script. `COLLECTION` is the index's URL
or a file. The workshops land under `--directory` (`workshops`) beneath
`--root` (the current directory), which should be the JupyterLab root
so the browser lists them as installed; each records the collection it
came from, by URL or by the file's path relative to the root, so a
JupyterLab subscribed to the same collection matches them to their
entries and offers updates. Entries are taken in the collection's
order, the newest listed version of each, with the same hash check and
the same directory naming as the browser, so a name another
collection's workshop already occupies gets the collection's hash
appended. Workshops already installed are skipped. `--only` names one
workshop to install and may be repeated; `--platform` skips entries
whose platforms do not include the one given, and `--frontend` those
not written for the frontend given, where an entry listing no frontends
is for JupyterLab only; by default every entry is installed, since the
person building an image knows its platform. One line is printed per workshop and a count at the end, and
the exit status is 1 when any download failed, so a build stops on a
missing archive. See [Installing a whole collection](collections.md#installing-a-whole-collection).

## kernels

```
jupyter workshop kernels [--prune]
```

Lists the kernels registered for workshop [environments](environment.md):
the kernelspecs whose Python lives under a workshop's `_workshop/venv`
directory. Each line gives the name, `ok` or `stale`, and the Python it
starts; stale means that Python no longer exists, because the workshop
was removed or moved without its environment being removed first.
`--prune` unregisters the stale ones. Every other kernel, the server's
own included, is left alone whatever its state.

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
init, publish and draft work on a directory the agent names on each
call, relative to where the client started the server. The live tools
drive a running JupyterLab that has a workshop open in author mode,
found through `--url` and `--token`, else the `JUPYTER_SERVER_URL` and
`JUPYTER_TOKEN` environment variables, else the first server that
`jupyter server list` reports; the workshop path they open is relative
to that server's root. See [Tools for AI
agents](authoring.md#tools-for-ai-agents) for how the tools work and
where to start the client and JupyterLab.

## launch

```
jupyter workshop launch [TARGET] [--ref REF] [--subdir DIR] [--sha256 HASH]
                        [--collection URL]... [--catalog URL]
                        [--var NAME=VALUE]... [--restart[=force]]
                        [--welcome FILE] [--trust trusted|restricted|ask]
                        [--root DIR] [--port PORT] [--no-browser] [--fresh]
                        [-- jupyter lab options]
```

Starts JupyterLab with a workshop, collection or catalog open, so the
[launch link](collections.md#launch-links) that a learner would be
handed does not have to be typed by hand. `TARGET` is a workshop
directory under the root, a repository, forge tree or archive URL, or,
with `--collection`, the name of one of the collections' workshops;
left out, JupyterLab starts in the workshop browser. `--ref`, `--subdir`
and `--sha256` select within a URL as the link parameters of the same
names do, `--collection`, which can be repeated to list several in that
order, and `--catalog` add sources for the session,
`--var` sets workshop variables and `--restart` starts a workshop that
is already there over first, asking when it has recorded progress unless
`=force` is given. A collection, catalog or welcome file can be a URL or
a file under the root; a directory holding a `collection.json` or
`catalog.json` may be named in place of the file.

A collection or catalog named this way is added for the session, which
the browser keeps in the workspace's saved state, so a later launch on
the same root and workspace still lists it, in its order, until it is
removed in the Collections dialog or promoted by Subscribe; `--fresh`
starts without it.

The server runs on a free port unless `--port` is given, with the current
directory as its root unless `--root` names another; everything it opens
has to sit under that root, and a target outside it is refused with a
message saying so. Once the server answers, the link is printed and
opened in the browser, or only printed with `--no-browser`. JupyterLab's
log and its Ctrl-C handling are as for `jupyter lab`.

Two options settle the session rather than the link. `--trust` forces
the trust level, skipping the dialog, the way a deployment's
`trustPolicy` does; it is merged into the installed `overrides.json` for
the session only, so a Binder image's other settings still apply.
`--fresh` gives the server JupyterLab workspaces and user settings of its
own, as [test](#test) does, so a demo is not shaped by the tabs and
preferences of other sessions. Anything after `--` is passed to
`jupyter lab` unchanged, for options such as `--ip`.

Installed as a uv tool with the `lab` extra, `uv tool install
"jupyterlab-workshop[lab]"`, the command runs as `jupyter-workshop
launch` from any directory without a project environment; see
[getting started](getting-started.md#as-a-tool).

For a demo that must always start clean and never ask:

```
jupyter workshop launch workshops/git-basics --restart=force --trust trusted --fresh
```

## lite

```
jupyter workshop lite my-workshop [other-workshop ...] [--out DIR]
                                  [--default NAME] [--trust LEVEL]
                                  [--collection URL|FILE] [--catalog URL|FILE]
                                  [--settings FILE] [--welcome FILE]
                                  [--no-terminal] [--lite-dir DIR]
                                  [--serve] [--port PORT]
```

Builds a static [JupyterLite](lite.md) site carrying the workshops, with
the extension, the Pyodide kernel and the terminal, that any web host can
serve. Needs the `lite` extra; the terminal's build step needs `node`,
`npm` and `micromamba` unless `--no-terminal` is given. `--serve` serves
the result locally to try it out.

A site with one workshop, or with `--default NAME`, opens that workshop
on start; any other site starts in the workshop browser. `--collection`
takes the URL of a collection index, or a local `collection.json` (or
the directory holding one) that is carried in the site, so the browser
lists the workshops under the collection's title and in its order
without the build knowing where the site will be served from.
`--catalog` takes a URL or a local `catalog.json` in the same way, and
carries the collections the catalog names by relative path with it.
`--settings FILE` builds a settings file in the form of `overrides.json`
into the site, for an analytics block, disabled features and the like,
and `--welcome FILE` carries a Markdown file in the site and shows it as
the welcome message. [Publishing
workshops](publishing.md#a-jupyterlite-site) has the detail.

## test

```
jupyter workshop test my-workshop [--junit FILE] [--json FILE] [--in-place]
                                  [--headed] [--timeout SECONDS]
                                  [--action-timeout SECONDS]
                                  [--pace fast|demo|presentation]
                                  [--start-delay SECONDS] [--step-delay SECONDS]
                                  [--page-delay SECONDS]
                                  [--trust trusted|restricted|ask]
                                  [--lite | --frontend jupyterlite] [--lite-dir DIR]
```

Runs the workshop in a real JupyterLab: it copies the workshop to a
temporary directory (unless `--in-place`), starts a JupyterLab server on a
free port with trust forced to the chosen level, opens it in a headless
Chromium through Playwright, and runs the extension's self-test command.
That command walks every page, runs every action in order, waits for
each terminal command to finish, answers quizzes correctly, submits forms
with their defaults, and runs every check. Each action is reported as
pass, fail or skip, and the exit code is 1 when anything failed. `--junit`
writes a JUnit XML report for CI, `--json` the full results. Colour codes
and other control characters in a check's message, such as the ones
Python puts in a traceback on a terminal, are removed from every report.

A check runs under test the way it runs for a learner. A verify that
declares a [trigger](checks.md#verify) is given the same time to settle
that the trigger would give it: when it fails, it is tried again over
the next few seconds before the failure stands, so a check that reads
what an earlier command is still writing passes under test as it does
on the page. Where the trigger has already fired, as `after:` does the
moment the action before it completes, the self-test reports that run's
outcome rather than starting another. A verify with no trigger gets the
single attempt that clicking Check gives it.

Actions the page runs on its own are treated the same way. One with
`:auto: page-enter` fires as the page is entered, one reached by a
`cascade` or an `:auto: after:` follows the action before it, and the
learner sees each once; the self-test lets such a chain finish and
records the outcome of the run it made, reported with "Ran on its own"
where the action left no message, rather than running the action a
second time. Only what did not run on its own is run by the self-test,
and the same holds for Run actions and Run checks in author mode: to
run an automatic action again after editing it, click it.

```{warning}
The temporary copy protects the workshop's own files and nothing else.
Every terminal command, `execute-capture` body, `script` verify and
kernel check runs as you, on this machine, with your home directory,
your environment variables and the Python environment JupyterLab is
running in. A workshop written for a throwaway container or a fresh
account may change global git configuration, append to shell start-up
files, install packages into your project's environment, clone into
paths under your home directory, or remove paths it assumes it created.
Run a second time, such steps can fail or double up.

Read every command before testing a workshop you did not write, and test
one that reaches outside its own directory in CI, a container or a
disposable account rather than on a machine you care about; the
workflow written by `init --ci` runs on a fresh runner every time.
```

An action that is still running after `--action-timeout` seconds (default 300) is reported as failed and the run stops there, since later actions
would build on an unknown state. An `execute`, `execute-capture` or
`verify` whose directive names a longer `:timeout:` of its own (or that
inherits one from the manifest's `defaults.actions`) is given that plus
half a minute instead, so a step that waits on a build or a rollout is
not cut short by the flat limit. An action that opens a dialog nothing
will answer, such as a kernel selection or a confirmation, is failed
sooner, after the dialog has been open for ten seconds, with the
dialog's title in the message. `--timeout` (default 1200) bounds the
whole run: when it passes, the harness collects the results gathered so
far, records the action in flight as failed, and exits with code 1. All
three limits exist so that a stuck action in CI produces a report naming
it rather than a job that never ends.

### Pacing a run for an audience

The same run can be slowed down to watch, to record as a video or to
step through live in front of an audience. `--pace demo` pauses briefly
before each action (2s before the first, 1.5s before each one, 3s on
each new page), for a screen recording that will be edited; `--pace
presentation` pauses longer (5s, 4s and 8s), for people watching along.
A paced run scrolls each action into view in the instructions panel and
pulses it before the pause, so the viewer sees what is about to happen,
then runs it. The pauses are not charged against `--action-timeout`,
and a paced run takes a longer `--timeout` by default (2400s for demo,
3600s for presentation). `--start-delay`, `--step-delay` and
`--page-delay` set any one of the pauses in seconds on top of the pace.
Any pace but `fast` shows the browser, as `--headed` does, since there
is nothing to watch otherwise.

The MCP `run_workshop` and `run_page` tools take the same `pace` and
delays, and run in the JupyterLab you are looking at rather than a
headless one; see [Tools for AI agents](authoring.md#tools-for-ai-agents).

The server runs with JupyterLab workspace and user settings directories
of its own under the temporary directory, so nothing from your own
JupyterLab sessions reaches the run: no tabs the layout restorer would
put back (a console whose kernel the test server lacks would otherwise
raise a kernel selection dialog under the first action), no default
kernel, theme or disabled extension of yours, and the run writes nothing
into your JupyterLab state either. `--in-place` isolates the same way;
only the workshop directory is shared in that mode.

A workshop with an [isolated environment](environment.md) creates it
inside the temporary copy, and registers its kernel for your user. The
test unregisters that kernel again when it removes the copy, so no
kernel pointing at a deleted directory is left in the kernel picker.
With `--in-place` the environment and its kernel stay, since the
workshop does.

Requirements: the `test` extra, which installs Playwright, a library
that drives a browser from Python (`uv add "jupyterlab-workshop[test]"`
or `pip install "jupyterlab-workshop[test]"`), and a browser for it,
which `playwright install chromium` downloads into Playwright's own
cache. Terminals started by the test use a non-interactive pager so
commands such as `git diff` do not wait for a key press.

Commands in the tested workshop should not need input. A check that
depends on something only a person would do fails the self-test, which
is the point: the self-test is what a workshop's CI runs.

The self-test runs on Windows as well, where terminals are PowerShell
and `:windows:` command variants are selected; the workflow written by
`init --ci` covers Linux, macOS and Windows. `--lite`, or `--frontend
jupyterlite`, builds a JupyterLite site with the workshop instead of
starting a server, serves it from a static file server and drives that,
with `:jupyterlite:` variants selected; see [JupyterLite](lite.md) for
what it needs.
