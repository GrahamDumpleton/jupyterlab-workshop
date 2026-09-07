# Troubleshooting

What you see, what it means, and what to do. Most entries point at a
page that explains the behaviour in full.

## Installing and starting

**"Unable to open workshop examples/git-basics" in the panel on a fresh
install.** The `defaultWorkshop` setting ships pointing at an example
that only exists in the project's own checkout. Nothing is wrong; clear
the setting under Settings, Workshop, or ignore the message. See the
[settings reference](settings.md).

**`pip: command not found`, or `pip install` says the environment is
externally managed.** The system Python is not the place to install
into. Create a virtual environment and install there, as
[Getting started](getting-started.md#install) shows with uv or with
`python3 -m venv`.

**`jupyter workshop` is not found, or the Workshop panel is missing.**
The command and the extension are installed into one environment, and
JupyterLab must run from that environment. With uv, start it with
`uv run jupyter lab` in the project directory; with a venv, activate it
first. A terminal opened inside that JupyterLab has the command on its
path.

**The scaffolded workshop does not appear in the file browser, or "Open
a directory" says the directory has no `workshop.yaml` file.** Paths
are relative to the directory JupyterLab was started in, its root, and a
workshop must be inside it. Scaffold from that directory, or a
subdirectory of it.

## The command line

**`jupyter workshop lint` says Node.js is needed but no `node` was
found.** The `lint`, `render` and `pages` commands run the same
TypeScript the extension uses, bundled for Node.js. Install Node.js 18
or newer and put it on the path. The other commands are pure Python.

**`jupyter workshop test` says Playwright is missing, or that a browser
executable does not exist.** The self-test needs the `test` extra,
which installs Playwright, and then a browser for Playwright to drive:
`playwright install chromium`, run inside the same environment. The
browser is a one-time download into Playwright's own cache. See
[Getting started](getting-started.md#scaffold-your-own).

**The self-test reports an `execute` action that did not finish, and
the command was `git log`, `git diff`, `man` or similar.** The command
opened a pager in a terminal a few lines tall and waited for a key
press. Set the pagers in the manifest's `env` mapping, which the
example workshops do:

```yaml
env:
  PAGER: cat
  GIT_PAGER: cat
```

See [terminal shells](platforms.md#terminal-shells).

**A `verify` triggered by `after:<id>` fails although the command
worked.** The trigger fires when the command has been typed, not when
it has finished, and a slow command is still running when the check
looks. Give the `execute` action `:wait: prompt` so it reports
completion when the shell is back at its prompt. See
[checks](checks.md#verify).

## In the panel

**A command is typed into the terminal but not run, or an action shows
"confirms" or "auto off".** The workshop was opened at the Restricted
level. Press Enter yourself, confirm the dialogs, or raise the level
from the badge in the panel header. See [Using
workshops](using.md#the-trust-dialog).

**An action shows "not allowed" and never runs.** Its capability is not
declared in the workshop's manifest, so it is refused at every trust
level. The author needs to add the capability; the linter reports it.
See [Loading and trust](trust.md#capabilities).

**The trust dialog comes back every time a page is edited.** The
workshop is not in author mode, so each change is a new content hash.
Turn on "Workshop: Author Mode" from the command palette or the pencil
button; the workshop is then marked as yours and stays trusted. See
[Writing workshops in JupyterLab](authoring.md#author-mode).

**A line like `echo __WORK""SHOP_DONE_x__` appears in the terminal
after a command.** It is how the extension knows a command has
finished: a marker printed once the shell is back at its prompt, split
with empty quotes so the typed line does not match the printed one.
It is expected.

**A `contents` check for a `.git` directory, or any dot file, never
passes.** The contents API does not list names starting with a dot
unless the server is configured to allow hidden files. Check something
else, or use the `kernel` or `script` substrate. See
[checks](checks.md#verify).

**`:cwd:` on an `execute` action has no effect.** The option applies
when the named terminal is first started; a terminal that is already
open keeps its directory. Run `cd` as a step, or name a new session.

**A layout or a page opened files, and Close or Restart asks about
unsaved changes.** A document with unsaved edits asks before it is
closed, as closing its tab would. Save or discard it and try again.

## Platforms

**A command with `&&` fails on Windows.** Windows PowerShell 5 has no
`&&`. Give the action a `:windows:` variant using `;`, and run
`jupyter workshop lint --platform windows` to find the rest. See
[Platforms](platforms.md#command-variants).

**In JupyterLite a command using `$VAR`, `&&` or `$(...)` fails, or
`python` and `git` are not found.** The JupyterLite terminal is cockle,
a small shell without those, and without Python or git as commands.
Give the action a `:lite:` variant or hide it with
`:when: platform != "lite"`; `jupyter workshop lint --platform lite`
reports the cases. See [JupyterLite](lite.md).

**The self-test passes locally and fails in CI on one action, with a
timeout.** Actions that wait for terminal output can be slow on a
loaded runner. Rerun the failed job before treating it as a
regression, and raise `--action-timeout` if it is a long build step.
