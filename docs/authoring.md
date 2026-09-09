# Writing workshops in JupyterLab

Files are the source of truth: a workshop is `workshop.yaml` and
`pages/*.md`, and every authoring tool reads and writes those files. You
can move freely between the panel's author mode, the JupyterLab editor,
an external editor, git and an AI agent.

## Author mode

"Workshop: Author Mode" (in the command palette, or the pencil button in
the panel header) turns editing on for the open workshop. It marks the
workshop as your own, so it is trusted at every hash from then on and
saving a page never brings the trust dialog back, and it adds a toolbar
to the panel:

| Button                  | What it does                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit page               | Opens the page source in the editor beside the panel. Saving re-renders the panel.                                                                                        |
| New page                | Adds a page after the last one and lists it in the manifest.                                                                                                              |
| Pages                   | Reorders, renames, adds and removes pages, and sets `optional` and `requires` in their front matter. Removed pages stay on disk.                                          |
| Manifest                | Opens `workshop.yaml` in the editor. Saving reloads the workshop.                                                                                                         |
| Insert                  | A form for an action: pick the type, fill in its options, write the body. The block goes at the cursor of the page open in the editor, or at the end of the current page. |
| Capture                 | Adds what you just did in the session, the last terminal commands, files saved and cells run, to the page as actions.                                                     |
| Run actions, Run checks | Run the current page's steps or its checks in order, as the self-test would.                                                                                              |
| Lint                    | Opens the lint panel: every finding with its file and line, and a Fix button for the mechanical ones (declare or remove a capability, drop an unknown option).            |
| Trust                   | Shows the dialog learners will see for this manifest.                                                                                                                     |
| Publish                 | Builds the archive, its SHA-256 and a collection entry under `dist/` in the workshop.                                                                                     |
| Record                  | Records the session into draft pages; see below.                                                                                                                          |

```{figure} _static/author-mode.png
:alt: The Workshop panel in author mode
:width: 60%

The panel in author mode: the toolbar, and a gutter under each action.
```

Every action in the page also gets a small gutter with its type and
line, and edit and delete buttons. Edit opens the same form as Insert,
filled in, and rewrites the block in place. Lint findings that refer to
a line are shown under the block they refer to.

While author mode is on, progress events are not recorded, and edits to
the files re-render the panel as they are saved, whether they were made
in JupyterLab or elsewhere. Restart only ever refills the
[workspace](concepts.md#the-workspace), so restarting to try the
workshop from the top keeps every edit to the pages and the manifest.

"Workshop: New Workshop…" (also in the launcher under Workshops)
scaffolds a directory from a template, `starter`, `blank` or
`notebook`, with the platforms, capabilities and gating you choose, and
opens it in author mode. It is the same scaffold as `jupyter workshop
init`.

## Recording a session

Record turns what you do into pages. While recording, terminal commands
(typed into any terminal, or run by clicking an action), files saved in
the editor, and notebook cells run are kept as steps; "Record: New
Page…" starts a new page. Stopping asks whether to add the pages to the
open workshop or create a new one, then writes one action per step with
a placeholder paragraph to fill in:

- A command becomes `execute`. Tab completion and history recall cannot
  be seen by the recorder, so such commands carry a note to check them.

- A file saved for the first time becomes `file-write` with `:open:
true`. A save that changed one line becomes `editor-replace`; other
  changes are written as the whole file again.

- A cell run becomes `cell-insert` with `:run: true`.

- Opening a file becomes `file-open` or `notebook-open`, unless the file
  was just written.

The recording itself is saved under `_workshop/recordings/` as JSON.
`jupyter workshop record RECORDING DIRECTORY` writes the same draft
pages from a saved recording, into an existing workshop or a new
directory, so a recording can be redrafted after the fact.

The draft is a starting point: rewrite the placeholders, merge steps,
add checks, then lint and test.

## Tools for AI agents

`jupyter workshop mcp` serves the workshop tooling over the Model
Context Protocol (MCP), the interface through which Claude Code,
jupyter-ai and other agent clients call external tools. An agent with
this server configured can scaffold a workshop, lint it, render it, run
its actions in your JupyterLab and self-test it, instead of only editing
files and hoping. The server speaks MCP on standard input and output;
the client starts it as a subprocess and stops it when it exits. It
needs the `mcp` extra:

```
uv add "jupyterlab-workshop[mcp]"
```

or `pip install "jupyterlab-workshop[mcp]"`.

### What the tools do

There are two kinds of tool, and they find the workshop differently.

**File tools** work on a workshop directory on disk and need no
JupyterLab at all. Each takes a `directory` argument on every call:
`lint`, `render` (a page or the whole workshop as HTML), `pages` (the
page list with ids and requirements), `init`, `publish`, `index`,
`catalog`, `draft` (pages from a saved recording), `list_collection`,
`list_catalog`, `get_schema` and `test`. The server keeps no notion of
a current workshop, so the agent names the directory each time, as an
absolute path or one relative to where the client started it.

**Live tools** act on a running JupyterLab, on whatever workshop it has
open in author mode, and take no directory. `open_workshop` opens a
workshop in author mode, `session_status` reports what is open (the
workshop, the current page, the trust level, whether a recording is on,
and the lint counts), `run_action` runs one action that is not in any
page, `run_page` runs a page's actions, its checks, or both, and
`run_workshop` runs every page in order.

The live tools are what make an agent effective. Without them it can
only edit files, lint, and run the self-test, which starts a JupyterLab
of its own and takes minutes. With them it works in the session you are
looking at: it opens the workshop it just scaffolded, tries a `verify`
against the real state before writing it into a page, runs the page it
just edited to see the checks pass, and rehearses the whole workshop,
all in seconds and in front of you. The full self-test is still the
final word, since it runs on a clean copy.

```{warning}
`test`, `run_action`, `run_page` and `run_workshop` run the workshop's
commands and checks for real, as you, on the machine JupyterLab is
running on, and so do the Run actions and Run checks buttons. The live
tools also run on the workshop directory itself, not a copy, and the
state they leave behind accumulates between runs. The authoring skill
tells an agent not to run any of them unless asked to, or unless it has
read every command and none reaches outside the workshop directory; see
the [warning under test](cli.md#test).
```

### How the live tools reach JupyterLab

Workshop actions run in the browser: it is the JupyterLab frontend that
opens terminals, writes files and runs cells, and the Jupyter server
knows nothing about them. A tool running in another process therefore
cannot run an action itself. It asks the tab to, through the server
extension, in one round trip per call:

1. The MCP server sends the command and its arguments to the server
   extension over HTTP, authenticated with the server's token.

2. The server extension parks the request and announces it as a Jupyter
   Server event, which every JupyterLab tab connected to that server
   receives over the events websocket.

3. A tab that has a workshop open in author mode runs the command,
   exactly as the toolbar button would, and posts the result back to the
   server. Tabs not in author mode ignore the request, so a tool can
   never drive a learner's session; only `open_workshop` and
   `session_status` are answered by any tab, since they are how author
   mode gets turned on.

4. The server returns that result to the MCP server, and the tool
   returns it to the agent. When no tab answers within the tool's
   timeout the agent gets a message saying so.

The tab has to be open and awake for this to work. If several tabs are
connected to the same server, keep one of them in author mode: all of
them receive the event, and two authoring tabs would both run the action.

The MCP server finds the Jupyter server in this order: the `--url` and
`--token` given to `jupyter workshop mcp`; then the `JUPYTER_SERVER_URL`
and `JUPYTER_TOKEN` environment variables; then the first server that
`jupyter server list` reports for your user. When more than one is
running, pass `--url` and `--token` to be sure.

### Where to start the client and JupyterLab

The MCP server runs with the working directory of the agent client: the
directory Claude Code was started in, or the workspace folder for the
VS Code extension. That directory only decides what relative paths
mean; the agent passes the workshop directory to each file tool itself,
so the client can be started in the workshop directory, in a parent
holding several workshops, or anywhere at all if the agent uses absolute
paths. The client's environment matters more than its directory: the
`jupyter` the configuration runs must be the one with this package and
its `mcp` extra installed, so start the client where that `jupyter` is
on the path, or give the configuration an absolute path or a `uv run`
prefix.

JupyterLab is a separate process with a separate root, set by the
directory you run `jupyter lab` in. The path given to `open_workshop` is
relative to that root, not to the client's directory, and a workshop
outside the root cannot be opened at all. So for the live tools, start
JupyterLab in a directory that contains the workshop. The simplest
arrangement is to start both the client and JupyterLab from the same
parent directory, so the two sets of paths coincide.

A Claude Code configuration, in a `.mcp.json` at the project root (the
VS Code extension reads the same file from the workspace folder), is:

```json
{
  "mcpServers": {
    "workshop": { "command": "jupyter", "args": ["workshop", "mcp"] }
  }
}
```

That runs whichever `jupyter` is on the path, so it suits a global
install. Two other forms cover the other ways the package is installed:

- In a uv project whose environment has the package, so `jupyter` is
  not on the path but `uv run` finds it:

  ```json
  "workshop": { "command": "uv", "args": ["run", "jupyter", "workshop", "mcp"] }
  ```

- With no environment at all, letting uv install the package into a
  cached environment of its own on first use, which takes a few seconds
  the first time and is instant after that:

  ```json
  "workshop": {
    "command": "uv",
    "args": ["run", "--no-project", "--with", "jupyterlab-workshop[mcp,test]",
             "jupyter", "workshop", "mcp"]
  }
  ```

  `--no-project` stops uv from also trying to set up a project in the
  directory the client started in. Pin a version in the requirement
  (`jupyterlab-workshop[mcp,test]==0.1.15`) to control when it upgrades.

  The `test` extra is for the `test` tool, which needs Playwright and a
  browser; the file and live tools need only `[mcp]`, so drop `test`
  if the agent will never self-test. Playwright keeps browsers in a
  per-user cache outside any Python environment, but each Playwright
  version wants its own browser build, so download it with the same
  Playwright the server will use by running the same uv command once,
  from any directory:

  ```
  uv run --no-project --with "jupyterlab-workshop[mcp,test]" playwright install chromium
  ```

  That is needed once, and again only when a pinned version bump brings
  a newer Playwright, which the self-test reports by asking for it.

`--url` and `--token` are optional. Without them the server is found as
described above, which is enough when one JupyterLab is running. To pin
one, append them to the arguments, for example `"--url",
"http://localhost:8888", "--token", "abc123"`.

Turning on author mode in the tab yourself is not required: the agent
calls `open_workshop`, which opens the workshop in author mode and
brings the panel forward. Author mode marks the workshop trusted for
that session, as it does when you turn it on by hand.

### The authoring skill

`skills/jupyterlab-workshop-authoring/SKILL.md` in the repository, shipped in the
package and served as the `workshop://skill` resource, explains the
format to an agent: the manifest, page syntax, the actions and checks,
the rules that keep lint and the self-test green, and how to read test
output. Its `references/` hold the full action table, a style guide and
a page template. Point an agent at it (Claude Code loads skills from a
`skills/` directory; other clients read the resource) and ask for a
workshop; the loop it follows is init, write, lint, test, fix, where the
test step waits for your go-ahead unless the workshop is contained to
its own directory.

The `workshop-authoring` example was written that way and is a workshop
about writing workshops.

### jupyter-ai

There is no jupyter-ai persona yet. jupyter-ai can use MCP servers, so
configure `jupyter workshop mcp` there in the same way and ask its
assistant to read the `workshop://skill` resource first.
