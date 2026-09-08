# JupyterLite

[JupyterLite](https://jupyterlite.readthedocs.io) is JupyterLab running
entirely in the browser: a static site with a Python kernel compiled to
WebAssembly (Pyodide) and, with the terminal extension, a small shell
called cockle. There is no server, so a workshop can be published as a
plain set of files on GitHub Pages or any web host and opened with a
link.

The extension runs in JupyterLite as it is. What the server extension
would do, it does in the browser instead:

| On a server                                  | In JupyterLite                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Platform detection                           | Fixed: `platform` is `lite`, `shell` is `cockle`, files live under `/drive`.                  |
| Download from a repository (archive)         | File by file from the raw files of the repository, through jsDelivr for GitHub.               |
| Download from an archive URL                 | Not available; use a repository URL.                                                          |
| Collection index, catalog                    | Fetched by the browser, so the host must send CORS headers, or ship the file inside the site. |
| `execute-capture`, `verify` with `shell`     | The terminal extension's headless shell.                                                      |
| `verify` with `kernel`, `kernel-execute`     | The Pyodide kernel: Python without `subprocess`.                                              |
| `verify` with `script`, `environment-create` | Not available; the actions report why.                                                        |
| Checkpoints                                  | Copies of the files under `_workshop/snapshots/`.                                             |
| Preflight                                    | Python is always found; other tools must be commands of the shell. Versions are not checked.  |
| Progress events                              | Appended to `_workshop/events.jsonl`; a sink is posted to from the browser and needs CORS.    |

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

A Lite site ships its workshops prebuilt and has no server to unpack a
download into, so the browser's "Install all" does not appear there;
the site builder is where a collection is bundled.

## Building a site

`jupyter workshop lite` builds a static site carrying one or more
workshops, with the extension, the Pyodide kernel and the terminal, that
any web host can serve; [Publishing workshops](publishing.md#a-jupyterlite-site)
covers the command, what the build needs, and deploying to GitHub Pages.

## Testing

`jupyter workshop test my-workshop --lite` builds a site with the
workshop, serves it from a static file server under a sub-path, opens it
in a headless browser and runs every action, exactly as the server
self-test does. The first run downloads the terminal's WebAssembly
packages into the build directory; Pyodide loads from the CDN on every
run. `just selftest-lite` runs it on the example.
