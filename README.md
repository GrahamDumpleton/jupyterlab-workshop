# jupyterlab-workshop

Guided, interactive workshops inside JupyterLab.

> **Early in development.** The documentation and the experience are
> still being polished, and the workshop format, settings and command
> line can change between releases without a compatibility path.

Teaching in JupyterLab usually means a notebook with explanation between
the code cells. Learners read down it pressing Run, everything has to be
a cell in one language, and nothing can tell whether a step was done.
This extension separates the instructions from the work: they live in a
side panel, one page at a time, and each step is a clickable action that
does something real in the JupyterLab session beside it, in a terminal,
the editor, a notebook, a kernel or the interface itself. Workshops can
check what the learner has done, ask questions, collect values, hold
pages until requirements are met, and snapshot the working directory,
and the subject can be anything JupyterLab can host, including
JupyterLab itself.

A workshop is a directory with a `workshop.yaml` manifest and Markdown
pages. The format is text based and git friendly. A workshop runs
wherever JupyterLab runs, and can be handed to learners through a
published collection, a Binder link, or a static JupyterLite site that
runs entirely in the browser.

## Install

The package is a prebuilt JupyterLab 4 extension with its server
extension, installed into a virtual environment alongside JupyterLab
with `uv add jupyterlab jupyterlab-workshop` or the pip equivalent, or,
to run workshops without a project of your own, as a tool with
`uv tool install "jupyterlab-workshop[lab]"` and then
`jupyter-workshop launch --root ~/learning --collection <url>`.
[Getting started](https://jupyterlab-workshop.readthedocs.io/en/latest/getting-started.html)
walks through the setup, runs an example workshop and scaffolds one of
your own; the `jupyter workshop` command that comes with the package
lints, self-tests and publishes workshops, and author mode in JupyterLab
edits them in place.

## Learn more

- [Launch the showcase on Binder](https://mybinder.org/v2/gh/GrahamDumpleton/jupyterlab-workshop-showcase/main?urlpath=lab):
  three short workshops that show what the extension does and why, in
  a full JupyterLab with a real terminal, from the
  [showcase repository](https://github.com/GrahamDumpleton/jupyterlab-workshop-showcase) that is also the pattern for
  publishing a collection of your own. Or
  [try the demo](https://grahamdumpleton.github.io/jupyterlab-workshop/demo/lab/index.html?reset&workshop=hello-jupyterlab&restart=force):
  the Hello JupyterLab example running in JupyterLite, started afresh
  on every visit.

- [How workshops work](https://jupyterlab-workshop.readthedocs.io/en/latest/concepts.html)
  and the
  [tutorial](https://jupyterlab-workshop.readthedocs.io/en/latest/tutorial.html),
  which writes a small workshop from nothing and publishes it.

- [Using workshops](https://jupyterlab-workshop.readthedocs.io/en/latest/using.html)
  for learners and
  [Deploying workshops](https://jupyterlab-workshop.readthedocs.io/en/latest/deploying.html)
  for Binder, JupyterHub and locked-down images.

- [The documentation](https://jupyterlab-workshop.readthedocs.io/) for
  the rest: every action a page can use, checks and forms, variables,
  layouts, platforms, JupyterLite, publishing, trust, the manifest and
  settings references, the command line and authoring in JupyterLab.

- [Source, issues and contributing](https://github.com/GrahamDumpleton/jupyterlab-workshop):
  see `CONTRIBUTING.md` in the repository for the development setup.

## License

Apache License 2.0.
