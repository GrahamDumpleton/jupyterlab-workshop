# Platforms

A workshop runs wherever JupyterLab runs: Linux, macOS, Windows and
[JupyterLite](lite.md) in the browser. The manifest lists the platforms a
workshop has been written for:

```yaml
platforms: [linux, macos, windows, lite]
```

The list is advisory: the browser dims workshops that do not list the
current platform, the panel shows a banner when a workshop is opened on
a platform it does not list, and the linter uses it to check that every
command has a version for each listed platform.

## Built-in variables

[Variables](variables.md) describes the syntax, where values come from
and how they reach terminals. The built-in variables `platform`
(`linux`, `macos`, `windows` or `lite`), `shell` (`bash`, `zsh`, `sh`,
`fish`, `powershell`, `cmd` or `cockle` in JupyterLite), `path_sep`,
`home` and `user` describe the machine, `workshop_dir` is the workshop
directory relative to the JupyterLab root, and `when` conditions can
test them:

````markdown
```{when} platform == "windows"
Windows users: run the commands in PowerShell.
```
````

Two more describe where the session is hosted rather than what it runs
on. `host` is `binder` under BinderHub, `jupyterhub` under any other
JupyterHub, `lite` in JupyterLite and `local` otherwise; Binder is
recognised by the `BINDER_*` environment variables it sets, and
JupyterHub by `JUPYTERHUB_USER` or `JUPYTERHUB_API_URL`. `container` is
`true` when the server runs inside a container, found from the Docker and
Podman marker files, the Kubernetes service variable or the cgroup of
process 1, and is what to test for advice about disposable filesystems or
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

## Command variants

A directive body may hold alternatives for particular platforms. A line
holding only `:<platform>:` starts the variant for that platform; the
text before the first marker is the default:

````markdown
```{execute}
python3 -m venv .venv && source .venv/bin/activate
:windows:
py -m venv .venv; .\.venv\Scripts\Activate.ps1
:lite:
```
````

The panel shows only the version for the current platform, with a badge
naming the platform when a variant was chosen. An empty variant, as for
`lite` above, means there is nothing to do on that platform: the action
is shown but reports "nothing to do" when run. Variants apply to
directives with command or text bodies (`execute`, `file-write`,
`kernel-execute` and so on), not to YAML or Markdown bodies.

The linter reports `missing-variant` when a body has variants but no
default and misses a platform the manifest lists. For a manifest listing
`lite` it also reports `lite-shell-syntax` and `lite-unsupported`, which
[JupyterLite](lite.md) describes. `jupyter workshop lint --platform
windows` renders the pages as Windows would see them, which is how CI on
Linux checks the Windows variants; `--platform lite` does the same for
JupyterLite.

## Paths

Paths in options such as `path` and `cwd` use forward slashes on every
platform; the extension normalises them. To show a path in prose or a
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
shell to load the environment file with the right syntax (`env.sh`,
`env.ps1` or `env.cmd`) and to print the marker that `execute` waits for
with `:wait: prompt`.

In JupyterLite terminals run cockle, a small shell described in
[JupyterLite](lite.md); variables reach it through `export` commands.

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
teaches `less` keeps it. The self-test runs with the same environment,
and a command that pages there is reported as one that did not finish.

A manifest may require a shell:

```yaml
requires:
  shell: bash
```

When the detected shell does not satisfy it (`sh` accepts `bash` and
`zsh`; other names must match) the panel shows a banner on the first
page explaining that commands may need adjusting and how to change the
server's terminal shell, for example for Git Bash on Windows:

```python
c.ServerApp.terminado_settings = {
    "shell_command": ["C:\\Program Files\\Git\\bin\\bash.exe"]
}
```

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
