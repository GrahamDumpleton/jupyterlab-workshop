# Checks, forms, gating and checkpoints

Workshops can check what the learner has done, ask questions, collect
values, hold pages until requirements are met, and snapshot the workshop
directory. This page describes the `verify`, `quiz`, `form`, `checkpoint`
and `restore` directives, the `requires` front matter, the preflight
check of required tools, and how the trust level affects them.

## Verify

````markdown
```{verify}
:id: first-commit
:label: You have made a commit
:trigger: terminal-output "Add README"; interval 10s
import subprocess

out = subprocess.run(["git", "log", "--oneline"], capture_output=True, text=True).stdout

assert out.strip(), "No commits yet: run git commit"
print(f"{len(out.splitlines())} commit(s) so far")
```
````

A verify shows a label, a Check button and its last result: pass, fail
with the message, or not yet run. Passing is recorded as the action
status `ok`, failing as `error`, so verifies appear in the action log and
count for gating like any other action.

Where the check runs is chosen by `:substrate:`:

| Substrate        | Body                                         | Runs                                                                                                                                                                                                                                   |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel`         | Python code                                  | In the hidden workshop kernel, in the workshop directory, with the variables in the environment. An exception fails the check; an `AssertionError` message is shown as written. Printed text is shown on success. This is the default. |
| `script`         | None; name the file with `:script:`          | On the server as a subprocess with the workshop directory as its working directory. Exit code 0 passes. Python files run with the server's interpreter; other files must be executable. Not available in JupyterLite.                  |
| `shell`          | A shell command                              | Without a terminal, in the workshop directory: through the hidden workshop kernel on a server and the terminal's headless shell in JupyterLite. Exit code 0 passes; the output is the message.                                         |
| `contents`       | Predicates, one per line                     | In the browser against the contents API. Every predicate must hold.                                                                                                                                                                    |
| `ui`             | Predicates, one per line                     | In the browser against the JupyterLab interface.                                                                                                                                                                                       |
| `learner-kernel` | Python code; name the notebook with `:path:` | In the kernel of the learner's notebook. The printed text or the value of the last expression decides: empty, `False`, `None` or `0` fails.                                                                                            |

Contents predicates: `exists <path>`, `missing <path>`,
`contains <path> <text>`, `matches <path> <regex>`, and
`cell-executed <notebook> <tag or index>`, which passes once the cell has
an execution count, read from the open notebook when there is one and
otherwise from the saved file. Interface predicates:
`terminal-open <session>`, `file-open <path>`, `notebook-open <path>`,
`panel-open <widget id>` and `kernel-idle <notebook>`. Paths are relative
to the workshop directory. The contents API does not show files or
directories whose names start with a dot unless the server is configured
to allow hidden files, so a check for `.git` needs the `kernel` or
`script` substrate.

Clicking Check always runs a verify. `:trigger:` lists further events,
separated by semicolons, that run it while its page is showing:

- `page-enter` when the page is opened.

- `after:<action id>` when that action completes, or `action` when any
  action on the page completes. Verifies never trigger other verifies.

- `terminal-output "text"` or `terminal-output /regex/` when a workshop
  terminal prints matching text, at most once a second.

- `file-saved <path>` when the file is saved from an editor or by an
  action.

- `cell-executed <tag>` when a notebook cell with the tag is run.

- `interval <duration>` on a timer, for example `interval 10s`, with a
  minimum of one second.

A trigger fires as soon as its event happens, and for `after:` that is
when the action reports completion, which for a terminal command is the
moment it has been typed, not when it has finished. A triggered verify
that fails is therefore given time to settle: it is tried again over the
next few seconds, showing as still checking, before the failure stands.
A command that takes longer than that, such as a build, is better given
`:wait: prompt` on its `execute` action so the trigger fires when the
shell is back at its prompt. Clicking Check runs the verify once.

`:timeout:` bounds script and shell runs. Code substrates, `shell`
included, need the `kernel-exec` capability; the `contents` and `ui`
substrates need nothing. Under the
restricted trust level, code verifies do not run and show an "off" badge,
while the frontend-only substrates work as usual. Under "ask", the first
code verify asks for confirmation, with the option to allow the kernel
for the rest of the workshop.

## Quiz

````markdown
```{quiz}
:id: staging
:title: Staging area
:type: single
:attempts: 3
question: Which command moves changes into the staging area?
options:
  - { text: git add, correct: true }
  - { text: git commit, explanation: "git commit records what is already staged." }
  - git stage-it
explanation: git add stages changes; git commit records what is staged.
```
````

`:type:` is `single` (radio buttons, default) or `multi` (check boxes,
every correct option and no others must be picked). `:shuffle: true`
shows the options in an order that is stable for the quiz but differs
between quizzes. `:attempts:` limits submissions; after the last failed
attempt the quiz locks. A correct answer shows the quiz `explanation`, a
wrong one shows the explanations of the wrong options picked, if any.

## Form

````markdown
```{form}
:id: identity
:title: Who you are
- { name: user_name, type: text, label: Name, required: true }
- { name: user_email, type: email, label: Email, required: true }
- { name: pkg, type: select, label: Package manager, options: [pip, conda], set_track: true }
- { name: token, type: secret, label: API token }
```
````

The body is a list of fields, or a mapping with a `fields` list. Each
field has a `name` (the variable it sets) and optionally `type` (`text`,
`number`, `boolean`, `select`, `multiselect`, `secret`, `path`, `url`,
`email`), `label`, `description`, `placeholder`, `required`, `default`,
`pattern` (a regular expression the value must match), `min` and `max`
(bounds for numbers, lengths for text), `options` for selects, and
`set_track: true` to make the chosen value the workshop track as well.

Values are validated in the panel before submission and again by the
action. Submitting stores the values with the `form` source, re-renders
the pages, and rewrites the environment files, so commands after the form
can use `{{ user_name }}`. Secrets are never written to the state file;
they reach commands through the environment file. Submitting again
updates the values.

The linter reports a variable used on a page before the page whose form
sets it, unless the manifest gives the variable a default.

## Gating

```markdown
---
title: Your first commit
requires: [verify:first-commit, quiz:staging, form:identity]
---
```

`requires` lists the checks, quizzes and forms that should be complete
before leaving the page. The manifest's `gating` chooses what that means:

- `off` (default): the requirements are ignored.

- `soft`: the footer lists what is not yet done, with links that scroll
  to the block, but Next still works. Moving on with unmet requirements
  is recorded in the page's progress as `skipped`.

- `strict`: Next is disabled until every requirement is met.

The page selector still allows moving backwards, and jumping ahead is
gated the same way as Next.

## Checkpoints

````markdown
```{checkpoint}
:name: after-first-commit
```

```{restore}
:name: after-first-commit
```
````

A checkpoint archives everything in the workshop directory except its
`_workshop` state directory, together with the learner's variables, into
`_workshop/snapshots/<name>.tar` and `<name>.json` through the server.
Without `:name:` the current page id is used. A page with `checkpoint:
true` in its front matter is checkpointed when it is marked done. The
name `pristine` is reserved: the extension takes a checkpoint under it
when a workshop is first opened, and "Restart" restores it, so lint
reports a workshop that uses it (`reserved-checkpoint-name`).

Restoring deletes the current files (again leaving `_workshop` alone),
extracts the archive and puts the variables back. Files open in editors
are not reloaded automatically; JupyterLab offers to reload them when
they are next focused. The `restore` action needs the `write-files`
capability.

## Preflight

When a manifest lists `requires.tools`, opening the workshop asks the
server which of them are on its path. A banner on the first page lists
tools that are missing or too old, with the `hint` for the platform from
the manifest. Versions are read from `<tool> --version` only when the
workshop is trusted; otherwise only presence is checked.

```yaml
requires:
  tools:
    - {
        name: git,
        version: '>=2.30',
        hint: { macos: 'brew install git', linux: 'apt install git' }
      }
    - { name: docker, optional: true }
```
