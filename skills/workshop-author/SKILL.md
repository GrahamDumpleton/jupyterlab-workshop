---
name: workshop-author
description: Write, check and self-test guided JupyterLab workshops in the jupyterlab-workshop format (a workshop.yaml manifest plus MyST Markdown pages whose fenced directives are clickable actions). Use when asked to create or edit a workshop, add actions, checks, quizzes or forms to one, or make one pass jupyter workshop lint and jupyter workshop test.
---

# Workshop author

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
```

The tooling is the `jupyter workshop` command (see the reference files
for the complete vocabulary). The same tools are available as MCP tools
from `jupyter workshop mcp`.

## Workflow

1. Outline: decide the 4 to 8 steps a learner takes and what proves each
   step was done. Every page should end with something checkable.

2. Scaffold: `jupyter workshop init my-workshop --title "..."` (templates:
   `starter`, `blank`, `notebook`; `--platform`, `--capability`,
   `--gating` set the manifest). Or write the manifest by hand from the
   schema (`jupyter workshop schema`).

3. Write pages: prose that says why, then an action that does it, then a
   `verify` that checks it. Keep one idea per action.

4. Lint after every edit: `jupyter workshop lint my-workshop`. Fix every
   error; read the warnings. `--platform windows` checks the Windows
   variants. `--json` gives findings with `fix` hints.

5. Self-test: `jupyter workshop test my-workshop`. It runs every action,
   check, quiz and form in a real JupyterLab and prints PASS, FAIL or SKIP
   per action. Fix failures and run again until it is green.

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
tags: [git, cli]
duration: 30m
platforms: [linux, macos, windows]
capabilities: # what the pages need; lint checks this
  - terminal
  - write-files: [workspace] # scopes: workspace, home, any
  - kernel-exec
requires:
  tools:
    - { name: git, version: '>=2.30', hint: { linux: apt install git } }
gating: soft # off, soft or strict
env: { PAGER: cat, GIT_PAGER: cat } # exported to terminals; nothing by default
variables:
  - {
      name: repo_dir,
      type: path,
      default: demo,
      description: Where the repo goes
    }
pages:
  - pages/01-create-a-repository.md
  - pages/02-first-commit.md
```

Capabilities: `terminal` (run commands), `write-files` (create and change
files; scope `workspace` keeps writes inside the workshop directory),
`kernel-exec` (run code in kernels; also needed by code checks),
`network`, `install-packages` (needed by `environment`), `auto-run`
(actions that run without a click: `:auto:` and `:cascade:`),
`ui-settings`. Declare exactly what the pages use; lint reports both
missing and unused capabilities.

Other fields: `layout` and `layouts` (named panel arrangements: `left` and
`right` take `instructions`, `collapsed`, a sidebar widget id, or a mapping
of `widget`, `collapsed` and `size`; `main` lists regions of `area`,
`widgets` such as `terminal:git`, `markdown:README.md`, `file:<path>`,
`notebook:<path>` or `launcher`, and `size`; built-ins are `default`,
`terminal-only` and `notebook`), `tracks` (alternative paths chosen with
`choice` or a form field), `defaults` (`actions: { delay: 1s }`),
`environment` (`requirements`, `kernel`), `analytics` (`sink`).

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
separator; `\{{` escapes. Built-ins: `platform`, `shell`, `path_sep`,
`home`, `user`, `workshop_dir`, `host` (`binder`, `jupyterhub`, `local`
or `lite`) and `container` (`true` inside a container). Values come from
the manifest defaults, launch links, forms, captures and the variables
panel.

Conditional content: `{when}` blocks (` ```{when} track == "pip" `) and
the `:when:` option on any directive. Conditions use `==`, `!=`, `in`,
`not in`, `and`, `or`, `not`.

Platform variants: inside a command body, a line `:windows:` (or
`:linux:`, `:macos:`, `:lite:`) starts that platform's version; the text
before the first marker is the default. Windows terminals are PowerShell
5, which has no `&&`: use `;`.

## Actions you will use most

| Directive                                                          | Purpose                                                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute`                                                          | Run a command in a terminal (`:session:`, `:cwd:`, `:wait: prompt` to wait for it to finish).                                                            |
| `execute-capture`                                                  | Run a command in the background and store its output in a variable (`:capture:`).                                                                        |
| `file-write`                                                       | Write the body to `:path:` (`:open: true` to show it, `:mode: append`), or copy a shipped file with `:from:` (`:substitute: true` to fill in variables). |
| `file-open`, `editor-insert`, `editor-replace`, `editor-highlight` | Open and edit files in the editor (`:path:` with `:line:` or `:match:`, plus `:regex:`, `:occurrence:`, `:expand:`); `file-close` closes a file's tabs.  |
| `notebook-create`                                                  | Create a notebook from a YAML list of `- markdown: ...` and `- code: ...` cells with optional `tags`.                                                    |
| `cell-insert`, `cell-run`, `cell-run-all`, `kernel-execute`        | Add cells, run them, run code (`:path:` names the notebook; cells are found by tag or index).                                                            |
| `hint`                                                             | Collapsible Markdown help.                                                                                                                               |
| `verify`                                                           | A check; see below.                                                                                                                                      |
| `quiz`, `form`, `choice`                                           | Questions, value entry and track selection.                                                                                                              |
| `checkpoint`, `restore`                                            | Snapshot and restore the workshop files.                                                                                                                 |
| `layout`, `panel-open`, `highlight`, `toast`, `tour`               | Arrange and point at the interface.                                                                                                                      |

The full table with every option is in `references/actions.md`, and
`references/pages.md` covers the page syntax, the common options and how
the editor actions point at text.

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

- `kernel` (default): Python in a hidden kernel, cwd is the workshop
  directory, variables in the environment. Raise or assert to fail; the
  assertion message is shown. Needs `kernel-exec`.

- `script`: a file in the workshop named by `:script:`, run by the server.

- `contents`: predicates, one per line, no capability needed:
  `exists <path>`, `missing <path>`, `contains <path> <text>`,
  `matches <path> <regex>`, `cell-executed <notebook> <tag>`. Cannot see
  dot files such as `.git`; use `kernel` for those.

- `ui`: `terminal-open <session>`, `file-open <path>`, `notebook-open
<path>`, `panel-open <id>`, `kernel-idle <notebook>`.

- `learner-kernel`: an expression evaluated in the learner's notebook
  kernel (`:path:` names the notebook); falsy fails.

`:trigger:` lists events that re-run it, separated by `;`: `page-enter`,
`after:<action id>`, `action`, `terminal-output "text"` or `/regex/`,
`file-saved <path>`, `cell-executed <tag>`, `interval 30s`. Clicking
Check always works. Prefer a trigger tied to the action the learner is
expected to run.

Quiz (`:type: single` or `multi`, `:attempts:`, `:shuffle:`):

````markdown
```{quiz}
:id: staging
question: Which command stages changes?
options:
  - { text: git add, correct: true }
  - { text: git commit, explanation: "git commit records what is staged." }
explanation: git add stages, git commit records.
```
````

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

- Never name a checkpoint `pristine`: the extension takes a checkpoint
  under that name when a workshop is first opened and "Restart" restores
  it (`reserved-checkpoint-name`). Restart only puts back files inside
  the workshop directory, so keep what a workshop creates inside it.

- A page is done when the learner leaves it forwards with its `requires`
  met; there is no button to mark it. The last page shows Finish, which
  opens a dialog with the manifest's optional `finish` Markdown (say
  where to go next) and what to do now. To checkpoint after a check,
  give the `verify` a `:cascade:` naming a `checkpoint` block.

- Keep `write-files` paths inside the workshop directory unless the
  scope is wider; lint warns on `..`, `~` and absolute paths.

- Do not pipe downloads into a shell, use `sudo`, or `rm -rf` outside the
  workshop; lint flags these and the trust dialog shows them.

- Interactive actions (`dialog`, `upload-prompt`, `tour`) are skipped by
  the self-test; do not gate a page on something only a person can do.

- Use `:wait: prompt` on `execute` when the next action or check depends
  on the command having finished (the self-test adds it automatically).

- Windows: add `:windows:` variants for commands that use `&&`, `export`,
  `ls`, `cat` or `/` paths, and list `windows` in `platforms` only when
  they are covered. `jupyter workshop lint --platform windows` checks.

- JupyterLite (`lite` in `platforms`): there is no server, `python` or
  `git` in the terminal, and its shell has no `&&`, `$VAR` or `$(...)`.
  Add `:lite:` variants (an empty one means nothing to do), avoid
  `subprocess` in kernel checks and `script` verifies, and keep
  `execute-capture` bodies to shell commands. `jupyter workshop lint
--platform lite` checks; `jupyter workshop test --lite` runs the
  workshop in a JupyterLite build.

## Reading test output

`jupyter workshop test` prints one line per action:
`PASS page/id (type, 1.2s)`, `FAIL page/id (verify, 0.3s)  message`,
`SKIP ...`. The message of a failed `verify` is the assertion text or
predicate that failed; a failed `execute` usually timed out waiting for
the prompt (a command waiting for input) or ran in the wrong directory
(`:cwd:` is relative to the workshop). `--json report.json` writes the
full results. Fix, lint, test again.

## Style

Write for someone reading a narrow side panel: short paragraphs, one
action per paragraph, the action's `:title:` or its command saying what
it does, a `hint` for background rather than a wall of text. Headings:
one `#` per page matching the front matter title, `##` sparingly. Use
present tense and second person. Do not use emdashes. See
`references/style-guide.md` and `references/page-template.md`.

## Several workshops in one repository

Put each workshop in its own directory (for example `workshops/<name>/`)
and keep one `collection.json` at the repository root: a collection is a
published list of workshops. Build and update it with
`jupyter workshop index workshops` from the checkout; it reads every
manifest under the directories given and gives each entry a git source
with the path relative to the checkout (`--repo` and `--ref` default to
the git origin and branch, so pass `--ref` a tag to pin a release). The
order of the file is the order the browser shows and is kept on update;
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
`available`, `close` and `browse` (for an image running one workshop).
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
work on directories; `open_workshop`, `session_status`, `run_action`, `run_page`
and `run_workshop` act on a running JupyterLab that has the workshop
open in author mode.
