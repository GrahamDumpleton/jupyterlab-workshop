---
title: Test and publish
requires: [verify:published, quiz:final-quiz]
---

# Test and publish

Lint checks the files; the self-test checks that the workshop works.
`jupyter workshop test` starts a JupyterLab of its own, opens the
workshop trusted, runs every action, check, quiz and form in order, and
prints PASS or FAIL for each. It is what a workshop's CI runs.

```{hint}
:title: Running the self-test
The self-test needs the `test` extra, which installs Playwright, and a
browser for it: `uv add "jupyterlab-workshop[test]"` (or `pip install`
the same) and then `playwright install chromium`.
Then run `jupyter workshop test {{ workshop_dir }}`. It starts a second
JupyterLab, so it is not run from inside this one.
```

Publishing builds an archive of the workshop, records its SHA-256 and
writes a registry entry that a workshop browser can list.

```{execute}
:id: publish
:session: author
jupyter workshop publish {{ workshop_dir }} --out {{ workshop_dir }}/dist
```

```{verify}
:id: published
:label: The archive has been built
:substrate: contents
:trigger: after:publish
exists {{ workshop_dir }}/dist/my-workshop-0.1.0.tar.gz
exists {{ workshop_dir }}/dist/my-workshop-0.1.0.registry.json
```

## Editing inside JupyterLab

Everything above was done from the terminal. The panel can do the same:
"Workshop: Author Mode" in the command palette adds a toolbar with
buttons to edit the page source, add and reorder pages, insert an action
from a form, capture what you just ran into the page, run the page's
actions and checks, show lint findings with one-click fixes, preview the
trust dialog and publish. Saving a page re-renders the panel. The Record
button turns a session into draft pages, one action per step.

AI agents can write workshops too: `jupyter workshop mcp` serves the
same tools over MCP, and the `workshop-author` skill that ships with the
extension explains the format to them.

```{quiz}
:id: final-quiz
:title: One last question
question: Which command runs every action of a workshop in a real JupyterLab?
options:
  - { text: jupyter workshop test, correct: true }
  - text: jupyter workshop lint
    explanation: Lint reads the files; it never runs anything.
  - text: jupyter workshop publish
    explanation: Publish builds the archive.
explanation: The self-test drives a headless JupyterLab through the workshop.
```
