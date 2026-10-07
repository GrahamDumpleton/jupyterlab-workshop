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
directives and options, missing bodies, a directive closed early by the
fence of a block inside it, capabilities used but not
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
body, so a quiz, choice or form appears as its source rather than as
the panel renders it. Give a page id or path to render one page, and `--platform` or
`--frontend` to render another platform's or frontend's command
variants.

## pages

```
jupyter workshop pages my-workshop
```

Lists page ids, titles, paths and requirements.

## schema

```
jupyter workshop schema [--collection | --catalog | --events | --library]
```

Prints the JSON schema of `workshop.yaml`, for editors and validators,
or with `--collection` the schema of a collection index file, with
`--catalog` the schema of a catalog, with `--events` the schema of
the [progress events](analytics.md) a workshop reports, for a service
that receives them, or with `--library` the schema of a
[workshop library](library.md#the-registry)'s `library.json`.

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

## gist

```
jupyter workshop gist my-workshop [--out dist/gist] [--create [--public] | --update [GIST]]
                                  [--token TOKEN] [--site URL | --python X.Y]
                                  [--binder URL | --no-binder]
                                  [--append-readme] [--frontend NAME]
```

Lays a workshop out as a [GitHub gist](https://gist.github.com) holds
it and, with `--create` or `--update`, sends it there. A gist is a git
repository with no directories, so every file is stored under its path
with the directory separators turned into `--`, `pages/01-welcome.md`
as `pages--01-welcome.md`, and a `workshop-tree.json` maps each path
back to its gist file. Nothing in the workshop is rewritten: a download
of the gist puts every file back at its path. The files carried are the
ones [publish](#publish) would archive, less hidden files, editor
droppings and the workshop's own `README.md`; the command prints each
file it stores under a different name, and reports what it left out. A
file that is not text is stored as base64 under a name ending
`.base64`, and an empty file is recorded in the tree alone, since the
gists API carries neither. The workshop is linted before, and after
writing the flat copy under `dist/gist/<name>/` the command puts the
copy back together the way a download would and lints that, with
`--frontend jupyterlite` selecting the JupyterLite rules for a gist
meant for the [demo site](demo.md).

A `README.md` is generated as well, which GitHub pins to the top of
the gist page: the title, description, version, authors, duration,
tags, platforms and frontends from the manifest, then how to open the
workshop, starting by saying that the gist is a workshop to take rather
than pages to read. Each way to start it is a button with a plain link
beside it: one that opens the gist in a JupyterLite site, when the
manifest lists `jupyterlite` among its frontends, and one that opens it
in JupyterLab on mybinder.org, and it always gives the JupyterLab
routes: the "Open Workshop from URL…" command, a launch link and
`jupyter workshop launch`. The
workshop's own `README.md` is left out unless `--append-readme` adds it
below the generated part. In the flat copy on disk the README names a
gist that does not exist yet; creating or updating the gist writes it
again with the real address.

The button opens one of the project's published [launcher
sites](publishing.md#a-launcher-for-launch-links), each of which carries
one Python version. The version is chosen from the manifest: a `python`
or `python3` entry under `requires.tools` with a version requirement
picks the newest launcher that meets it, and a manifest that says
nothing gets the newest; a requirement no launcher meets is an error.
`--python X.Y` names the launcher outright, and `--site URL` points the
button at a JupyterLite site of your own instead. The chosen launcher
is printed as `launcher`.

The README also carries a button that opens the gist in JupyterLab on
[mybinder.org](https://mybinder.org), through the project's [Binder
launcher](https://github.com/GrahamDumpleton/jupyterlab-workshop-binder),
a repository that installs JupyterLab with the extension and nothing
else, with the gist named by the launch link in mybinder's `urlpath`.
It is left out when the manifest's frontends leave out `jupyterlab`, or
its platforms leave out `linux`, which is what Binder runs. `--binder
URL` points the button at a launcher repository of your own, given as
its `https://mybinder.org/v2/...` address, and `--no-binder` leaves the
button out.

`--create` makes a new gist, secret unless `--public` is given, and
`--update` replaces the files of an existing one, given by URL or id,
removing any the flat copy no longer has. Each update is one revision
in the gist's history, where removed files stay readable. Either way the
gist is recorded in the workshop's `_workshop/gist.json` (its address,
id, whether it is public, and when it was created and last updated), so
`--update` with no gist named updates the recorded one; with nothing
recorded it is an error. `--create` with a gist already recorded makes
a new one and records that instead. Both need a
GitHub token with
the `gist` scope, from `--token`, else `GH_TOKEN` or `GITHUB_TOKEN`,
else `gh auth token` for someone signed in to the `gh` command. See [A
workshop in a gist](publishing.md#a-workshop-in-a-gist).

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

In a [workshop library](library.md), each workshop goes in its
collection's own directory under `collections/`, and the library is
subscribed to the collection.

## library

```
jupyter workshop library [DIR] [--init-only] [--collection URL...] [--trust LEVEL] [--port PORT] [--no-browser] [--fresh] [--token TOKEN] [-- ARGS...]
```

Starts JupyterLab with a [workshop library](library.md) as its root,
creating the library the first time. `DIR` defaults to the
`JUPYTER_WORKSHOP_LIBRARY` environment variable when it is set, and
otherwise to `~/Workshops`. The library's registry is `library.json` in
`DIR`, and `workshopsDirectory` is set to `.` for the session, so the
root is the library. A linked project whose link has gone while its
repository is still there is relinked first. `--init-only` creates the
library and stops; the other options are those of [launch](#launch),
and arguments after `--` go to `jupyter lab`.

## subscribe and unsubscribe

```
jupyter workshop subscribe LOCATION [--catalog] [--root ROOT] [--directory DIR | --library]
jupyter workshop unsubscribe LOCATION [--catalog] [--root ROOT] [--directory DIR | --library]
```

Adds a collection, or with `--catalog` a catalog, to a workshop
library's subscriptions, or removes it. `LOCATION` is the index's URL
or a path relative to the JupyterLab root, matched however it is
spelled. The library is `--directory` (`workshops`) under `--root` (the
current directory), or with `--library` the default library that
[library](#library) opens. A directory that is not a library is
refused, since outside a library subscriptions live in the JupyterLab
settings, which the workshop browser changes.

## list

```
jupyter workshop list [--json] [--root ROOT] [--directory DIR | --library]
```

Lists the installed workshops, with where each is, its version and its
progress, and in a library its subscriptions. In a library each
workshop has its kind: `installed`, `personal` or `project`. `--json`
prints an object with `directory`, `library` (whether it is one),
`collections` and `catalogs` (the registry's lists, or null when the
settings apply) and `workshops`, the records the browser reads; the
shape is stable for scripts to rely on.

## update

```
jupyter workshop update [NAME...] [--yes] [--root ROOT] [--directory DIR | --library]
```

Installs the newest version a collection lists of each workshop
installed from it, where that differs from the installed version, as
the browser's Update button does. `NAME` is a workshop's name or its
path, and every installed workshop is checked when none is given; a
name two installs share must be given as a path. Updating replaces the
workshop, which resets its progress, so the command lists the updates
and asks first; `--yes` goes ahead without asking, and is needed when
there is no terminal to ask at.

## remove

```
jupyter workshop remove NAME... [--delete] [--yes] [--root ROOT] [--directory DIR | --library]
```

Removes installed workshops as the browser's Remove button does: a
downloaded workshop is deleted, and any other, a local directory, a
library's own workshop or a project's, loses only its recorded
progress, `_workshop/`, keeping its files. `--delete` deletes the
directory of such a workshop as well, as the browser's Delete does for
one of your own. It lists what it will do and asks first unless given
`--yes`.

## project

```
jupyter workshop project link PATH [--name NAME] [--workshops DIR] [--root ROOT] [--directory DIR]
jupyter workshop project unlink NAME [--root ROOT] [--directory DIR]
jupyter workshop project list [--json] [--root ROOT] [--directory DIR]
```

Manages the [projects](library.md#projects) of a workshop library. A
repository cloned under the library's `projects/` is a project without
any of these; `link` brings in one kept elsewhere, as a symbolic link,
or a directory junction on Windows, at `projects/NAME` (the
repository's directory name by default), recorded in the registry.
`--workshops` names its workshops directory when it is not
`workshops`. `unlink` removes a linked project's link and entry, never
its files, and works when the repository has gone. `list` shows each
project as cloned, linked or missing; `--json` prints them as an
object with a `projects` list. These commands act on the default
library unless `--root` or `--directory` name another.

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
                        [--collection URL]... [--catalog URL] [--install]
                        [--var NAME=VALUE]... [--restart[=force]]
                        [--welcome FILE] [--trust trusted|restricted|ask]
                        [--analytics always|never|ask]
                        [--root DIR] [--port PORT] [--no-browser] [--fresh]
                        [--container | --no-container] [--token TOKEN]
                        [--url URL] [-- jupyter lab options]
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
starts without it. With `--install`, every workshop of the collections
named that is not installed yet is installed before the server starts,
as [install](#install) does, into the workshops directory the installed
overrides name, taking only the entries for this operating system and
for JupyterLab, so the learner finds them under Installed rather than
installing each on click; a workshop that cannot be downloaded stops the
launch. A catalog is added for the session only, since one can list far
more than a learner wants.

The server runs on a free port unless `--port` is given, with the current
directory as its root unless `--root` names another; everything it opens
has to sit under that root, and a target outside it is refused with a
message saying so. Once the server answers, the link is printed and
opened in the browser, or only printed with `--no-browser`. JupyterLab's
log and its Ctrl-C handling are as for `jupyter lab`.

Three options settle the session rather than the link. `--trust` forces
the trust level, skipping the dialog, the way a deployment's
`trustPolicy` does; it is merged into the installed `overrides.json` for
the session only, so a Binder image's other settings still apply.
`--analytics` sets the `report` key of the analytics setting the same
way: `always` reports to the sink a collection or a workshop declares
without asking, `never` reports to none, and `ask` offers the opt-in in
the trust dialog, which is the installed default; see [reporting to a
sink](analytics.md#reporting-to-a-sink).
`--fresh` gives the server JupyterLab workspaces and user settings of its
own, as [test](#test) does, so a demo is not shaped by the tabs and
preferences of other sessions. Anything after `--` is passed to
`jupyter lab` unchanged, for options such as `--ip`. The session's
overrides also turn off JupyterLab's question about fetching Jupyter
news, unless the installed overrides settle it, so the first thing shown
is the workshop and not that prompt; see [the Jupyter news
prompt](deploying.md#the-jupyter-news-prompt).

Inside a container the command serves the container instead of a
desktop. Container mode is on when the platform detection finds a
container, or with `--container` anywhere, and `--no-container` turns
it off. In that mode the server listens on every interface on port
8888, the port Jupyter images publish, unless `--port` says otherwise;
the token is `--token`, or the `JUPYTER_TOKEN` variable when set, so a
restarted container keeps its link, and only otherwise generated; the
trust level is forced to `trusted` unless `--trust` chooses another,
since whoever ran the image or named the collection chose the
workshops; and no browser is opened. The link is printed against
`http://127.0.0.1:8888`, which is right when the container publishes
that port on the same machine, or against `--url` when it is reached at
another address, such as behind a proxy. The published image starts
with this command; see [a container image](deploying.md#a-container-image).

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
jupyter workshop lite [my-workshop ...] [--out DIR] [--python X.Y]
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

With no workshop at all the site is a launcher: it starts in an empty
workshop browser and opens whatever a [launch
link](collections.md#launch-links) names in its `workshop` parameter,
such as a gist. The Python the site provides is whichever the installed
Pyodide kernel package carries, which `jupyter workshop lite` writes
into the site's configuration so the preflight can check a workshop's
Python requirement against it; `--python X.Y` makes the build fail
unless that is the version it would carry, for a site published under
a path that names its Python. See [A launcher for launch
links](publishing.md#a-launcher-for-launch-links).

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
the welcome message. The site's settings turn off JupyterLab's Jupyter
news prompt unless the file settles it. [Publishing
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
free port with trust forced to the chosen level and the Jupyter news
prompt off, opens it in a headless Chromium through Playwright, and runs
the extension's self-test command.
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

The self-test follows the path where the learner gets everything right.
What a check says on a wrong answer is tested by an
[attempt](checks.md#attempt), a block the learner never sees: the
self-test runs the actions it holds, then the check it names, and
passes the attempt when the check fails saying what the attempt
expects. Each attempt is one line of the report, with what the check
said.

An action that waits for a person, `dialog`, `upload-prompt` or `tour`,
is not run and is reported as a skip. A `tour` is still checked as far
as it can be without stepping through it: a step whose selector matches
nothing on screen at that point of the page is reported as a failure,
as the tour would fail there for a learner.

The self-test waits for the instructions panel to show each page before
running the page's actions, so a `highlight`, `tooltip` or `tour` may
point at part of the panel itself, such as its header or footer.

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
