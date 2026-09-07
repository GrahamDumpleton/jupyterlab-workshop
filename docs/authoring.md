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
| Publish                 | Builds the archive, its SHA-256 and a registry entry under `dist/` in the workshop.                                                                                       |
| Record                  | Records the session into draft pages; see below.                                                                                                                          |

Every action in the page also gets a small gutter with its type and
line, and edit and delete buttons. Edit opens the same form as Insert,
filled in, and rewrites the block in place. Lint findings that refer to
a line are shown under the block they refer to.

While author mode is on, progress events are not recorded, and edits to
the files re-render the panel as they are saved, whether they were made
in JupyterLab or elsewhere.

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

`jupyter workshop mcp` serves the tooling over the Model Context
Protocol on standard input and output, for Claude Code, jupyter-ai and
other MCP clients. It needs the `mcp` extra:

```
uv add "jupyterlab-workshop[mcp]"
```

or `pip install "jupyterlab-workshop[mcp]"`.

A Claude Code configuration, for example, is:

```json
{
  "mcpServers": {
    "workshop": { "command": "jupyter", "args": ["workshop", "mcp"] }
  }
}
```

Tools that work on files: `lint`, `render`, `pages`, `test`, `init`,
`publish`, `index`, `draft`, `get_schema` and `list_registry`. Tools that act on
a running JupyterLab: `open_workshop`, `session_status`, `run_action`,
`run_page` and `run_workshop`. Resources: the manifest and registry
schemas, and the authoring skill.

The live tools reach JupyterLab through the server extension: a request
becomes a Jupyter Server event, the extension runs the command in the
browser tab that has the workshop open in author mode, and posts the
result back. The MCP server finds the running server through
`jupyter server list`; pass `--url` and `--token` to name one.
Nothing runs in a tab that is not in author mode.

### The authoring skill

`skills/workshop-author/SKILL.md` in the repository, shipped in the
package and served as the `workshop://skill` resource, explains the
format to an agent: the manifest, page syntax, the actions and checks,
the rules that keep lint and the self-test green, and how to read test
output. Its `references/` hold the full action table, a style guide and
a page template. Point an agent at it (Claude Code loads skills from a
`skills/` directory; other clients read the resource) and ask for a
workshop; the loop it follows is init, write, lint, test, fix.

The `workshop-authoring` example was written that way and is a workshop
about writing workshops.

### jupyter-ai

There is no jupyter-ai persona yet. jupyter-ai can use MCP servers, so
configure `jupyter workshop mcp` there in the same way and ask its
assistant to read the `workshop://skill` resource first.
