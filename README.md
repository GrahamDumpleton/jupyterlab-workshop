# jupyterlab-workshop

Guided, interactive workshops inside JupyterLab.

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

![JupyterLab with the Why a workshop? workshop open in the Workshop panel](https://jupyterlab-workshop.readthedocs.io/en/latest/_images/panel.png)

A workshop is a directory with a `workshop.yaml` manifest and Markdown
pages. The format is text based and git friendly. A workshop runs
wherever JupyterLab runs, and can be handed to learners through a
published collection, a Binder link, a container image, or a static
JupyterLite site that runs entirely in the browser.

## Install

The quickest way in is as a tool, which gives you a `jupyter-workshop`
command with JupyterLab, the extension and a Python kernel in an
environment of its own, and then to start your workshop library:

```
uv tool install "jupyterlab-workshop[lab]"
jupyter-workshop library
```

That opens JupyterLab on your
[workshop library](https://jupyterlab-workshop.readthedocs.io/en/latest/library.html),
`~/Workshops` unless you say otherwise, creating it the first time. The
library is one place for everything you have in the way of workshops:
the ones you install from published collections, kept by collection;
the ones you make for yourself; the courses you write to publish for
others; your subscriptions, which belong to the library rather than to
your JupyterLab settings; and a
[learning journal](https://jupyterlab-workshop.readthedocs.io/en/latest/library.html#your-learning-journal),
the record of what you install, start, finish and make, kept as files
you can open and read. To try it without installing anything:

```
uvx --from "jupyterlab-workshop[lab]" jupyter-workshop library
```

If you use Claude, add the `ai` extra, here in the form that runs
straight away without installing, or to the tool install above:

```
uvx --from "jupyterlab-workshop[lab,ai]" jupyter-workshop library
```

With it a library offers two AI agents inside JupyterLab, working under
the Claude Code login on your machine or an `ANTHROPIC_API_KEY`.
[Workshop Author](https://jupyterlab-workshop.readthedocs.io/en/latest/authoring.html#workshop-author)
writes workshops for you to learn from and designs courses with you.
[The mentor](https://jupyterlab-workshop.readthedocs.io/en/latest/library.html#the-mentor)
learns who you are as a learner in a few questions, keeps a profile in
your journal that Workshop Author then writes for, reads the journal to
see how you have been getting on, and can have a workshop made for you.
Nothing in the journal leaves your machine unless you talk to an agent.

The package is also a prebuilt JupyterLab 4 extension with its server
extension, so in a project of your own it installs alongside JupyterLab:

```
uv add jupyterlab jupyterlab-workshop
```

or the pip equivalent, and the commands above run as `jupyter workshop`.
[Getting started](https://jupyterlab-workshop.readthedocs.io/en/latest/getting-started.html)
walks through the setup, runs an example workshop and scaffolds one of
your own; the `jupyter workshop` command lints, self-tests and publishes
workshops, and author mode in JupyterLab edits them in place.

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
  for Binder, containers, JupyterHub and locked-down images.

- [The documentation](https://jupyterlab-workshop.readthedocs.io/) for
  the rest: every action a page can use, checks and forms, variables,
  layouts, platforms, JupyterLite, publishing, trust, the manifest and
  settings references, the command line and authoring in JupyterLab.

- [Source, issues and contributing](https://github.com/GrahamDumpleton/jupyterlab-workshop):
  see `CONTRIBUTING.md` in the repository for the development setup.

## Developed with AI

This package was developed with the help of AI coding assistants,
working to the author's design and direction, with the author
reviewing what they produce. If you would rather not use software
produced that way, that is understood, and this package is not for
you.

## License

Apache License 2.0.
