# Platforms and frontends

A workshop runs wherever JupyterLab runs: on Linux, macOS and Windows,
and in [JupyterLite](lite.md) in the browser. Those are two different
things. The platform is the operating system the commands run on; the
frontend is the editor the workshop drives, JupyterLab served by a
Jupyter server or JupyterLite running on Pyodide. The manifest lists
both:

```yaml
platforms: [linux, macos, windows]
frontends: [jupyterlab, jupyterlite]
```

A manifest that lists no `frontends` is written for JupyterLab alone.
Supporting JupyterLite has always needed explicit work, so it is an
explicit declaration. Both lists are advisory: the browser dims
workshops that do not list the current platform or frontend, the panel
shows a banner when a workshop is opened where it was not written for,
and the linter uses the lists to check that every command has a version
for each listed platform and frontend and that no listed frontend lacks
an action the pages use.

In JupyterLite the platform is always `emscripten`, which no workshop
lists, since the `platforms` are the operating systems of the other
frontend. So there the `platforms` list is not consulted at all, by the
browser, the Install all dialog, the banner or `jupyter workshop
install --frontend jupyterlite`, and listing `jupyterlite` in
`frontends` is what says a workshop runs there.

## Built-in variables

[Variables](variables.md) describes the syntax, where values come from
and how they reach terminals. The built-in variables `platform`
(`linux`, `macos`, `windows`, or `emscripten` in JupyterLite, which
runs on Pyodide whatever the browser's operating system), `frontend`
(`jupyterlab` or `jupyterlite`), `shell` (`bash`, `zsh`, `sh`, `fish`,
`powershell`, `cmd` or `cockle` in JupyterLite), `path_sep`, `home`
and `user` describe the machine, `workshop_dir` is the workshop
directory relative to the JupyterLab root and `workspace` the learner's
[workspace](concepts.md#the-workspace) the same way, and `when`
conditions can test them:

````markdown
```{when} platform == "windows"
Windows users: run the commands in PowerShell.
```

```{when} frontend == "jupyterlite"
There is no git here; the repository is shown already cloned.
```
````

Two more describe where the session is hosted rather than what it runs
on. `host` is `binder` under BinderHub, `codespaces` in a GitHub
codespace, `jupyterhub` under any other JupyterHub, `static` for a
JupyterLite site, which has no service behind it, and `local`
otherwise; Binder is recognised by the `BINDER_*` environment variables
it sets, Codespaces by `CODESPACES` and `CODESPACE_NAME`, and JupyterHub
by `JUPYTERHUB_USER` or `JUPYTERHUB_API_URL`. `container` is `true` when
the server runs inside a container, found from the Docker and Podman
marker files, the Kubernetes service variable or the cgroup of process
1, and is what to test for advice about disposable filesystems or
installing tools, since that holds on a Kubernetes hub as much as on
Binder:

````markdown
```{when} host == "binder"
This session is temporary: download your work before it ends.
```

```{when} container
You can install packages freely; nothing here outlives the session.
```
````

One more comes from the workshop rather than the machine:
`missing_tools` is the list of the tools in `requires.tools` that the
[preflight check](checks.md#preflight) did not find, so
`"git" in missing_tools` shows install advice to the learners who need
it.

## Command variants

A directive body may hold alternatives for particular platforms or
frontends. A line holding only `:<platform>:` or `:<frontend>:` starts
the variant for it; the text before the first marker is the default:

````markdown
```{execute}
python3 -m venv .venv && source .venv/bin/activate
:windows:
py -m venv .venv; .\.venv\Scripts\Activate.ps1
:jupyterlite:
```
````

A frontend variant is the more specific of the two and is chosen first:
in JupyterLite the `:jupyterlite:` version wins whatever the platform,
and elsewhere the platform's version wins over the default. Markers do
not nest, so a body that needs to say "this frontend on that platform"
uses a `when` condition instead, where `frontend == "jupyterlite" and
platform == "windows"` reads as it should. The panel shows only the
chosen version, with a badge naming the variant. An empty variant, as
for `jupyterlite` above, means there is nothing to do there: the action
is shown but reports "nothing to do" when run. Variants apply to
directives with command or text bodies (`execute`, `file-write`,
`kernel-execute` and so on), not to YAML or Markdown bodies.

The linter reports `missing-variant` when a body has variants but no
default and misses a platform the manifest lists, or a listed frontend
when no platforms are listed; a frontend variant covers its frontend on
every platform. For a manifest listing `jupyterlite` it also reports
`lite-shell-syntax`, `lite-unsupported` and `unsupported-frontend`,
which [JupyterLite](lite.md) describes. `jupyter workshop lint
--platform windows` renders the pages as Windows would see them, which
is how CI on Linux checks the Windows variants; `--frontend
jupyterlite` does the same for JupyterLite.

## Paths

Paths in options such as `path` and `cwd` are relative to the learner's
[workspace](concepts.md#the-workspace); `../` from there reaches the
workshop's own files, such as a shipped `README.md`. The exception
is `:from:` on `file-write`, which names a shipped file and so is
always relative to the workshop directory. Terminals, the hidden
workshop kernel and script checks start in the same place. Paths use
forward slashes on every platform; the extension normalises them. To
show a path in prose or a
command with the platform's separator use the `path` filter or the
`path` helper:

```
{{ repo_dir | path }}
{{ path "src/app.py" }}
```

Both render `src\app.py` on Windows and `src/app.py` elsewhere.

## Terminal shells

Terminals run the shell the server is configured with: the `SHELL`
environment variable on Linux and macOS, and PowerShell on Windows, unless
`ServerApp.terminado_settings` names another. The extension detects the
shell to load the environment file with the right syntax: `env.sh` for
bash, zsh and plain sh, `env.fish`, `env.ps1` or `env.cmd`.

In JupyterLite terminals run cockle, a small shell described in
[JupyterLite](lite.md); variables reach it through `export` commands.

### The workshop prompt

The environment file replaces the shell's prompt with the workshop's
own: the working directory relative to the work directory, shown as `~`
for the directory itself and `~/demo` inside it, followed by `$`.
Outside the work directory the full path is shown. Prompt hooks from the
learner's rc files are dropped, so tools that redraw the prompt on every
command, such as starship, stay out of the way. Plain sh takes its
prompt literally and there it is a bare `$`; the cmd prompt shows the
full path, the only one it can. The work directory's path is exported
as `WORKSHOP_PROMPT_ROOT`. The first time a terminal loads the file it
clears the screen, so the terminal opens at the workshop prompt rather
than on the typed command and a login banner; `WORKSHOP_TERMINAL` is
set in a terminal where that has happened, and a nested shell inherits
it.

The prompt begins with an escape sequence that terminals do not show and
the extension listens for, carrying the exit status of the command
before it and a serial number that the shell raises each time it draws
a primary prompt. `execute` with `:wait: prompt` counts these prompts as
the shell draws them, one per line sent, continuation prompts included,
and is done when the last has appeared; a command that exits with a
status other than zero says so under the action. A prompt the shell
merely draws again, as bash and zsh do when the terminal is resized,
repeats its serial number and is not counted. Plain sh and cmd cannot
count, so their markers carry no number. The prompt is probed when the
terminal starts: where the sequence never arrives, as in cockle, which
has no prompt to hook, or a Windows console that strips it, the action
falls back to following the command with an `echo` of a marker and
waiting for its output. When the environment file changes, say after a
variable is set, each open terminal loads it again, which draws a
prompt; that and the actions' commands take turns in a terminal, so the
one is never taken for the other. The fish editor keeps an unfinished
construct in its buffer without drawing a prompt, so on fish a command
spanning lines that way can time out; put it on one line or join the
lines with `;`.

A workshop with an [isolated environment](environment.md) has its
`bin` directory put first on `PATH` by the same file once the
environment exists, with `VIRTUAL_ENV` set, unless the manifest turns
that off with `terminals: false`.

A manifest `env` mapping exports further environment variables through
the same file, after the variables. The usual reason is a pager: in a
terminal a few lines tall, `git diff` or `man` waits for a key press and
holds up the next action until it is dismissed, so a workshop that runs
them sets:

```yaml
env:
  PAGER: cat
  GIT_PAGER: cat
```

Nothing is set unless the manifest asks for it, so a workshop that
teaches `less` keeps it. The same mapping is in the environment of
`kernel`, `shell` and `script` checks and of `execute-capture`
commands, so a value set for the terminals holds wherever the workshop
runs a command. The self-test runs with the same environment, and a
command that pages there is reported as one that did not finish.

A Python workshop whose pages edit a module and then run it again
should also set `PYTHONDONTWRITEBYTECODE: "1"`. Python and pytest
accept cached bytecode when the source file's size and its modification
time, in whole seconds, are unchanged, so an `editor-replace` that
swaps text for text of the same length within a second of the previous
run leaves the next run executing the old code. The self-test, which
runs actions back to back, hits this more often than a learner does.

Values are strings, as the environment holds them, so a number or a
`true` has to be quoted, or YAML reads it as something else and the
manifest is refused. The same holds for the manifest's `version`, where
an unquoted `1.10` would become `1.1`, and for `defaults.actions`.

### Settings that differ by platform

Where an `env` value, or an action default under `defaults.actions`,
differs by platform or frontend, a `variants` mapping keyed by the same
names the body markers use overrides it there:

```yaml
env:
  PAGER: cat
defaults:
  actions:
    timeout: 60s
variants:
  windows:
    env:
      PAGER: more
  jupyterlite:
    defaults:
      actions:
        timeout: 5m
```

The entries that apply are merged over the base by key, the frontend
entry after the platform entry, which is the order in which body
markers are chosen. Only `env` and `defaults` can appear under an
entry: they are the settings whose whole value can differ by platform.
Whether one item of a list applies somewhere is said on the item
instead, as a tool's `platforms` in `requires.tools` is, and a shell
requirement is not overridden at all, for the reason below.

### Requiring a shell

A manifest may require a shell:

```yaml
requires:
  shell: bash
```

Set it only when the workshop truly runs under one shell. `sh` means
any POSIX shell, satisfied by `sh`, `bash` and `zsh`, where every other
name must match exactly, so a workshop whose commands are plain POSIX
asks for `sh` and is not flagged on a Mac, whose default shell is zsh.
A workshop that supports several shells with commands that differ
omits the field and puts a condition on the actions that differ,
`:when: shell == "fish"` on one and `:when: shell != "fish"` on the
other, since body markers select by platform and frontend, not by
shell.

When the detected shell does not satisfy the requirement the panel
shows a banner on the first page explaining that commands may need
adjusting and how to change the server's terminal shell, for example
for Git Bash on Windows:

```python
c.ServerApp.terminado_settings = {
    "shell_command": ["C:\\Program Files\\Git\\bin\\bash.exe"]
}
```

Advice of your own, such as which shell to install and how, goes on the
first page under a condition on the `shell` built-in, which says what
the page requires as it does so:

````markdown
```{when} shell not in ["bash", "zsh"]
These commands need bash or zsh; terminals here run `{{ shell }}`.
```
````

## Remote kernels

The platforms above all run JupyterLab, its terminals and its kernels
on one machine, which is what the actions assume. A JupyterLab whose
kernels come from a Kernel Gateway or Enterprise Gateway, so that
kernel work happens on another host, is not supported yet; the actions
that would run on the wrong host, and what it would take to change
that, are set out in [Known limitations](limitations.md#remote-kernels-kernel-gateway-and-enterprise-gateway).

## Windows notes

- Commands run in PowerShell by default. Windows PowerShell 5, the
  version shipped with Windows, has no `&&`; use `;` in a `:windows:`
  variant or a newer PowerShell.

- The example workshops carry `:windows:` variants and run under
  `jupyter workshop test` on Windows in the project's CI. The scaffold
  written by `jupyter workshop init --ci` tests on Linux, macOS and
  Windows.

- Verify scripts run with the server's Python; `subprocess` calls in
  kernel checks should pass argument lists rather than shell strings so
  they behave the same on every platform.
