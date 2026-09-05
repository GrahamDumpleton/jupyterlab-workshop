---
title: What a workshop is
requires: [quiz:parts-quiz]
---

# What a workshop is

You are reading a workshop right now: instructions in a side panel, with
actions that drive the JupyterLab session next to it. This workshop shows
how to write one of your own with the `jupyter workshop` command, and it
is itself a workshop, so everything it describes is happening around you.

A workshop is a directory holding two kinds of file:

- `workshop.yaml`, the manifest: the name and title, what the pages are
  allowed to do (the capabilities), the variables, and the list of pages.

- `pages/*.md`, one Markdown page per step. Fenced blocks named in braces,
  such as ` ```{execute} `, are the actions.

The command line tool comes with the extension. Check it is installed;
the terminal below opens when you click.

```{execute}
:session: author
jupyter workshop --version
```

```{hint}
:title: If the command is not found
The tool is installed with the `jupyterlab-workshop` package.
Install it into the same environment JupyterLab runs from, then restart
the terminal.
```

Pages can end with a question. This workshop uses strict gating, so the
Next button waits until the question is answered correctly.

```{quiz}
:id: parts-quiz
:title: The parts of a workshop
:type: multi
question: Which files make up a workshop? Pick every one that applies.
options:
  - { text: A workshop.yaml manifest, correct: true }
  - { text: Markdown pages under pages/, correct: true }
  - text: A Dockerfile
    explanation: Workshops run wherever JupyterLab runs; no container is involved.
  - text: A Kubernetes manifest
    explanation: The Educates platform needs one; this format does not.
explanation: A manifest plus Markdown pages is the whole format.
```
