# Tutorial: your first workshop

This tutorial writes a small git workshop from nothing: a manifest,
three pages with actions, a check that runs by itself, a quiz, a gated
page and a checkpoint, then lints, self-tests and publishes it. It
assumes the extension is installed and JupyterLab is running from a
working directory of its own, as in [Getting started](getting-started.md).

Where to type things: the commands below are shell commands. Open a
terminal inside JupyterLab (File, New, Terminal), which starts in the
JupyterLab root with the environment on its path, or use any other
terminal in that directory with the environment active, or with
`uv run` in front. The files can be written in JupyterLab's editor or
any other; every file is shown in full. The self-test starts a
JupyterLab of its own on a free port, so it is safe to run from inside
the one you are using.

## Plan the steps

A workshop is a sequence of steps, each of which the learner does and
the workshop can check. Decide those first. This one has three:

1. Create a repository and a file in it.
2. Make the first commit.
3. Look at the history and answer a question about it.

Each page ends with something checkable: a directory exists, a commit
exists, a question is answered.

## Scaffold

```
jupyter workshop init git-tutorial --title "Git in three steps"
```

The command writes `git-tutorial/workshop.yaml`, two pages, a README and
a `.gitignore`. The pages are a starting point that we will replace.
Open the manifest and make it read:

```yaml
apiVersion: jupyterlab-workshop/v1alpha1
name: git-tutorial
title: Git in three steps
version: 0.1.0
description: Create a repository, make a commit and read the history.
duration: 15m
platforms: [linux, macos]
capabilities:
  - terminal
  - write-files: [workspace]
  - kernel-exec
requires:
  tools:
    - { name: git, hint: { macos: brew install git, linux: apt install git } }
env:
  PAGER: cat
  GIT_PAGER: cat
layout: default
gating: soft
variables:
  - name: repo_dir
    type: path
    default: sandbox
    description: Directory the repository is created in
pages:
  - pages/01-create.md
  - pages/02-commit.md
  - pages/03-history.md
```

What each part is for:

- `capabilities` is what the learner is asked to trust: `terminal` to
  run commands, `write-files` to write a file, and `kernel-exec` because
  the check on page two runs Python. The linter reports any capability
  the pages need and the manifest lacks, and any declared but unused.

- `requires.tools` lists `git`, so a learner without it sees a banner
  with the install hint for their platform instead of failing commands.

- `env` sets the pagers to `cat`, since `git log` in a terminal a few
  lines tall would otherwise wait for a key press.

- `layout: default` opens a terminal below the main area.

- `gating: soft` lets the learner move on past an unmet check but says
  so; `strict` would disable Next until it passes.

- `variables` declares `repo_dir` with a default, so pages can write
  `{{ repo_dir }}` and a learner can change it from the panel's
  Variables dialog.

Delete the two scaffolded pages and write the three below.

## Page one: create a repository

`pages/01-create.md`:

````markdown
---
title: Create a repository
requires: [verify:repo-created]
---

# Create a repository

Every git project starts with a directory and `git init`. Click the
command to run it in the terminal below, or type it yourself.

```{execute}
:id: init
git init {{ repo_dir }}
```

Move into it; the commands on the next pages run there.

```{execute}
cd {{ repo_dir }}
```

Now put a file in it. This action writes the file and opens it in the
editor, so you can see what git is about to track.

```{file-write}
:id: write-readme
:path: {{ repo_dir }}/README.md
:open: true
# Sandbox

A small project for practising git.
```

```{verify}
:id: repo-created
:label: The README exists
:substrate: contents
:trigger: after:write-readme
exists {{ repo_dir }}/README.md
```
````

The front matter names the page and says it is not done until the
`repo-created` check passes. Four blocks follow the prose:

- `execute` runs its body in a workshop terminal, and the terminal keeps
  its state between commands, so the `cd` carries over to the next
  pages. The `:id:` on the first block is not needed yet; a block
  without one gets an id from the page and its position.

- `file-write` writes its body to a path relative to the workshop
  directory, whatever directory the terminal is in, and with
  `:open: true` shows it in the editor. The path uses the `repo_dir`
  variable.

- `verify` with the `contents` substrate checks predicates over files,
  needs no code and no kernel, and `:trigger: after:write-readme` runs
  it as soon as that action completes. The Check button always works
  too. It checks the README rather than the `.git` directory because the
  contents API does not show names starting with a dot; page two checks
  the repository properly, with git itself.

## Page two: the first commit

`pages/02-commit.md`:

````markdown
---
title: The first commit
requires: [verify:committed]
---

# The first commit

Git records changes in two moves: `git add` puts them in the staging
area, and `git commit` records what is staged. Stage the README.

```{execute}
:id: add
git add README.md
```

Then commit it with a message saying what changed.

```{execute}
:id: commit
:wait: prompt
git -c user.name=Learner -c user.email=learner@example.org commit -m "Add README"
```

```{verify}
:id: committed
:label: You have made a commit
:trigger: after:commit; terminal-output "Add README"
import subprocess

log = subprocess.run(
    ["git", "-C", "{{ repo_dir }}", "log", "--oneline"],
    capture_output=True,
    text=True,
).stdout

assert log.strip(), "No commits yet: stage the README and commit it"
print(f"{len(log.splitlines())} commit(s) so far")
```

```{checkpoint}
:name: after-first-commit
```
````

New here:

- `:wait: prompt` makes the action wait until the shell is back at its
  prompt before reporting completion, so the check triggered by it sees
  the finished commit rather than a command that has just been typed.
  The `-c user.name` and `-c user.email` options let the commit succeed
  on a machine where git has no identity configured, which is what the
  self-test runs on.

- The `verify` has no `:substrate:`, so it runs Python in the hidden
  workshop kernel, which is why the manifest declares `kernel-exec`. An
  exception fails the check and the `AssertionError` message is shown
  to the learner as written; printed text is shown on success. Its
  triggers run it after the commit action and again whenever the
  terminal prints the commit message, so it also passes when the
  learner types the command by hand.

- `checkpoint` snapshots the workshop files under a name. A later page
  could `restore` it, and a learner who makes a mess can be told to.

## Page three: read the history

`pages/03-history.md`:

````markdown
---
title: Read the history
requires: [quiz:history-quiz]
---

# Read the history

`git log` lists the commits, newest first. `--oneline` keeps each to a
line.

```{execute}
git log --oneline
```

The output starts with a short hash, the id git gave the commit, and
then the message you wrote.

```{quiz}
:id: history-quiz
:title: What is in the log
question: What does each line of git log --oneline start with?
options:
  - { text: A short hash identifying the commit, correct: true }
  - text: The name of the file that changed
    explanation: The log shows commits; git show lists the files in one.
  - text: The date of the commit
    explanation: The one-line form leaves the date out.
explanation: The hash comes first, then the commit message.
```

That is the whole loop: change something, stage it, commit it, read the
log.
````

The quiz gates the page in the front matter like a check. Under soft
gating a learner can still press Finish, but the page is not marked
done until the question is answered correctly.

## Lint

```
jupyter workshop lint git-tutorial
```

The linter reads the manifest and every page and reports problems. If
it is clean it prints nothing but the counts. Try removing `kernel-exec`
from the manifest and running it again: it reports the check on page
two as needing an undeclared capability, with the file and line. Put
the capability back.

## Try it in JupyterLab

Right click the `git-tutorial` directory in the file browser and choose
"Open as Workshop", trust it, and work through the pages. If a page
does not read well, turn on "Workshop: Author Mode" from the command
palette: its Edit page button opens the source beside the panel and
saving re-renders it. The trust dialog does not come back for a
workshop you have edited in author mode.

## Self-test

```
jupyter workshop test git-tutorial
```

The self-test starts a JupyterLab of its own, opens the workshop
trusted, runs every action in order, waits for each terminal command to
finish, answers the quiz correctly, runs every check, and prints a line
per action:

```
PASS 01-create/init (execute, 1.3s)
PASS 01-create/01-create-1 (execute, 0.0s)
PASS 01-create/write-readme (file-write, 0.1s)
PASS 01-create/repo-created (verify, 0.0s)
PASS 02-commit/add (execute, 0.0s)
PASS 02-commit/commit (execute, 0.1s)
PASS 02-commit/committed (verify, 1.0s)  1 commit(s) so far
PASS 02-commit/02-commit-1 (checkpoint, 0.0s)  Saved checkpoint "after-first-commit"
PASS 03-history/03-history-1 (execute, 0.0s)
PASS 03-history/history-quiz (quiz, 0.0s)  The hash comes first, then the commit message.

10 passed, 0 failed, 0 skipped
```

It needs the `test` extra and a browser, as
[Getting started](getting-started.md#scaffold-your-own) describes. A
failing action names itself, so a workshop that drifts from the tools it
was written against is caught before a learner finds it. `init --ci`
writes a GitHub Actions workflow that runs the same on every push.

## Publish

```
jupyter workshop publish git-tutorial --out git-tutorial/dist
```

This writes `git-tutorial/dist/git-tutorial-0.1.0.tar.gz`, its SHA-256
beside it, and `git-tutorial-0.1.0.registry.json`, an entry for a
registry index. Without `--out` the files go to `dist/` in the current
directory. [Publishing workshops](publishing.md) covers building an
index from such entries, listing a repository of workshops without
archives at all, and hosting either where learners' JupyterLab can
find it.

## Where next

- [Pages and actions](pages.md) for the page syntax, the options every
  action takes and how actions point at text in files.

- [Variables](variables.md) for `{{ repo_dir }}` and its relatives:
  where values come from, filters, and conditions.

- [Checks, forms, gating and checkpoints](checks.md) for every kind of
  check, quiz options, forms that collect values, and restoring
  checkpoints.

- [Layouts](layouts.md) to arrange the window when the workshop opens,
  for example the README rendered above the terminal.

- [Platforms](platforms.md) to add Windows and JupyterLite variants of
  the commands.
