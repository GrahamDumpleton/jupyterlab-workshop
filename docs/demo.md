# Trying the examples

Two hosted demos show the example workshops without installing
anything. Both use the released package.

- The [JupyterLite demo](https://grahamdumpleton.github.io/jupyterlab-workshop/demo/lab/index.html?reset&workshop=hello-jupyterlab&restart=force)
  runs the Hello JupyterLab workshop entirely in the browser, with a
  Python kernel compiled to WebAssembly and a small shell. The link
  carries JupyterLab's `reset` and the extension's `restart=force`, so
  every visit starts afresh; see [launch links](registry.md#launch-links).

- [Binder](https://mybinder.org/v2/gh/GrahamDumpleton/jupyterlab-workshop/main?urlpath=lab)
  starts a full JupyterLab with a real terminal, opening in the workshop
  browser with all three examples listed and ready to open: Git from the
  command line, Hello JupyterLab, and Writing your first workshop. A
  Binder session is temporary and takes a minute or two to start.

The examples are:

- **Git from the command line** creates a repository in a terminal and
  walks through add, commit, diff, branch, merge and a conflict, with
  checks after each step. It needs `git`, which Binder has and
  JupyterLite does not.

- **Hello JupyterLab** is a tour of what actions can do: notebooks,
  kernels, files and the editor, the interface, variables and tracks,
  automatic runs, and finishing.

- **Writing your first workshop** is a workshop about writing workshops
  with the `jupyter workshop` command and author mode, and was itself
  written that way.

To run the examples on your own machine, [Getting started](getting-started.md)
installs the extension and opens one from the workshop browser, or
CONTRIBUTING.md in the repository describes running them from a
checkout.

## Reset

The workshops keep their progress in a `_workshop` directory and write
their files beside it. The Restart button in the panel header, or
"Workshop: Restart…", puts the files back as they were when the
workshop was first opened and forgets the progress. In JupyterLite the
demo link above does that on every visit.
