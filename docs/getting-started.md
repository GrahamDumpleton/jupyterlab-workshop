# Getting started

This page installs the extension on your own machine, runs one of the
example workshops, and scaffolds a workshop of your own. It takes about
fifteen minutes. To see a workshop without installing anything, use the
[hosted demos](demo.md) instead.

## Install

The package is a prebuilt JupyterLab 4 extension with its server
extension, so one install is all it needs:

```
pip install jupyterlab-workshop
jupyter lab
```

The Workshop panel is the tab with the graduation cap icon in the right
sidebar. On a fresh install it says "No workshop is open" and offers
three buttons: Browse workshops, Open a directory and Open from URL.

```{note}
The panel may also show a message that it could not open
`examples/git-basics`. That is the `defaultWorkshop` setting, which
points at the example in the project's own checkout; it does nothing
harmful. Clear it under Settings, Workshop, to make the message go away.
```

## Run an example

Click Browse workshops. The browser lists the workshops of the
project's registry under Available: Git from the command line, Hello
JupyterLab, and Writing your first workshop. Install Hello JupyterLab.
The extension downloads it into `workshops/hello-jupyterlab` under the
directory JupyterLab was started in, then opens it.

Before anything runs, the trust dialog shows where the workshop came
from, the capabilities it declares (a terminal, writing files, running
code in kernels, and so on) with how many actions use each, and any lint
findings. The examples are safe to Trust. Restricted is the cautious
choice for a workshop you do not know: commands are typed into the
terminal for you to press Enter, and file and kernel actions ask before
they run. See [Loading and trust](trust.md) for the levels.

The instructions appear in the panel and the workshop lays out the
window: a rendered README, a terminal, whatever the workshop asked for.
Read the first page and click an action. Each one is a box showing
exactly what it will do, and it runs in the session beside you: a
command in the terminal, a notebook created and run, a file written and
opened. Move on with Next at the foot of the panel. A page with checks
shows what is still to do, and the last page ends with Finish and a
dialog offering what to do next.

Two buttons in the panel header are worth knowing. Restart puts the
workshop's files back as they were when it was first opened and forgets
the progress, for starting over. The browser's Remove button deletes an
installed workshop.

## Scaffold your own

The `jupyter workshop` command comes with the package. From the
directory JupyterLab was started in:

```
jupyter workshop init my-workshop --title "My first workshop"
```

That writes a `workshop.yaml` manifest, two pages under `pages/`, a
README and a `.gitignore`. The first page runs a command and checks its
result; the second writes a file and asks a question. Open it: right
click the `my-workshop` directory in the file browser and choose "Open
as Workshop", or use the panel's Open a directory button. A local
directory brings up the same trust dialog; Trust it, it is yours.

Turn on author mode with "Workshop: Author Mode" from the command
palette, or the pencil button in the panel header. It marks the workshop
as your own, so editing it never brings the trust dialog back, and adds
a toolbar to the panel. Edit page opens the page source beside the
panel, and saving re-renders it, so you can change a sentence or an
action and see the result at once. [Writing workshops in
JupyterLab](authoring.md) describes the rest of the toolbar.

Check the workshop from the command line. The linter needs Node.js 18
or newer on the path:

```
jupyter workshop lint my-workshop
```

The self-test runs every action in a real JupyterLab and reports each
one. It needs the `test` extra and a browser:

```
pip install "jupyterlab-workshop[test]"
playwright install chromium
jupyter workshop test my-workshop
```

A green self-test is what a workshop's continuous integration runs;
`init --ci` writes a GitHub Actions workflow for it.

## Where next

- [How workshops work](concepts.md) explains the pieces you just used:
  manifest, pages, actions, capabilities, trust, checks and state.

- [Action reference](actions.md) lists every action a page can use, and
  [Checks, forms, gating and checkpoints](checks.md) covers verifying
  what the learner has done.

- [Finding and installing workshops](registry.md) covers the browser,
  registries and launch links for handing a workshop to learners.
