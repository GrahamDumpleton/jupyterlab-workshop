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

| Substrate        | Body                                         | Runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel`         | Python code                                  | In the hidden workshop kernel, in the workspace, with the variables and the manifest's `env` in the environment. An exception fails the check; an `AssertionError` message is shown as written. Printed text is shown on success. This is the default.                                                                                                                                                                                                                                  |
| `script`         | None; name the file with `:script:`          | On the server as a subprocess with the workspace as its working directory and the variables and the manifest's `env` in the environment; the script itself is named relative to the workshop. Exit code 0 passes. Python files run with the server's interpreter; other files must be executable. Not available in JupyterLite.                                                                                                                                                         |
| `shell`          | A shell command                              | Without a terminal, in the workspace: through the hidden workshop kernel on a server, as `subprocess.run(..., shell=True)` under `/bin/sh`, and the terminal's headless shell in JupyterLite. Exit code 0 passes; the output is the message. The command sees the server's environment with the variables and the manifest's `env` added, or the workshop environment when the manifest declares one, not a shell the learner activated, so name the learner's tools by path otherwise. |
| `contents`       | Predicates, one per line                     | In the browser against the contents API. Every predicate must hold.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ui`             | Predicates, one per line                     | In the browser against the JupyterLab interface.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `learner-kernel` | Python code; name the notebook with `:path:` | In the kernel of the learner's notebook. The value of the last expression decides: `False`, `None` or `0` fails. A body that ends in no expression is decided by what it printed, and printing nothing fails.                                                                                                                                                                                                                                                                           |

A `learner-kernel` check that ends in an expression is judged on that
expression alone, so a check may call the learner's code even when that
code prints: `greet("Bob") == "Hello, Bob!"` fails when the comparison
is false, whatever a logging decorator around `greet` wrote on the way.
What was printed becomes the message, which makes
`print("Decorate greet first")` followed by a closing `False` a way to
say why. A check that raises fails with the error as its message, and
leaves the learner's own cells alone: a cell queued behind it in the
kernel still runs.

The value of that closing expression goes no further than the check. The
notebook's own record of results, `Out`, `_` and the numbered names such
as `_3`, is left as the learner's cells made it, so a check may read
them, `44 in Out.values()` for one, and find the same thing each time it
is asked. Names the check assigns are another matter: they stay in the
learner's kernel, as they would from a cell.

Nor does the learner's last cell change what the check says. A cell
that ended in a semicolon, which hides the value of a cell, does not
hide the value of the check, and a cell left with an open quote or
bracket does not stop the check giving its own verdict.

Contents predicates: `exists <path>`, `missing <path>`,
`contains <path> <text>`, `matches <path> <regex>`, and
`cell-executed <notebook> <tag or index>`, which passes once the cell has
an execution count, read from the open notebook when there is one and
otherwise from the saved file. Interface predicates:
`terminal-open <session>`, `file-open <path>`, `notebook-open <path>`,
`panel-open <widget id>` and `kernel-idle <notebook>`. Paths are relative
to the workspace; see [paths](platforms.md#paths). The contents API does
not show files or
directories whose names start with a dot unless the server is configured
to allow hidden files, so a check for `.git` needs the `kernel` or
`script` substrate.

The hidden workshop kernel is started on first use and kept for the
`kernel` and `shell` checks and `execute-capture` actions that follow,
but a check must not rely on it: each `kernel` check should read the
learner's work from disk and keep nothing in Python variables for a
later check, since the kernel is replaced when the workshop's own
environment appears, on Restart, and after a hang. A request the kernel
does not answer within the time limit is not waited for again on that
kernel; the kernel is restarted and the request made once more, and
only when that too gets no reply does the check fail, saying so.

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
shell is back at its prompt. Clicking Check runs the verify once. The
self-test, and Run checks in author mode, give a verify that declares a
trigger the same settle time a trigger would, and a verify without one
the single attempt a click gives it, so a check passes under test when
it passes for a learner; see [test](cli.md#test). Every trigger reads
the page afresh when it fires, so a check whose body names a variable
with `{{ }}` uses the value a form on the same page has just set, from
its next run on.

`:timeout:` bounds script and shell runs: a duration such as `30s`,
`10m` or `1h` (a bare number is seconds), 60s when not given. A check
that waits on something slow, such as a rollout or a build, does its
waiting inside the script and names a `:timeout:` long enough for it.
Code substrates, `shell`
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
  - { text: "`git commit`", explanation: "`git commit` records what is already staged." }
  - { text: "`git add`", correct: true }
  - "`git stage-it`"
explanation: "`git add` stages changes; `git commit` records what is staged."
```
````

The question, each option's `text` and the explanations take standard
inline Markdown: code spans, emphasis, strikethrough and explicit links
such as `[git add](https://git-scm.com/docs/git-add)`. Each stays on one
line; there are no paragraphs, lists or other block content. Inline
roles such as `{copy}` are not recognised here, a bare URL is shown as
text rather than made a link, and raw HTML is escaped. Variables are
substituted as in any directive body. The `:title:` shown in the
header is plain text. The body is YAML, so a value that starts with a
backtick or contains `: `, `{` or `}` must be quoted, as above.

`:type:` is `single` (radio buttons, default), `multi` (check boxes,
every correct option and no others must be picked) or `text` (the
learner types the answer, described under [A typed answer](#a-typed-answer)).
`:attempts:` limits
submissions; after the last failed attempt the quiz locks. A correct
answer shows the quiz `explanation`, a wrong one shows the explanations
of the wrong options picked, if any.

The options are shuffled unless the quiz says `:shuffle: false`. The
correct answer tends to be the first one an author writes, and shown as
written a learner could pass every quiz by picking the top option.
`:shuffle: false` is for options with an order of their own, such as
steps in a sequence or ranges of numbers. The shuffle is a fixed
permutation worked out from the quiz id, the same for every learner and
every visit, so it is not a randomisation: with four options about one
quiz in four still shows its correct answer first. Vary where the
correct option sits in the source as well. Grading and the self-test
go by the options as written, so shuffling changes neither.

### A typed answer

Picking from a list tests whether the learner recognises the right
answer, and the list shows it to anyone who reads it. A quiz of
`:type: text` has no options: the learner types the answer, which suits
a question that asks them to predict what a piece of code will show
before they run it.

````markdown
```{quiz}
:id: division
:type: text
:attempts: 3
question: What does `print(10 / 2)` show?
answer: "5.0"
wrong:
  - { text: "5", explanation: "`/` gives a float, even when it divides evenly." }
  - { pattern: "5\\.0+", explanation: "Close, but Python prints one digit after the point here." }
otherwise: "Think about the type that `/` returns."
explanation: "`/` is true division, so the result is the float `5.0`."
```
````

- `answer` is the text that is accepted, or a list of them. An entry
  can also be a mapping with a `pattern`, a regular expression that the
  whole of the typed answer must match, as in
  `{ pattern: "0x[0-9a-f]+", example: "0x7f3a" }`.

- `wrong` lists the wrong answers the author expects, each with a
  `text` or a `pattern` and the `explanation` to show for it. The
  accepted answers are looked for first, then these in the order
  written.

- `otherwise` is shown for any other wrong answer. Without it the
  learner is told "Not quite, try again".

- `explanation` is shown for a correct answer, as for any quiz.

An answer is compared exactly: `4.0` is not `4`, `True` is not `true`
and `'a'` is not `a`, since that difference is often what the question
is about. White space around the answer and at the end of each line is
ignored, and nothing else is. `:case: false` makes the comparison
ignore case, patterns included. `:lines:` gives the learner a box of
that many lines for output that runs over several, up to 20; with one
line, the default, pressing Enter submits.

Quote every `answer` and every `text`. The body is YAML, which reads an
unquoted `4.0` as the number 4, `True` as a boolean and `[1, 2]` as a
list, so the answer compared against would not be the one written. The
linter reports an answer that is not text, a pattern that does not
compile, an `example` that does not match its pattern, and a wrong
answer that is also an accepted one and so could never show its
explanation.

The self-test types the first answer given as text, or failing that
the first `example` of a pattern, so a quiz needs one or the other. What
the learner types is used for grading only: it is not stored with the
workshop's state, written to the action log or sent in a
[progress event](analytics.md), which reports that the quiz was
answered and whether correctly, as for the other types.

A typed quiz counts in `passed_checks` and `failed_checks` like any
other, so a [hint](pages.md#hints) can stay locked until the learner
has tried: `:unlock: "division" in failed_checks`.

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

A field's `label` and `description` take standard inline Markdown on
one line, as quiz text does: code spans, emphasis and explicit links,
with roles unrecognised, bare URLs left as text and raw HTML escaped.
The `:title:` shown in the header, and the `placeholder`, are plain
text.

Values are validated in the panel before submission and again by the
action. Submitting stores the values with the `form` source, re-renders
the pages, and rewrites the environment files, so commands after the form
can use `{{ user_name }}`. Secrets are never written to the state file;
they reach commands through the environment file. Submitting again
updates the values.

The linter reports a variable used on a page before the page whose form
sets it, unless the manifest gives the variable a default.

## Attempt

`````markdown
````{attempt}
:id: tickets-only
:check: total-cost
:expect: That is the cost of the 3 tickets only

```{cell-insert}
:path: cinema.ipynb
:run: true
3 * 12
```
````
`````

The self-test follows a workshop along the path where everything goes
right, so on its own it shows that a check passes on a correct answer
and nothing of what the check says on a wrong one. Where learners write
code, that message is much of the teaching: it names the likely mistake
and says what to try. An attempt is how a workshop tests it.

An attempt is written for the self-test alone. It holds the actions
that make an answer, names a `verify` of the same page with `:check:`,
and says with `:expect:` what that check should say. The learner never
sees an attempt or what it holds: nothing of it is shown in the panel,
its actions never run on their own, and it is not in the page list a
[progress event](analytics.md) carries.

When [the self-test](cli.md#test) reaches an attempt it runs the actions
the attempt holds, in order, and then runs the check once, as a click
on Check would. The attempt passes when the check fails and its message
contains the `:expect:` text, anywhere in it, with runs of white space
counted as one space so that a message wrapped over lines still
matches. The report then gives what the check said, so every message
can be read in one place:

```text
PASS 09-your-own-calculation/tickets-only (attempt, 0.1s)  The check said: Your expression gives 36. That is the cost of the 3 tickets only.
```

An attempt fails when the check passes, when it says something else,
which the report quotes, or when one of the attempt's own actions fails.

`:result: pass` turns an attempt round, for a right answer written
another way than the solution: the check must then pass, and `:expect:`
may be left out. An attempt with no actions tests the check as things
stand at that point of the page, which is how to test what a check says
before the learner has done anything.

Attempts are run where they are written, so they go before the action
that gives the solution, usually just above the check. Nothing is
undone between them: each leaves the session as a learner's wrong
answer would, with its cell in the notebook or its text in the file,
and the next attempt and the solution build on that. This is what a
learner who gets it wrong twice and then right does, and it finds a
check that reads more than the latest answer. An attempt that needs a
clean start says so with an action, such as `kernel-restart` or
`restore`.

An attempt holds only actions the self-test can run one after the
other: not a `verify`, `quiz`, `form`, `hint` or another attempt, not
an action that waits for a person (`dialog`, `upload-prompt`, `tour`),
and nothing with an `auto` or `cascade` option; lint reports each. The
actions need their capabilities declared in the manifest like any
other. An attempt holding an action is fenced with four backticks; see
[directives](pages.md#directives).

Attempts belong to a full run. Run actions and Run checks in
[author mode](authoring.md#author-mode) leave them alone, since they
change the session the author is working in. Author mode does show each
attempt on the page, as a dashed box saying what it expects, with its
actions to click: click them, then Check, to see the message as a
learner would.

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
  is recorded in the page's progress as `skipped`, and the page does not
  count as done.

- `strict`: Next is disabled until every requirement is met.

The page selector still allows moving backwards, and jumping ahead is
gated the same way as Next.

## Progress and finishing

A page is done once the learner leaves it forwards, by Next or by
jumping ahead, with its requirements met (under `off` gating there are
none to meet). The progress bar in the panel header, the tick in the
page selector and the "pages done" count on the workshop browser's card
all come from that, so a learner who reads through a workshop sees it
fill in without pressing anything else.

The last page shows Finish in place of Next. Pressing it marks the page
done, records the `workshop-finish` event and opens a dialog saying the
workshop is complete, with what to do next: browse other workshops,
close this one, or on Binder shut the session down. When the workshop
belongs to a collection that declares its workshops a sequence, the
dialog also names the next one and offers to open it, installing it
first if need be. Which of those
appear depends on the host and the
[disabled features](deploying.md#locking-down-a-deployment); "Keep
reading" is always there. The footer then shows "Finished" with a "What
next?" link that brings the dialog back. A `finish` field in the
manifest holds Markdown shown in the dialog, for example where to go
from here:

```yaml
finish: |
  Well done. The [next workshop](https://example.org/workshops) picks
  up from here with branches and remotes.
```

## Checkpoints

````markdown
```{checkpoint}
:name: after-first-commit
```

```{restore}
:name: after-first-commit
```
````

A checkpoint archives the [workspace](concepts.md#the-workspace),
together with the learner's variables, into
`_workshop/snapshots/<name>.tar` and `<name>.json` through the server;
the pages and the workshop's other files are never part of one.
Without `:name:` the current page id is used. To checkpoint once a check
passes rather than on a click, give the `verify` a `:cascade:` naming
the checkpoint block's id, and say in the page what is being saved and
why.

Restoring empties the workspace, extracts the archive into it and puts
the variables back. Files open in editors
are not reloaded automatically; JupyterLab offers to reload them when
they are next focused. The `restore` action needs the `write-files`
capability.

## Preflight

When a manifest lists `requires.tools`, opening the workshop asks the
server which of them are on its path. A banner on the first page lists
tools that are missing or too old. Versions are read from
`<tool> --version` only when the workshop is trusted; otherwise only
presence is checked. In JupyterLite, Python is the Pyodide kernel and
its version requirement is checked against the Python the site was
built with; other tools are looked for in the terminal's shell, without
versions.

```yaml
requires:
  tools:
    - { name: git, version: '>=2.30' }
    - { name: docker, optional: true }
    - { name: py, platforms: [windows] }
    - { name: curl, frontends: [jupyterlab] }
```

A tool with `platforms` or `frontends` is looked for only there, so a
tool that exists on one platform, or one that JupyterLite could never
provide, is not reported missing elsewhere. A tool that goes by another
name on another platform is two entries with disjoint lists. The linter
reports `unreachable-tool` for an entry whose lists leave out every
platform and frontend the manifest supports.

What the check found reaches the pages as the `missing_tools` built-in,
a list of the names not found or too old, optional ones included. The
install advice, which is rarely one line and differs by platform, is
prose on the first page under a condition that tests it:

````markdown
```{when} "git" in missing_tools and platform == "macos"
Git was not found. Install it with [Homebrew](https://brew.sh), then
reload JupyterLab so that a new terminal can see it:

    brew install git
```
````

The same condition in a page's front matter shows an "Install the
tools" page only to the learners who need it. Until the check has
finished `missing_tools` is empty, so a block that tests
`"git" not in missing_tools` shows for a moment on a machine where git
is missing; write the advice for the missing case. The linter reports
`unknown-tool` for a name tested against `missing_tools` that no entry
in `requires.tools` declares. The self-test runs where the tools are
installed, so these blocks are parsed and linted there but never shown.
