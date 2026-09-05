# Platforms

A workshop runs wherever JupyterLab runs: Linux, macOS and Windows, with
[JupyterLite](https://jupyterlite.readthedocs.io) planned. The manifest
lists the platforms a workshop has been written for:

```yaml
platforms: [linux, macos, windows]
```

The list is advisory: the browser dims workshops that do not list the
current platform, and the linter uses it to check that every command has
a version for each listed platform.

## Variables

The built-in variables `platform` (`linux`, `macos`, `windows` or
`lite`), `shell` (`bash`, `zsh`, `sh`, `fish`, `powershell` or `cmd`),
`path_sep`, `home` and `user` describe the machine, and `when`
conditions can test them:

````markdown
```{when} platform == "windows"
Windows users: run the commands in PowerShell.
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
default and misses a platform the manifest lists, and `lite-unsupported`
when a manifest listing `lite` has terminal actions without a `:lite:`
variant or a `when` condition. `jupyter workshop lint --platform
windows` renders the pages as Windows would see them, which is how CI on
Linux checks the Windows variants.

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
