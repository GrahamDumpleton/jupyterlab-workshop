# How workshops work

This page explains the pieces that make up a workshop and how the
extension runs one, so the reference pages have something to hang on.
Nothing here needs to be memorised; each section links to the page that
has the details.

## The panel and the session

A workshop is read in the Workshop panel, a JupyterLab sidebar tab, one
page at a time. The rest of the window is the session the workshop
drives: terminals, the file browser, the editor, notebooks and kernels,
all the ordinary JupyterLab that the learner would use anyway. The
instructions do not simulate any of it. When a page says "run this
command", clicking the box runs that command in a real terminal, and the
learner can equally type it, or something else, themselves.

A workshop can say how the window should look when it opens, for example
a rendered README above a terminal, through a [layout](layouts.md).

The panel's header holds the buttons for the things a learner does most:
open, browse, restart, variables, trust. Every command the extension
adds is also in JupyterLab's command palette, the searchable list opened
with Ctrl+Shift+C (Cmd+Shift+C on a Mac) or View, Activate Command
Palette, under the prefix "Workshop:", which is how the docs name them.

## A workshop is a directory

A workshop is a directory holding two kinds of file:

- `workshop.yaml`, the manifest: the name and title, the platforms it
  was written for, the capabilities its pages need, its variables, its
  layouts, and the ordered list of pages. The
  [manifest reference](reference/manifest.md) lists every field.

- `pages/*.md`, one MyST Markdown page per step, with a title in front
  matter and, optionally, the checks that must pass before moving on.

Everything is plain text, so a workshop lives happily in git, and the
`jupyter workshop` [command line](cli.md) scaffolds, lints, self-tests
and publishes one from the files alone.

## Actions

An action is a fenced block whose name is in braces, such as
` ```{execute} ` or ` ```{file-write} `, with options on `:name: value`
lines and a body. In the panel it renders as a box with a description of
what it will do, and clicking it does that. There are actions for
terminals, files and the editor, notebooks and kernels, the interface,
guidance such as hints and tours, flow, checks, and a few external
things such as the clipboard. The [action reference](actions.md) lists
them all with their options.

Actions normally run when clicked. A page can also run one automatically
when it opens, or cascade from one action to the next, for setup the
learner need not watch.

## Capabilities and trust

Every action type needs a capability: `terminal`, `write-files`,
`kernel-exec`, `network`, `install-packages`, `ui-settings`, or none.
The manifest declares the capabilities the workshop uses, and an action
whose capability is not declared never runs. When a workshop opens, the
trust dialog shows the source, a content hash, the declared capabilities
with how many actions use each, and any lint findings, and the learner
chooses a level. Trust runs everything. Restricted types commands into
the terminal without pressing Enter and asks before writing files or
running code. Ask each time confirms every action that needs a
capability. The decision is remembered for that source at that content,
so a changed workshop asks again. An administrator can settle the level
for everyone. [Loading and trust](trust.md) has the details.

## Checks, gating and progress

A `verify` block checks what the learner has done: Python run in a
hidden kernel, a script on the server, a shell command, or predicates
over files and the interface. A `quiz` asks a question and a `form`
collects values. A page's front matter can require some of them to be
complete before moving on, and the manifest's `gating` says whether
that is advisory or enforced. Leaving a page forwards with its
requirements met marks it done, which is what the progress bar, the
ticks in the page list and the browser's page count show. Finish on the
last page opens a dialog with what to do next. A `checkpoint` block
snapshots the files so a later page can put them back.
[Checks, forms, gating and checkpoints](checks.md) covers all of it.

## Variables

Pages and actions can refer to variables with `{{ name }}`. Values come
from the manifest's defaults, a launch link, a form the learner fills
in, output captured from a command or kernel, or an `env-set` action,
and a few built-ins describe the platform, the shell and where the
workshop is. Variables reach terminals as environment variables and
`when` conditions show or hide content by them. The [platforms
page](platforms.md) covers the built-ins and the [action
reference](actions.md) the ways of setting and showing them.

## Where workshops come from

A workshop is opened from a local directory, which is how authors work;
from the workshop browser, which lists the workshops of the subscribed
collections and installs one under the `workshops` directory; from a
repository or archive URL; or from a launch link, a JupyterLab URL with
a `workshop` parameter that fetches and opens it as JupyterLab starts.
A collection is a published list of workshops, a JSON index that the
`jupyter workshop publish`, `collection` and `index` commands build; a
catalog is a published list of collections, so one URL can point at
everything an organisation offers. There are no subscriptions out of
the box.
[Finding and installing workshops](collections.md) covers the browser,
collections, catalogs, launch links and deployments such as Binder.

## State on disk

Everything the extension records about a workshop lives in a
`_workshop` directory inside it, which git ignores:

| Path                           | Holds                                                                      |
| ------------------------------ | -------------------------------------------------------------------------- |
| `state.json`                   | Page progress, action results, captured variables and the action log.      |
| `source.json`                  | Where a downloaded workshop came from and its hash.                        |
| `env.sh`, `env.ps1`, `env.cmd` | The variables as environment variables, loaded by the workshop terminals.  |
| `snapshots/`                   | Checkpoints, including the `pristine` one taken when first opened.         |
| `events.jsonl`                 | [Progress events](analytics.md), one per line.                             |
| `environment.json`, `venv/`    | An [isolated environment](environment.md), when the workshop asks for one. |
| `recordings/`                  | Sessions recorded in author mode.                                          |

Restart restores the pristine snapshot and forgets the progress; Reset
Progress keeps the files; Remove deletes a downloaded workshop
altogether. The trust decision is kept in JupyterLab's own state
database rather than here, so removing the directory does not forget it
on its own, but Remove does.

## Server and JupyterLite

A JupyterLab server does the downloading, script checks, checkpoints,
preflight checks of required tools and event reporting through a small
server extension. In [JupyterLite](lite.md) there is no server, and the
extension does those things in the browser instead, with a Pyodide
kernel and a WebAssembly shell, so a workshop can be published as a
static site. The differences are listed on that page.
