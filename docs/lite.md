# JupyterLite

[JupyterLite](https://jupyterlite.readthedocs.io) is JupyterLab running
entirely in the browser: a static site with a Python kernel compiled to
WebAssembly (Pyodide) and, with the terminal extension, a small shell
called cockle. There is no server, so a workshop can be published as a
plain set of files on GitHub Pages or any web host and opened with a
link.

The extension runs in JupyterLite as it is. What the server extension
would do, it does in the browser instead:

| On a server                                  | In JupyterLite                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Platform detection                           | Fixed: `platform` is `lite`, `shell` is `cockle`, files live under `/drive`.                   |
| Download from a repository (archive)         | File by file from the raw files of the repository, through jsDelivr for GitHub.                |
| Download from an archive URL                 | Not available; use a repository URL.                                                           |
| Registry index                               | Fetched by the browser, so the host must send CORS headers, or ship the index inside the site. |
| `execute-capture`, `verify` with `shell`     | The terminal extension's headless shell.                                                       |
| `verify` with `kernel`, `kernel-execute`     | The Pyodide kernel: Python without `subprocess`.                                               |
| `verify` with `script`, `environment-create` | Not available; the actions report why.                                                         |
| Checkpoints                                  | Copies of the files under `_workshop/checkpoints/`.                                            |
| Preflight                                    | Python is always found; other tools must be commands of the shell. Versions are not checked.   |
| Progress events                              | Appended to `_workshop/events.jsonl`; a sink is posted to from the browser and needs CORS.     |

Files written by actions, notebooks and progress live in the browser's
storage for the site, so they survive a reload but stay on that machine.

## Writing for JupyterLite

List `lite` among the manifest's platforms and run `jupyter workshop lint
--platform lite`. Two rules cover the differences:

- `lite-shell-syntax` warns when a command applicable to Lite uses what
  cockle lacks: chaining with `&&` or `||`, `$VAR` expansion, command
  substitution, or `2>&1`. Pipes, `;` and redirections work. Give the
  action a `:lite:` variant, or an empty one when there is nothing to
  do.

- `lite-unsupported` warns about `environment-create`, `script` verifies
  and Python bodies that start processes. Hide them with
  `:when: platform != "lite"` or give them a variant.

The shell has the coreutils commands (`ls`, `cat`, `echo`, `env`,
`mkdir`, `sed`, `grep`, `expr` and so on), `cd`, `export` and a few other
builtins, but no `python`, `git` or package managers. Variables reach the
terminal through `export` rather than a sourced file. A `requires.tools`
list naming anything but Python shows the preflight banner in Lite.

The `platform` built-in variable is `lite`, so prose can adapt with
` ```{when} platform == "lite" ` blocks, and `:when: platform != "lite"`
hides an action.

## Building a site

```
pip install "jupyterlab-workshop[lite]"
jupyter workshop lite my-workshop [other-workshop ...] [--out lite-site]
                                  [--default NAME] [--trust LEVEL]
                                  [--registry URL] [--no-terminal]
                                  [--lite-dir DIR] [--serve] [--port PORT]
```

The command copies the workshops into the site's contents (leaving
`_workshop/` progress behind), writes the extension settings that open a
workshop on start (`--default`, or the only workshop given) and, with
`--trust`, apply a trust level without asking, then runs `jupyter lite
build`. The site includes whatever JupyterLab extensions are installed in
the environment, this one among them. `--serve` serves the result on a
local port, under a sub-path as GitHub Pages would, to try it out.

The terminal needs `node`, `npm` and `micromamba` on the path when
building, because the terminal extension fetches its WebAssembly
commands from emscripten-forge. The site declares terminals available,
so File, New, Terminal and the launcher card work as well as the
workshop's own actions. `--no-terminal` leaves it out.
`--lite-dir` names the directory JupyterLite keeps its build state and
those downloads in; the default is under the Jupyter data directory so
that later builds are quick.

Pyodide itself is loaded from a CDN when the site opens, so learners
need network access on first use. The built site is relative-path only
and works from any sub-path.

## Publishing to GitHub Pages

The repository's own workflow (`.github/workflows/pages.yml`) runs
`just pages`, which assembles the project site: a landing page, the JSON
schemas, and the example workshop built as a JupyterLite site under
`demo/`. The result is deployed with `actions/deploy-pages` to
<https://grahamdumpleton.github.io/jupyterlab-workshop/>. A workshop
repository can do the same with just the JupyterLite build:

```yaml
- run: pip install "jupyterlab-workshop[lite]"
- run: |
    curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest \
      | tar -xj -C /usr/local bin/micromamba
- run: jupyter workshop lite . --out site
- uses: actions/upload-pages-artifact@v3
  with:
    path: site
```

## Testing

`jupyter workshop test my-workshop --lite` builds a site with the
workshop, serves it from a static file server under a sub-path, opens it
in a headless browser and runs every action, exactly as the server
self-test does. The first run downloads the terminal's WebAssembly
packages into the build directory; Pyodide loads from the CDN on every
run. `just selftest-lite` runs it on the example.
