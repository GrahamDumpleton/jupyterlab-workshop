# Trying it out

Two hosted demos show workshops without installing anything. Both use
the released package.

- [Binder](https://mybinder.org/v2/gh/GrahamDumpleton/jupyterlab-workshop-showcase/main?urlpath=lab)
  starts a full JupyterLab with a real terminal from the [showcase
  repository](https://github.com/GrahamDumpleton/jupyterlab-workshop-showcase), opening in the workshop browser with its
  three workshops listed, numbered and ready to open. A Binder session
  is temporary and takes a minute or two to start, longer the first
  time after a release.

- The [JupyterLite demo](https://grahamdumpleton.github.io/jupyterlab-workshop/demo/lab/index.html?reset&workshop=hello-jupyterlab&restart=force)
  runs the Hello JupyterLab example entirely in the browser, with a
  Python kernel compiled to WebAssembly and a small shell, to show a
  workshop running with nothing installed. The link carries JupyterLab's
  `reset` and the extension's `restart=force`, so every visit starts
  afresh; see [launch links](collections.md#launch-links).

The showcase workshops, taken in order, are:

- **Why a workshop?** does one small task from a notebook of
  instructions, then does it again as a workshop: actions that open the
  terminal and run the commands, a check that turns green by itself, a
  panel that knows who you are and how far you have got, and a window
  that arranges itself for the lesson. It ends by opening its own
  source.

- **Guided, not just documented** is about instructions that check
  your work: three tasks done by hand, each noticed by a check, strict
  gating that holds the next page until it passes, a form whose answer
  flows into the text, the commands and the checks, and a checkpoint
  that puts the files back after you delete them.

- **Write your own** scaffolds a workshop with the `jupyter workshop`
  command, adds a page with an action and a check, lints it, breaks it
  and fixes it, and writes a collection index for it.

The showcase repository is also the pattern for publishing a collection
of your own: workshops in directories, one `collection.json` at the
root, `binder/` files, and a workflow that lints and self-tests every
workshop. [Publishing workshops](publishing.md) describes each part.

To run the showcase on your own machine, [Getting
started](getting-started.md) installs the extension and subscribes to
the collection from the workshop browser. The repository of the
extension itself holds a few example workshops that serve as its test
fixtures; CONTRIBUTING.md there describes running them from a
checkout.

## Reset

The workshops keep their progress in a `_workshop` directory and write
their files beside it. The Restart button in the panel header puts the
files back as they were when the workshop was first opened and forgets
the progress; so does "Workshop: Restart…" in JupyterLab's command
palette, the searchable list of commands opened with Ctrl+Shift+C
(Cmd+Shift+C on a Mac) or View, Activate Command Palette. In JupyterLite
the demo link above does that on every visit.
