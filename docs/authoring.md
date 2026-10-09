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
| Run actions, Run checks | Run the current page's steps or its checks in order, as the self-test would. [Attempts](checks.md#attempt) are left to a full run.                                        |
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

While author mode is on, progress events are not recorded, strict
[gating](checks.md#gating) is shown but not enforced, so every page can
be reached without passing the checks before it, and edits to the files
re-render the panel as they are saved, whether they were made in
JupyterLab or elsewhere. Restart only ever refills the
[workspace](concepts.md#the-workspace), so restarting to try the
workshop from the top keeps every edit to the pages and the manifest.

"Workshop: New Workshop…" (also in the launcher under Workshops)
scaffolds a directory from a template, `starter`, `blank` or
`notebook`, with the platforms, capabilities and gating you choose, and
opens it in author mode. It is the same scaffold as `jupyter workshop
init`, and like it makes the new directory a git repository, with
nothing committed, unless the directory is inside a repository already.

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

## Workshop Author

Workshop Author is an AI agent inside JupyterLab that writes and
revises your own workshops and courses. You describe the workshop you
want; it reads the [authoring skill](#the-authoring-skill), writes the
manifest and the pages, lints them, plays the workshop in your session
to check it works, and tells you when a version is ready to open. Then
you carry on the conversation, asking for changes, and it makes them.
For a [course](library.md#courses), a repository of workshops in parts,
it sets the repository up and designs the course with you before
writing its workshops.

It needs three things:

- The `ai` extra, installed where JupyterLab runs, which brings in the
  Claude Agent SDK:

  ```
  uv tool install "jupyterlab-workshop[lab,ai]"
  ```

- A [workshop library](library.md), since the workshops it writes are
  your own and go under `personal/workshops/`. `jupyter workshop library` opens
  one.

- Claude Code logged in on the machine. Workshop Author uses whatever
  Claude Code is logged in with, your Claude subscription, or
  `ANTHROPIC_API_KEY` when that is set where JupyterLab was started. It
  never asks for a password or a key of its own; when Claude Code is not
  logged in, the panel offers Log in, which opens a terminal running
  Claude Code's own login, and Check again.

With all three, the browser has "Create Workshop with AI…" and "Create
Course with AI…" buttons, the launcher a Workshop Author card, and each
card under My workshops and My courses an Edit with AI button. Edit with
AI on one of your workshops opens the conversation for that workshop, or
goes back to it. On a workshop in a course it opens the course's
conversation, since a course has one conversation for the whole
repository, with the workshop named in the message box for you to say
what to do with it.

### Creating a workshop

Create Workshop with AI opens Workshop Author on a new workshop that
does not exist yet. Say what it should teach and who it is for. The
agent asks about whatever it cannot tell from that: what the workshop
is for, and who will use it, whether people new to the subject,
experienced practitioners, or an audience watching a product
demonstration, which decides how much it checks and whether it has
quizzes. A request it cannot make sense of is met with a question,
never a guess.

When it knows enough, it proposes a plan: a title, the directory under
`personal/workshops/`, the audience, a summary, the pages in order, and whether
there are quizzes and gating. Press Create on the plan to make the
workshop, or reply with what to change and it proposes again. Until you
press Create, nothing is written: the agent can read and search the
web, but cannot change files or run commands, and the draft is kept by
the server outside your library. Discard draft forgets it.

Create makes the workshop under `personal/workshops/`, as a git
repository with nothing committed yet, and opens its own conversation,
which starts with everything said in the draft and the plan as the
agent's brief, and the agent goes on to write the workshop. A draft left
alone keeps until it is discarded, or for 30 days.

### Creating a course

Create Course with AI drafts a course the same way. Say what the course
should teach and who it is for; the agent asks what it cannot tell, in
particular how the course divides into parts, whether its workshops must
also run as a JupyterLite site in the browser, and what prefix its
collection ids should carry, a domain or forge account you control such
as `github.com/<account>`, since an id is permanent. The plan it
proposes is the course's title, its directory under `personal/courses/`,
a description, and its parts in order, each with a name, a title and a
description; a course with one part has one collection.

Create scaffolds the whole repository, exactly as
[`jupyter workshop course init`](cli.md#course) does: the design
document `OUTLINE.md` with a section for each part, empty ordered
collection indexes, the catalog, `AGENTS.md`, the Justfile, the Binder
and Codespaces configuration, the test workflow, and for JupyterLite the
site files and the Pages workflow, all recorded in `course.json` so
`course update` can refresh them later. The repository starts under git
with nothing committed. The course's own conversation then opens with
the design as the agent's brief: it fills in the outline with you, part
by part, and writes a workshop only once that part's outline is settled.

### The conversation

The conversation is held by the server, not the page: reloading the
page, or opening the same workshop's conversation in another tab, shows
it again where it was, and a conversation left alone for half an hour
is closed and picks up from where it stopped the next time it is
opened. What was said is kept in the workshop's `_workshop/agent.json`,
or for a course in `.workshop/agent.json` at the repository's root,
which its `.gitignore` leaves out. Stop ends the agent's turn; Open
workshop opens the workshop in the instructions panel in author mode;
Continue in terminal opens a terminal in the workshop's or course's
directory with the same conversation in Claude Code, with the authoring
skill and the workshop tools.

A course has one conversation, about the whole repository, rather than
one per workshop in it: two agents editing one repository and one
outline would work against each other. The agent reads the course's
`AGENTS.md` and `OUTLINE.md` first and keeps the outline true as the
work goes, opens a workshop of the course in your session with the live
tools, refreshes the collection indexes and the catalog, and commits
only when you tell it to, with no agent trailer on the commit, asking
for a name and email to set in the repository if git has none. It never
pushes, adds a remote or publishes unless asked.

### What it may do without asking

The agent works on the one workshop or course. Without asking, it reads
and changes the files in that directory, reads the authoring skill,
uses the [workshop tools](#what-the-tools-do), and searches and reads
the web to research the topic. Its live tools act in the browser tab
the conversation is open in, and no other.

When the agent needs to know something, it may ask in a card of its
own: each question with its options, to choose one or several, a box to
answer in your own words, and Submit or Skip. A question, like a
request for permission, brings the panel to the front.

Anything else asks first, in the panel, with Allow, Always allow (for
the rest of the conversation) and Deny: a file outside the workshop
directory, and a shell command, except that on macOS and Linux a shell
command runs inside a sandbox that keeps it to the workshop directory,
and only a command that needs to leave the sandbox asks. Workshops
downloaded into the library, from a collection or a URL of their own,
are never read or changed, and a conversation is never started for one,
since its directory could carry agent configuration from whoever wrote
it.

Publishing to a gist always asks, since it puts the workshop on GitHub.
Ask the agent to publish the workshop as a gist and, once it is ready,
it uses `publish_gist`: the first time that creates a secret gist (a
public one only if you ask), and the request to create one offers no
Always allow. The gist is recorded in the workshop's
`_workshop/gist.json`, so asking again later updates the same gist, and
an update can be allowed for the rest of the conversation. The GitHub
token is found where JupyterLab runs, from `GH_TOKEN`, `GITHUB_TOKEN` or
`gh auth login`; the agent never sees it. A workshop already published
with `jupyter workshop gist --update GIST` has its gist recorded the
same way.

The agent runs with none of your own Claude Code configuration: your
settings, plugins, hooks and MCP servers are not loaded, so it behaves
the same on every machine.

### The message box

The bar along the foot of the message box has the panel's controls and
says where the conversation stands:

- Attach chooses files to send with the message; see
  [Attaching files](#attaching-files).

- Open workshop opens the workshop in the instructions panel, in author
  mode, and Continue in terminal carries the conversation on in a
  terminal.

- The model the conversation answers with, chosen from the models Claude
  Code offers your account; hovering over it names the model actually
  answering. For a model that takes one, a second list sets the effort
  it puts in. The model changes from the next message; a change of
  effort restarts the conversation from where it is, keeping everything
  said. Both are kept with the workshop's conversation. A new
  conversation starts with the `ai.model` and `ai.effort` settings, or
  the agent's defaults when they are empty.

- How much of the model's context window the conversation fills, with
  the token counts on hover, and Compact, which has the agent replace
  the conversation so far with a summary of it, freeing the window for
  more. The agent also compacts by itself when the window is nearly
  full. Either way the status says Compacting while it runs, and a line
  across the conversation marks where the summary took over.

- What the conversation has cost so far, shown only when it runs on an
  API key; on a subscription, usage counts against the plan's limits
  instead.

- Whether the agent is starting, working or ready, and Send, which
  becomes Stop while the agent works.

The account the agent answers on, a Claude plan or an API key, is shown
at the top of the panel, beside New conversation, which, once confirmed,
starts the workshop's conversation over: the agent forgets what was
said and the conversation is cleared, while the workshop itself is left
as it is.

A message starting with `/` goes to Claude Code as one of its own
commands: `/compact` with instructions of your own compacts with them
in mind, and `/context` and `/cost` answer in the conversation. `/clear`
does what New conversation does, without asking.

### Attaching files

A message can carry files: a screenshot of what a page should look
like, a diagram to use, a PDF of the slides a workshop follows, notes.
Paste a file or an image into the message box, drop files onto it from
the desktop, drag them from JupyterLab's file browser, or press Attach
and choose them. Each shows as a chip above the box, with a cross to
take it off, until the message is sent. Text pasted into the box goes
into the box as usual, unless it is long (more than about two thousand
characters or forty lines), in which case it is attached as a text file
instead, as it would be in Claude Code.

Images (PNG, JPEG, GIF and WebP), PDFs and text files can be attached,
up to 5 MB for an image, 10 MB for a PDF and 1 MB for a text file, and
at most 24 MB in one message. An image larger than the model would look
at is shrunk before it is sent.

The agent sees an image in the message itself and a text file as its
text; a PDF it reads from the file. Every attachment is also saved under
`_workshop/attachments/` in the workshop, where the agent may read it,
and the message tells the agent where. So a file the workshop itself
needs can be attached, an image for a page or data its actions work on:
ask, and the agent copies it into a directory of the workshop's own,
such as `images/`, since `_workshop/` is the workshop's state, not part
of it. In a course's conversation they are saved under
`.workshop/attachments/` at the repository's root instead. The files
stay there until New conversation, which removes them with the
conversation. While a new workshop or course is being drafted,
attachments are saved with the draft, outside the library, and go to
the workshop or course when it is created, or away with the draft when
it is discarded. The conversation's record keeps each attachment's
name, type and size, not its content, so after a reload the message
shows what went with it.

```{note}
Usage counts against whatever Claude Code is logged in with. When
`ANTHROPIC_API_KEY` is set where JupyterLab was started, Claude Code
uses it in place of a subscription and the usage is billed to that API
account; the panel says so. The Claude Agent SDK's wheels carry Claude
Code for macOS and Linux; on Windows, install Claude Code separately so
that `claude` is on the path.
```

`ai-authoring` in [`disabledFeatures`](settings.md#deployment-settings)
removes Workshop Author. A deployment needs nothing to keep it away,
since it appears only with the `ai` extra and in a library.

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
page list with ids and requirements), `init`, `publish`,
`publish_gist` (as `jupyter workshop gist`: it creates a gist, or
updates the one recorded for the workshop, with a GitHub token found
where the server runs), `index`, `catalog`, `draft` (pages from a saved
recording), `list_collection`, `list_catalog`, `get_schema` and
`test`. The server keeps no notion of
a current workshop, so the agent names the directory each time, as an
absolute path or one relative to where the client started it.

**Live tools** act on a running JupyterLab, on whatever workshop it has
open in author mode, and take no directory. `open_workshop` opens a
workshop in author mode, `session_status` reports what is open (the
workshop, the current page, the trust level, whether a recording is on,
the lint counts, and the id of the tab that answered), `run_action` runs one action that is not in any
page, `run_page` runs a page's actions, its checks, or both,
`run_workshop` runs every page in order, `run_progress` reports how far
a run started in the background has got, and `reset_workshop` forgets
the workshop's progress so the next run starts from its first page.

`run_workshop` and `run_page` take a `pace`: `fast` runs everything back
to back, for testing; `demo` and `presentation` pause before each action
and on each new page, with the action scrolled into view and pulsed in
the panel first, so the run can be recorded as a video or stepped
through in front of an audience. An agent asked to demonstrate or record
a workshop picks the pace; the individual delays can be set as well when
the timing matters. A long or paced run is started with `wait` off and
followed through `run_progress`, which carries the report once the run
finishes. At the `fast` pace, a run that reaches the end with nothing
failed then leaves the workshop as Finish does, closing its documents,
panes and terminals and folding away the instructions panel, so the
session is left as it was found and the conversation the run was asked
from comes back to the front, whichever other conversations are open;
a run with a failure stays open where it stopped. `close` turns this on or off for
any pace. The same pacing is available to
[`jupyter workshop test`](cli.md#pacing-a-run-for-an-audience) for a
recording that needs no agent.

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
   mode gets turned on. A request can instead name one tab by its id, and
   then only that tab runs it, or says at once that it has no workshop in
   author mode; a tool working on behalf of one tab uses this so that
   other tabs in author mode are left alone.

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
