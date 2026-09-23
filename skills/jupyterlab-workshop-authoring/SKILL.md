---
name: jupyterlab-workshop-authoring
description: Write, check, self-test and demonstrate guided JupyterLab workshops in the jupyterlab-workshop format (a workshop.yaml manifest plus MyST Markdown pages whose fenced directives are clickable actions). Use when asked to create or edit a workshop, add actions, checks, quizzes or forms to one, make one pass jupyter workshop lint and jupyter workshop test, or run one slowly to demonstrate it, record it as a video or step through it for an audience. Not for Educates Training Platform workshops, which use a different format and their own skill.
---

# jupyterlab-workshop authoring

This skill covers workshops for the jupyterlab-workshop extension only.
Workshops for the Educates Training Platform share the idea but not the
format, the tooling or the actions, so use the Educates skill for those.

A workshop is a directory that JupyterLab opens in a side panel. Learners
read the page and click the actions in it; each action drives the live
session (terminals, files, notebooks, the interface) and checks confirm
what they did. Everything is text: `workshop.yaml` and `pages/*.md`.

```
my-workshop/
  workshop.yaml          manifest: name, capabilities, variables, pages
  pages/01-welcome.md    one Markdown page per step, listed in the manifest
  pages/02-....md
  requirements.txt       optional, for an isolated Python environment
  files/                 optional, starter files copied into the workspace
  work/                  the learner's workspace, generated; never commit it
```

The workspace is always `work/`. It is created and filled from `files/` when the
workshop opens; Restart empties and refills it and leaves the pages
alone; checkpoints archive it alone; and paths in actions, terminals
and checks start there, so pages name the learner's files plainly.

The tooling is the `jupyter workshop` command (see the reference files
for the complete vocabulary). The same tools are available as MCP tools
from `jupyter workshop mcp`.

## Never run a workshop without checking what it does

`jupyter workshop test`, the MCP `test`, `run_action`, `run_page` and
`run_workshop` tools, and author mode's Run actions and Run checks all
run the workshop's commands for real: every `execute` body, every
`execute-capture` body, every `script` verify and kernel check runs as
the user, on their machine, with their home directory, environment
variables and Python environment. The self-test only protects the
workshop directory by working on a temporary copy. A workshop written
for a throwaway container can change global git configuration, append
to shell start-up files, install packages into the user's environment,
clone into paths under their home directory, or delete paths it assumes
it created, and a second run can fail or double those changes.

So, before running any of them:

- Read every command, check, capture body and script in the workshop.

- Run without asking only when every one of them stays inside the
  workshop directory and installs nothing: no `~`, `$HOME`, absolute
  paths, `--global`, `sudo`, package installs, or removal of anything the
  workshop did not itself create in its own directory.

- Otherwise do not run it. Tell the user what the workshop touches
  outside its directory and wait for them to say to run it, or suggest
  running it in CI (`init --ci` writes a workflow that runs on a fresh
  runner) or a container instead.

- If the user has already asked for the test to be run, run it, but
  still mention anything it will change outside the workshop.

## Workflow

1. Outline: decide the 4 to 8 steps a learner takes and what proves each
   step was done. Every page should end with something checkable.

2. Scaffold: `jupyter workshop init my-workshop --title "..."` (templates:
   `starter`, `blank`, `notebook`; `--platform`, `--capability`,
   `--gating` set the manifest). Or write the manifest by hand from the
   schema (`jupyter workshop schema`).

3. Write pages: prose that says why, then an action that does it, then a
   `verify` that checks it. Keep one idea per action. First read the
   sections of `references/gotchas.md` that match what the workshop
   does (Python code that is edited and re-run, packages, git, servers,
   notebooks): each names a trap that only shows up in that kind of
   workshop and what the manifest or page does about it.

4. Lint after every edit: `jupyter workshop lint my-workshop`. Fix every
   error; read the warnings. `--platform windows` checks the Windows
   variants. `--json` gives findings with `fix` hints.

5. Self-test: `jupyter workshop test my-workshop`. It runs every action,
   check, quiz and form in a real JupyterLab and prints PASS, FAIL or SKIP
   per action. Fix failures and run again until it is green. It runs the
   workshop's commands on the user's machine for real, so apply the rule
   above first: run it yourself only when everything stays inside the
   workshop directory, and otherwise ask. To let the user try the
   workshop in a browser, `jupyter workshop launch my-workshop` starts
   JupyterLab with it open (`--trust trusted` skips the trust dialog,
   `--restart=force` starts it over).

6. Publish when asked: `jupyter workshop publish my-workshop` writes an
   archive, its hash and a collection entry. For a repository holding
   several workshops, `jupyter workshop index` writes a `collection.json`
   listing them all instead (see below).

## Manifest (`workshop.yaml`)

```yaml
apiVersion: jupyterlab-workshop/v1alpha1
name: git-basics # lower case, digits, hyphens
title: Git from the command line
version: 0.1.0
description: One or two sentences.
homepage: https://github.com/me/workshops/tree/main/git-basics # optional; shown in the About dialog
issues: https://github.com/me/workshops/issues # optional; where learners report problems
tags: [git, cli]
duration: 30m
platforms: [linux, macos, windows]
capabilities: # what the pages need; lint checks this
  - terminal
  - write-files # writes are confined to work/; nothing carries a scope
  - kernel-exec
requires:
  tools:
    - { name: git, version: '>=2.30' } # missing or old tools are listed in the missing_tools built-in; install advice goes on page 1 under {when} "git" in missing_tools
    - { name: py, platforms: [windows] } # looked for on the listed platforms (or frontends) only
gating: soft # off, soft or strict
env: { PAGER: cat, PYTHONDONTWRITEBYTECODE: '1' } # for terminals, checks and captures; nothing by default; strings only, so quote numbers. Which values a workshop needs: references/gotchas.md
variants: # env and defaults.actions that differ by platform or frontend, keyed by marker name; frontend entry over platform entry over base
  windows: { env: { PAGER: more } }
variables:
  - {
      name: repo_dir, # exported to terminals as REPO_DIR; never reuse a shell name such as path
      type: path,
      default: demo,
      description: Where the repo goes
    }
pages:
  - pages/01-create-a-repository.md
  - pages/02-first-commit.md
```

Capabilities: `terminal` (run commands), `write-files` (create and change
files inside the workspace only; the pages, manifest and `files/` are
never writable), `kernel-exec` (run code in kernels; also needed by code
checks), `install-packages` (needed by `environment`), `auto-run`
(actions that run without a click: `:auto:` and `:cascade:`),
`ui-settings`. Declare exactly what the pages use; lint reports both
missing and unused capabilities.

Other fields: `instructions` (`side` and `width` of the instructions
panel, workshop-wide), `sidebar` (the other sidebar on opening: `hidden`,
the default, or a sidebar widget id such as `filebrowser`), `layout` and
`layouts` (named arrangements of the main area as a tree: an area is
either `tabs`, a list of `terminal:git`, `markdown:../README.md` (paths
start at the workspace, so a shipped README needs the `../`),
`file:<path>`, `notebook:<path>` or `launcher`, or a `split` of `rows` or
`columns` into `areas`; `size` is the fraction of the parent split, so a
terminal row at `0.4` leaves three fifths above it; `tabs: []` is the
placeholder for whatever else is open; `name` lets an action's `area`
option open into that area; a layout never closes anything; layouts are
not substituted, so write paths out rather than as `{{ }}` variables,
which would silently match no file; the built-ins both open a terminal:
`default` puts one named `workshop` below whatever is open and
`terminal-only` fills the main area with it, so a workshop without the
`terminal` capability names neither and either declares its own layout
or has no `layout` field, and lint reports `layout-terminal` otherwise),
`tracks` (alternative paths chosen with `choice` or a form field), `defaults` (`actions: { delay: 1s }`),
`environment` (`requirements`, `kernel`, `terminals`), `analytics`
(`sink`, `token`, `labels`), `frontends` (`jupyterlab`, `jupyterlite`;
none means JupyterLab only), `resumable` (`true` when the workshop can
be continued after JupyterLab restarts, since it keeps nothing live
between pages; leave it unset otherwise, and always for a workshop
whose pages share one notebook's kernel, where later pages use names
earlier pages defined: the notebook file survives a restart or a
JupyterLite reload and the kernel does not, so continuing lands the
learner on cells that raise `NameError`. Unset, the learner is asked
whether to restart. Lint reports `resumable-kernel-state`). A workshop with an `environment` puts an `environment-create`
action on its first page, before any notebook: the self-test runs only
what pages carry, and the action is a no-op once the environment
exists. Once created, the environment is first on `PATH` in workshop
terminals, captures and checks as well as being the notebook kernel, so
a terminal workshop that needs packages declares them in the
requirements file rather than walking the learner through `python -m
venv`; `terminals: false` keeps terminals on the bare `python` for a
workshop that teaches venvs.

## Pages

A page is Markdown with YAML front matter:

```markdown
---
title: Your first commit
requires: [verify:first-commit, quiz:staging] # gates leaving the page
optional: false
when: track == "cli" # hide the page otherwise
---

# Your first commit

Prose explaining the step. Use `{{ repo_dir }}` for variables.
```

Directives are fenced blocks named in braces. Options are `:name: value`
lines at the top of the block; the rest is the body:

````markdown
```{execute}
:id: first-commit-command
:session: git
:title: Record the commit
git commit -m "Add README"
```
````

A directive whose body holds a fenced code block, such as a `hint` that
quotes output or a `when` with a command in it, must itself be fenced
with more backticks than the block inside: four for the directive,
three for the code. Lint cannot see this mistake: the inner fence
closes the directive, its body is cut short and the prose after it
renders as code. A blank line straight after the options is a separator
and is dropped, the line break before the closing fence ends the last
line, and every other blank line, leading or trailing, is kept; so a
`file-write` append that must leave two blank lines above a Python
definition starts its body with three.

Every directive gets an id from `:id:` or, failing that, from the page id
and its position (`first-commit-2`). Give an explicit `:id:` to anything
another block refers to (a `requires` entry, a `trigger`, a `cascade`).
Common options on every action: `id`, `title`, `auto` (`page-enter` or
`after:<id>`), `cascade` (`true` or an id), `delay`, `scroll`, `when`,
`substitute`, `on-error` (`continue` keeps an automatic chain going after
a failure; by default a failure stops it).

Inline roles: `{copy}`git status``, `{open}`README.md``, `{var}`repo_dir``.

Variables: `{{ name }}` with filters `lower`, `upper`, `slug`, `default`,
`shell`, `path`; `{{ path "src/app.py" }}` renders the platform's
separator; `\{{` escapes. Built-ins: `platform` (`linux`, `macos`,
`windows` or `emscripten` in JupyterLite), `frontend` (`jupyterlab` or
`jupyterlite`), `shell`, `path_sep`, `home`, `user`, `workshop_dir`,
`workspace`, `host` (`binder`, `codespaces`, `jupyterhub`, `local` or
`static` for a JupyterLite site) and `container` (`true` inside a
container). Values come from the manifest defaults, launch links,
forms, captures and the variables panel.

Conditional content: `{when}` blocks (` ```{when} track == "pip" `) and
the `:when:` option on any directive. Conditions use `==`, `!=`, `in`,
`not in`, `and`, `or`, `not`.

Platform and frontend variants: inside a command body, a line
`:windows:` (or `:linux:`, `:macos:`, `:jupyterlab:`, `:jupyterlite:`)
starts that platform's or frontend's version; the text before the
first marker is the default, and a frontend variant wins over a
platform one. Windows terminals are PowerShell 5, which has no `&&`:
use `;`.

## Actions you will use most

| Directive                                                          | Purpose                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute`                                                          | Run a command in a terminal (`:session:`, `:cwd:`, `:wait: prompt` to wait for it to finish).                                                                                                                                                                                                                                   |
| `execute-capture`                                                  | Run a command in the background and store its output in a variable (`:capture:`).                                                                                                                                                                                                                                               |
| `file-write`                                                       | Write the body to `:path:` (`:open: true` to show it, `:mode: append`), or copy a shipped file with `:from:` (`:substitute: true` to fill in variables).                                                                                                                                                                        |
| `file-open`, `editor-insert`, `editor-replace`, `editor-highlight` | Open and edit files in the editor (`:path:` with `:line:` or `:match:`, plus `:regex:` and `:occurrence:`; `editor-replace` alone takes `:expand: true`, to expand regex group references in its body; a highlight with context is a `:line:` range); edits are saved unless `:save: false`; `file-close` closes a file's tabs. |
| `file-delete`, `file-rename`, `file-copy`, `directory-create`      | Manage files without a terminal, the same on every platform (`:path:`, `:to:` for the new path, `:recursive: true` to delete a directory, `:missing: ignore`).                                                                                                                                                                  |
| `notebook-create`                                                  | Create a notebook from a YAML list of `- markdown: ...` and `- code: ...` cells with optional `tags`. It replaces a notebook already there, the learner's work included, unless `:existing: keep`, which opens the existing one instead.                                                                                        |
| `cell-insert`, `cell-run`, `cell-run-all`, `kernel-execute`        | Add cells, run them, run code (`:path:` names the notebook; cells are found by tag or index).                                                                                                                                                                                                                                   |
| `hint`                                                             | Collapsible Markdown help.                                                                                                                                                                                                                                                                                                      |
| `verify`                                                           | A check; see below.                                                                                                                                                                                                                                                                                                             |
| `quiz`, `form`, `choice`                                           | Questions, value entry and track selection.                                                                                                                                                                                                                                                                                     |
| `checkpoint`, `restore`                                            | Snapshot and restore the workshop files.                                                                                                                                                                                                                                                                                        |
| `layout`, `panel-open`, `highlight`, `toast`, `tour`               | Arrange and point at the interface.                                                                                                                                                                                                                                                                                             |
| `url-open`                                                         | Open a web page in a new browser tab, or with `:pane:` in a named pane in the main area (`:url:` takes variables, `:label:` names the tab, `:area:` places a new pane).                                                                                                                                                         |

The full table with every option is in `references/actions.md`, and
`references/pages.md` covers the page syntax, the common options and how
the editor actions point at text.

### Links and web pages

Four ways to point the learner at a web page, and when each fits:

- A plain Markdown link, `[the docs](https://...)`, for a page the
  learner reads once. It opens in a new browser tab and JupyterLab stays
  where it is.

- `url-open` with `:pane:` for a page the learner keeps beside the
  work: their own running app, a dashboard, reference documentation.
  The pane is reused by name, so a later action can send it a new page,
  and sending it the same page again starts the page over, which is how
  to restart an app that would otherwise resume from its cache. Only
  for sites that allow framing: one that forbids it shows a blank pane
  and nothing can detect that, so try each URL once. Build the URL from
  variables where a host or port can differ, `https://{{ app_host }}/`;
  the action waits until every variable in it has a value.

- `url-open` without `:pane:` when an action, rather than a link, should
  open the tab: once a variable is known, or as a step in a sequence.
  The browser only allows a new tab on a click, so this cannot run with
  `:auto:`; lint warns.

- `command` with `docmanager:open` and `"factory": "HTML Viewer"` for an
  HTML file the workshop ships. Do not reach for `help:open` through
  `command`: `url-open` does the same with a reusable pane.

## Checks

````markdown
```{verify}
:id: first-commit
:label: You have made a commit
:trigger: after:first-commit-command; terminal-output "Add README"
import subprocess
out = subprocess.run(["git", "log", "--oneline"], capture_output=True, text=True).stdout
assert out.strip(), "No commits yet: run git commit"
```
````

`:substrate:` chooses where the check runs:

- `kernel` (default): Python in a hidden kernel, cwd is the workspace,
  variables in the environment. Raise or assert to fail; the assertion
  message is shown. Needs `kernel-exec`.

- `script`: a file in the workshop named by `:script:`, run by the server.

- `shell`: one command, run without a terminal by the hidden kernel as
  `subprocess.run(..., shell=True)` in the workspace, so under `/bin/sh`
  (no `pipefail`); exit code 0 passes and the whole trimmed output is the
  message, so shape it (see the style guide). It runs in the server's
  environment, not a shell the learner activated, so name the learner's
  tools by path (`.venv/bin/python -m pytest`), unless the manifest
  declares an `environment`, which is first on `PATH` here too. Needs
  `kernel-exec`.

- `contents`: predicates, one per line, no capability needed:
  `exists <path>`, `missing <path>`, `contains <path> <text>`,
  `matches <path> <regex>`, `cell-executed <notebook> <tag>`. Cannot see
  dot files such as `.git`; use `kernel` for those.

- `ui`: `terminal-open <session>`, `file-open <path>`, `notebook-open
<path>`, `panel-open <id>`, `kernel-idle <notebook>`.

- `learner-kernel`: Python run in the learner's notebook kernel
  (`:path:` names the notebook). The value of the last expression
  decides, and `False`, `None` or `0` fails; anything printed becomes
  the message, so `print("Decorate greet first")` then `False` says
  why. Only a body with no closing expression is judged on what it
  printed. Read names the cells assigned rather than calling the
  learner's functions again, and do not rely on a name that may not
  exist yet raising: a check that raises fails, with the error as its
  message.

`:trigger:` lists events that re-run it, separated by `;`: `page-enter`,
`after:<action id>`, `action`, `terminal-output "text"` or `/regex/`,
`file-saved <path>`, `cell-executed <tag>`, `interval 30s`. Clicking
Check always works. Prefer a trigger tied to the action the learner is
expected to run.

Quiz (`:type: single` or `multi`, `:attempts:`, `:shuffle: false` to
show the options as written):

````markdown
```{quiz}
:id: staging
question: Which command stages changes?
options:
  - { text: git commit, explanation: "git commit records what is staged." }
  - { text: git add, correct: true }
explanation: git add stages, git commit records.
```
````

Options are shuffled unless the quiz says `:shuffle: false`, because
the correct answer tends to be written first. The shuffle is one fixed
order per quiz id, the same for every learner, so also vary where the
correct option sits in the source. Grading and the self-test go by the
options as written.

The quiz body is YAML: quote any `question`, `text` or `explanation`
that contains `: `, `{`, `}` or, inside the one-line `{ ... }` option
form, a comma; lint reports the parse error, not the cause.

Form (fields become variables; `set_track: true` also picks the track):

````markdown
```{form}
:id: identity
- { name: user_name, type: text, label: Name, required: true, default: Learner }
- { name: user_email, type: email, label: Email, required: true, default: a@b.c }
```
````

Gating: list `verify:<id>`, `quiz:<id>` and `form:<id>` in a page's
`requires`; `gating: strict` in the manifest disables Next until they
pass, `soft` only shows what is missing.

## Rules that keep lint and the self-test green

- Declare every capability the pages use and no others.

- Every `execute` body is a real command the learner could paste. Commands
  must not wait for input: no pagers, editors or prompts (`git commit -m`,
  not `git commit`). Pagers count: a workshop that runs `git diff`,
  `git log` or `man` sets `env: { PAGER: cat, GIT_PAGER: cat }` in the
  manifest, or the self-test reports the command as never finishing.

- Traps that come with the subject rather than the format, such as
  Python's bytecode cache hiding an edit, git having no identity on the
  self-test machine, or a server never giving the prompt back, are in
  `references/gotchas.md` with the `env` value or page pattern that
  avoids each. Read the matching sections before the self-test, not
  after it fails.

- Give forms defaults so the self-test can submit them; give quizzes at
  least one `correct` option.

- A `verify` must pass right after the actions above it on the same page
  have run, in order, on a fresh copy of the workshop. Do not depend on
  state from a previous run.

- An `after:<id>` trigger fires when the command has been typed, not
  when it has finished; a failing triggered verify is retried for a few
  seconds, so quick commands need nothing, but give a slow command
  (`:wait: prompt`) so the check runs once the shell is back at its
  prompt.

- Ids referred to elsewhere (`requires`, `after:`, `cascade`) must exist;
  lint reports `unknown-requirement` and `unknown-action-id`.

- Restart and checkpoints only ever cover the workspace, so keep what a
  workshop creates inside it.

- A page is done when the learner leaves it forwards with its `requires`
  met; there is no button to mark it. The last page shows Finish, which
  opens a dialog with the manifest's optional `finish` Markdown (say
  where to go next) and what to do now. To checkpoint after a check,
  give the `verify` a `:cascade:` naming a `checkpoint` block.

- Keep `write-files` paths inside the workspace; lint warns on `..`,
  `~` and absolute paths, and reports as an error a write aimed at the
  pages, the manifest, `files/` or anywhere else outside the workspace.

- Do not pipe downloads into a shell, use `sudo`, or `rm -rf` outside the
  workshop; lint flags these and the trust dialog shows them.

- Interactive actions (`dialog`, `upload-prompt`, `tour`) are skipped by
  the self-test; do not gate a page on something only a person can do.

- Use `:wait: prompt` on `execute` when the next action or check depends
  on the command having finished (the self-test adds it automatically).

- Windows: add `:windows:` variants for commands that use `&&`, `export`,
  `ls`, `cat` or `/` paths, and list `windows` in `platforms` only when
  they are covered. `jupyter workshop lint --platform windows` checks.

- JupyterLite (`jupyterlite` in `frontends`; a manifest without
  `frontends` is JupyterLab only): there is no server, `python` or
  `git` in the terminal, and its shell has no `&&`, `$VAR` or `$(...)`.
  Add `:jupyterlite:` variants (an empty one means nothing to do),
  avoid `subprocess` in kernel checks and `script` verifies, and keep
  `execute-capture` bodies to shell commands. `jupyter workshop lint
--frontend jupyterlite` checks; `jupyter workshop test --frontend
jupyterlite` runs the workshop in a JupyterLite build. That build needs
  `node`, `npm` and `micromamba` on the path only when the workshop uses
  the terminal (the `terminal` capability, an `execute-capture` or a
  `shell` check); a notebook workshop is tested on a site without one. A
  reload is routine there and empties the kernel, so the `resumable` rule
  above matters most in JupyterLite. `references/gotchas.md` lists what
  Pyodide cannot do.

- A notebook workshop that should open with its notebook showing puts
  `:auto: page-enter` and `:existing: keep` on the `notebook-create` of
  its first page (with the `auto-run` capability). Do not name the
  notebook in the opening layout instead: the layout is applied before
  any page runs, finds no file and silently leaves it out, which the
  self-test only notes as a skipped `(workshop)/layout` line.

## Reading test output

`jupyter workshop test` runs the workshop for real on the user's machine
(see the rule at the top). It prints one line per action:
`PASS page/id (type, 1.2s)`, `FAIL page/id (verify, 0.3s)  message`,
`SKIP ...`. The message of a failed `verify` is the assertion text or
predicate that failed; a failed `execute` usually timed out waiting for
the prompt (a command waiting for input) or ran in the wrong directory
(`:cwd:` is relative to the workspace). `Blocked by a dialog nobody can
answer: "<title>"` means a JupyterLab dialog opened under the action and
the run stopped there; the title says which, and a kernel picker means a
notebook or console opened on a kernel the server does not have. The
server log is printed only after a failure; `--json report.json` writes
the full results with every action's message. Fix, lint, test again.

## Style

Write for someone reading a narrow side panel: short paragraphs, one
action per paragraph, the action's `:title:` or its command saying what
it does, a `hint` for background rather than a wall of text. Headings:
one `#` per page matching the front matter title, `##` sparingly. Use
present tense and second person. Do not use emdashes. See
`references/style-guide.md` and `references/page-template.md`;
`references/gotchas.md` lists the traps that come with a subject.

## Several workshops in one repository

Put each workshop in its own directory (for example `workshops/<name>/`)
and keep one `collection.json` at the repository root: a collection is a
published list of workshops. Build and update it with
`jupyter workshop index workshops` from the checkout; it reads every
manifest under the directories given and gives each entry a git source
with the path relative to the checkout (`--repo` and `--ref` default to
the git origin and branch, so pass `--ref` a tag to pin a release). The
order of the file is the order the browser shows and is kept on update.
A directory that is searched lists its workshops in path order, which
is rarely the teaching order, so for a course name the workshop
directories themselves in sequence (`jupyter workshop index
workshops/first workshops/second workshops/third --ordered`): named one
by one and covering everything already listed, they are written in the
order given, which is also how a new workshop goes into the middle of a
course;
`--title`, `--description`, `--publisher`, `--icon` and `--tag` describe
the collection itself, and `--ordered` says the workshops form a
sequence, which numbers them in the browser. Commit the index. Learners subscribe to the raw
URL of `collection.json` through the browser's Collections dialog or open
`lab?collection=<url>`; `lab?collection=<url>&workshop=<name>` installs
one workshop of it.

Several collections can be listed in a `catalog.json`, a published list
of collections, built with `jupyter workshop catalog catalog.json
<collection files or URLs> --relative`, which restates each collection's
title, description and icon; rerun it with no collections named to
refresh. Learners subscribe to a catalog and pick collections from it, or open
`lab?catalog=<url>`. `jupyter workshop lint` checks either file.

To make the repository launch on Binder, add `binder/requirements.txt`
(`jupyterlab>=4.6,<5` and `jupyterlab-workshop`), `binder/runtime.txt`
(`python-3.14`) and an executable `binder/postBuild` that writes
`$NB_PYTHON_PREFIX/share/jupyter/lab/settings/overrides.json` with
`"@jupyterlab-workshop/labextension:panel": {"defaultWorkshop": "",
"browseOnStart": true, "workshopsDirectory": "workshops",
"trustPolicy": {"forcedLevel": "trusted"}, "disabledFeatures":
["open-directory", "open-url", "collections", "catalogs", "remove",
"author"]}`. The
session then starts in the workshop browser with the checkout's
workshops listed as installed, and the disabled features keep learners
to them: no other directories or URLs, no editing, no removing, with
Restart to put a workshop back as it started. Other keys are
`available`, `install-all` (the browser's Install all and Remove all
for a collection), `close` and `browse` (for an image running one
workshop). An image built from a published collection rather than a
checkout can run `jupyter workshop install <collection-url> --root .`
in postBuild to fetch the workshops at build time.
The launch URL is `https://mybinder.org/v2/gh/<org>/<repo>/<branch>?urlpath=lab`;
add `%3Fworkshop%3Dworkshops%2F<name>` to open one workshop directly.

## Author mode and live tools

In JupyterLab, "Workshop: Author Mode" adds a toolbar to the panel
(edit page, new page, manage pages, insert action, capture from session,
run the page's actions or checks, lint, trust preview, publish) and the
Record toggle, which captures terminal commands, file saves and cell
runs into draft pages (`jupyter workshop record` turns a saved recording
into pages). Edits to the files re-render the panel as they are saved.

Over MCP (`jupyter workshop mcp`), `lint`, `render`, `pages`, `test`,
`init`, `publish`, `index`, `catalog`, `draft`, `get_schema`,
`list_collection` and `list_catalog`
work on directories; `open_workshop`, `session_status`, `run_action`, `run_page`,
`run_workshop`, `run_progress` and `reset_workshop` act on a running
JupyterLab that has the workshop open in author mode. That JupyterLab
is the one named by `--url` and `--token` on `jupyter workshop mcp`,
else by `JUPYTER_SERVER_URL` and `JUPYTER_TOKEN`, else the first server
`jupyter server list` reports, which with several running may be
another checkout's: pin it when `session_status` answers for the wrong
one.

### Demonstrating or recording a workshop

When the user wants the workshop shown rather than tested (a demo, a
walkthrough, a video, stepping through it live for an audience, "run it
slowly"), run it with a `pace` rather than picking delays:

- `run_workshop` with `pace="presentation"` for people watching along,
  or `pace="demo"` for a screen recording that will be edited. Both
  scroll each action into view and pulse it before pausing, then run
  it, and pause again on each new page. Only set `start_delay`,
  `step_delay` or `page_delay` when the user names a timing.

- Prepare the session first: the instructions panel visible and the
  layout applied (`open_workshop` does this), leftover terminals and
  tabs from earlier runs closed, and `reset_workshop` so gated pages
  replay from the start rather than being skipped as already done. A
  second take starts with `reset_workshop` again.

- Start a paced run with `wait=False` and follow it with
  `run_progress`, which carries the report when it finishes; a paced
  run of a long workshop outlasts a single tool call.

- Pass `action_timeout` when the workshop has steps that take minutes
  and do not name a `:timeout:` of their own; a check that waits on a
  cluster or a build otherwise stops the run in front of the audience.

- `jupyter workshop test --pace presentation` does the same in a
  browser of its own, for a recording that needs no agent.

The rule at the top of this file is unchanged: a paced run executes
every command for real, in front of people, so read the workshop first
exactly as for a test run.
