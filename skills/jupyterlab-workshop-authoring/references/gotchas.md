# Gotchas by what the workshop is about

Read the sections that match the workshop's subject before writing its
pages, and again when the self-test fails in a way the page does not
explain. Each entry gives the symptom, the cause, and what the manifest
or the page should do about it. The general rules that apply to every
workshop are in `SKILL.md`; this file is for traps that only appear
once a workshop does a particular kind of thing.

## Python code the learner edits and runs again

- **A test or program still behaves as before an `editor-replace` or
  `editor-insert` changed it, and running it again by hand gives the new
  behaviour.** Python and pytest reuse cached bytecode whenever the
  source file's size and its modification time in whole seconds are
  unchanged. An edit that swaps text for text of the same length (`999`
  for `500`), within a second of the last run, leaves both the same, so
  the next run executes the old code. The self-test runs actions back to
  back and hits this readily; a learner clicking quickly can too. Set
  `PYTHONDONTWRITEBYTECODE: "1"` in the manifest's `env`, which reaches
  the terminals, the `kernel`, `shell` and `script` checks and
  `execute-capture`, so nothing caches bytecode.

- **Output of a running program reaches a check or a capture late or
  not at all.** Python buffers standard output when it is not a
  terminal, so a program whose output is captured, piped or redirected
  to a file that a check reads while it still runs prints nothing until
  the buffer fills or it exits. Set `PYTHONUNBUFFERED: "1"` in `env` for
  a workshop that watches a program's output that way.

- **A hidden-kernel check sees no variable from the learner's
  notebook.** `kernel` checks run in the hidden workshop kernel, not the
  notebook's. Check the notebook's state with the `learner-kernel`
  substrate and `:path:`, or check what the notebook wrote to disk.

## Python packages and virtual environments

- **A check or a captured command cannot find a package the learner
  installed.** Declare the packages in the manifest's `environment`
  requirements: the environment is then first on `PATH` in terminals,
  checks and captures alike, with no activation step on the page. A
  `python -m venv` the page walks the learner through is seen by the
  terminal that activated it and by nothing else, so checks against
  such a venv name its tools by path (`.venv/bin/python -m pytest`).

- **The environment takes a while to appear.** The banner the workshop
  opens with creates it on request: a venv, then pip installing the
  requirements and `ipykernel`. Keep the requirements to what the pages
  use, and put no action or check that needs a package before the
  learner has been told to create the environment.

- **A workshop that teaches virtual environments** wants the bare
  `python`, so declare no `environment` in that manifest, or the page's
  own venv is shadowed by the workshop's.

## Git

- **`git commit` fails in the self-test with "Please tell me who you
  are".** The self-test runs on a machine with no git identity. Either
  configure it in the repository the workshop creates (`git config
user.name ... && git config user.email ...` from workshop variables,
  as the git-basics example does) or pass it on the command (`git -c
user.name=Learner -c user.email=learner@example.org commit -m ...`).

- **`git log`, `git diff` or `man` never finishes.** They opened a
  pager in a terminal a few lines tall. Set `env: { PAGER: cat,
GIT_PAGER: cat }`; a workshop that teaches `less` leaves it unset and
  avoids those commands in actions. Use `git commit -m`, never a bare
  `git commit`, which opens an editor.

- **A `contents` check for `.git` never passes.** The contents API hides
  dot files unless the server allows them. Check with the `kernel` or
  `script` substrate instead.

## Servers and other long-running commands

- **An `execute` that starts a server times out.** `:wait: prompt`
  waits for the shell's prompt, which a server never gives back. Start
  it with `:wait: 3s` (long enough for it to bind), in its own
  `:session:` so the learner's other commands have a terminal, and
  confirm it is up with a check that talks to it (`curl` in a `shell`
  check).

- **The server fails to start on a learner's machine because the port
  is taken.** A port written into the commands cannot be changed without
  editing the workshop. Declare it as a variable with a default and use
  the variable everywhere the port appears, in commands, checks and
  prose:

  ```yaml
  variables:
    - name: server_port
      type: number
      default: 5071
      description: Port the server listens on
  ```

  ```
  python -m flask --app webshop run --port {{ server_port }}
  ```

  Then add a `hint` beside the start action saying that if the port is
  in use, the gear button in the panel header opens the Variables dialog
  where the port can be changed, after which the page and its commands
  show the new value. Name it `server_port` rather than `port`: variables
  are exported to terminals in upper case, and a bare `PORT` is read by
  some servers and tools on its own.

- **The next page cannot start the server: the port is in use.** The
  earlier page's server is still running in its terminal. Stop it with
  an `interrupt` action on that session before starting it again, and
  give the restart its own id; the self-test runs the pages in order,
  so every page that starts something must be able to run after the
  page before it.

- **The check reads a log or trace file the server writes and sees
  stale or missing lines.** Buffering again: set `PYTHONUNBUFFERED:
"1"` for a Python server, and start it with a fresh file (`rm -f
trace.jsonl && ...`) when the page's check should see only what the
  page sends.

## Commands in terminals

- **A command that spans lines times out on fish.** The fish editor
  keeps an unfinished construct in its buffer without drawing a prompt.
  Put the command on one line or join the lines with `;`.

- **A `shell` check that works in the terminal fails.** Shell checks run
  under `/bin/sh` without a terminal or an activated shell: no bash-only
  syntax, no aliases or rc files, and tools that only an activated
  environment provides must be named by path. The check's whole output
  is its message, so shape it (see the style guide).

- **Something the workshop creates outside the workspace survives
  Restart.** Restart and checkpoints cover the workspace only. Keep
  generated files, repositories and environments inside it.

## Windows and JupyterLite

Both are covered by the rules in `SKILL.md`: add `:windows:` variants
for commands using `&&`, `export`, `ls`, `cat` or `/` paths, and
`:lite:` variants where there is no server, `python` or `git`, then
lint with `--platform windows` or `--platform lite`.
