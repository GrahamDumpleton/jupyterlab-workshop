# Getting started

This page installs the extension on your own machine, subscribes to
the showcase collection and runs a workshop from it, and scaffolds a
workshop of your own. It takes about fifteen minutes. To see a workshop
without installing anything, use the [hosted demos](demo.md) instead.

## Install

The package is a prebuilt JupyterLab 4 extension with its server
extension. It goes into a Python virtual environment together with
JupyterLab, since a system Python is usually not yours to install into
and often has no `pip` command at all. Make a directory to work in,
create the environment there and start JupyterLab from it: the
directory JupyterLab starts in becomes its root, workshops you install
land under it, and one you scaffold has to be inside it to open. A home
directory is a poor choice, since everything in it shows in the file
browser.

With [uv](https://docs.astral.sh/uv/), which is the shortest route:

```
uv init --bare workshops-playground
cd workshops-playground
uv add jupyterlab jupyterlab-workshop
uv run jupyter lab
```

`uv init --bare` writes a `pyproject.toml` recording what the project
needs, `uv add` creates a `.venv` there and installs into it, and
`uv run` runs a command with that environment active. The extension
does not pull in JupyterLab itself, which is why both are named.

With Python's own tools instead:

```
mkdir workshops-playground
cd workshops-playground
python3 -m venv .venv
source .venv/bin/activate
pip install jupyterlab jupyterlab-workshop
jupyter lab
```

On Windows the activation line is `.venv\Scripts\activate`. The rest of
this page assumes the environment is active; with uv, put `uv run` in
front of any command typed outside JupyterLab.

The Workshop panel is the tab with the graduation cap icon in the right
sidebar. On a fresh install it says "No workshop is open" and offers
three buttons: Browse workshops, Open a directory and Open from URL.

## Run a workshop from the showcase

Workshops reach a JupyterLab through collections: published lists of
workshops that the workshop browser subscribes to and installs from. A
fresh install subscribes to none, so the first step is to subscribe to
one. The project publishes a [showcase
collection](https://github.com/GrahamDumpleton/jupyterlab-workshop-showcase) of three short workshops that show what the
extension does and why; it is also a repository laid out as a
collection, the pattern to copy for one of your own.

Click Browse workshops, then Collections…, paste the address of the
showcase's index into the field and click Subscribe:

```
https://raw.githubusercontent.com/GrahamDumpleton/jupyterlab-workshop-showcase/main/collection.json
```

Close the dialog and the three workshops appear under Available, in
order, with a step number on each. Install the first, Why a workshop?,
and it moves to Installed; Open starts it. The extension downloads it
into `workshops/why-a-workshop` under the directory JupyterLab was
started in. [Finding and installing workshops](collections.md) covers
the browser, collections and the launch links that hand a workshop to
learners.

The same can be done from the shell in one line, which starts JupyterLab
with the showcase added for the session and the browser open:

```
jupyter workshop launch --collection https://raw.githubusercontent.com/GrahamDumpleton/jupyterlab-workshop-showcase/main/collection.json
```

Naming a workshop as well, `jupyter workshop launch why-a-workshop
--collection …`, installs and opens it straight away; see
[launch](cli.md#launch) for the options.

```{figure} _static/trust-dialog.png
:alt: The trust dialog for the Why a workshop? workshop
:width: 100%

The trust dialog: where the workshop came from, what it asks to do, and
the three levels.
```

Before anything runs, the trust dialog shows where the workshop came
from, the capabilities it declares (a terminal, writing files, running
code in kernels, and so on) with how many actions use each, and any lint
findings. The showcase workshops are safe to Trust. Restricted is the
cautious choice for a workshop you do not know: commands are typed into
the terminal for you to press Enter, and file and kernel actions ask
before they run. See [Loading and trust](trust.md) for the levels.

```{figure} _static/panel.png
:alt: JupyterLab with the Why a workshop? workshop open in the Workshop panel
:width: 100%

The Workshop panel on the right, on the second page of Why a workshop?,
after its first action has run and its check has passed.
```

The instructions appear in the panel and the workshop lays out the
window: a rendered README, a terminal, whatever the workshop asked for.
Read the first page and click an action. Each one is a box showing
exactly what it will do, and it runs in the session beside you: a
command in the terminal, a notebook created and run, a file written and
opened. Move on with Next at the foot of the panel. A page with checks
shows what is still to do, and the last page ends with Finish and a
dialog offering what to do next: in a collection that declares its
workshops a sequence, as the showcase does, that includes the next one.

Two buttons in the panel header are worth knowing. Restart puts the
workshop's files back as they were when it was first opened and forgets
the progress, for starting over. The browser's Remove button deletes an
installed workshop.

## Scaffold your own

The `jupyter workshop` command comes with the package. Run it in a
terminal opened inside JupyterLab (File, New, Terminal), which starts
in the right directory with the environment on its path, or in any
other terminal in `workshops-playground` with the environment active,
or `uv run` in front:

```
jupyter workshop init my-workshop --title "My first workshop"
```

That writes a `workshop.yaml` manifest, two pages under `pages/`, a
README and a `.gitignore`. The first page runs a command and checks its
result; the second writes a file and asks a question. Open it: right
click the `my-workshop` directory in the file browser and choose "Open
as Workshop", or use the panel's Open a directory button. A local
directory brings up the same trust dialog; Trust it, it is yours.

Turn on author mode with the pencil button in the panel header, or
with "Workshop: Author Mode" from the command palette. The command
palette is JupyterLab's searchable list of every command: press
Ctrl+Shift+C (Cmd+Shift+C on a Mac), or choose View, Activate Command
Palette, then type "author" and press Enter. Everything the extension
adds is listed there with the prefix "Workshop:". Author mode marks the
workshop as your own, so editing it never brings the trust dialog back,
and adds a toolbar to the panel. Edit page opens the page source beside the
panel, and saving re-renders it, so you can change a sentence or an
action and see the result at once. [Writing workshops in
JupyterLab](authoring.md) describes the rest of the toolbar.

Check the workshop from the command line. The linter needs Node.js 18
or newer on the path:

```
jupyter workshop lint my-workshop
```

The self-test runs every action in a real JupyterLab and reports each
one. It starts a JupyterLab of its own on a free port, so it does not
disturb the one you are using, and it works on a temporary copy of the
workshop, so the workshop's files are safe. It needs two more things. The package's `test` extra installs Playwright, a library that
drives a browser from Python, and Playwright then needs a browser of its
own: `playwright install chromium` downloads a copy of Chromium into
Playwright's cache, a one-time download of a few hundred megabytes that
is separate from any browser on the machine.

```
uv add "jupyterlab-workshop[test]"
uv run playwright install chromium
uv run jupyter workshop test my-workshop
```

With pip, `pip install "jupyterlab-workshop[test]"` and then the same
two commands without `uv run`.

```{warning}
The copy is the only protection. The workshop's terminal commands and
checks run as you, on this machine, with your home directory and your
Python environment. That is fine for a workshop like this one, which
only touches its own directory. A workshop written for a throwaway
container may change global git settings, install packages into your
environment or delete paths under your home directory, so read every
command before testing a workshop you did not write, and test one that
reaches outside its directory in CI or a container instead. See [the
command reference](cli.md#test).
```

A green self-test is what a workshop's continuous integration runs;
`init --ci` writes a GitHub Actions workflow for it, and its fresh
runner is the safest place to test a workshop that changes the system
it runs on.

## Where next

- [How workshops work](concepts.md) explains the pieces you just used:
  manifest, pages, actions, capabilities, trust, checks and state.

- [Action reference](actions.md) lists every action a page can use, and
  [Checks, forms, gating and checkpoints](checks.md) covers verifying
  what the learner has done.

- [Finding and installing workshops](collections.md) covers the browser,
  collections, catalogs and launch links for handing a workshop to
  learners.
