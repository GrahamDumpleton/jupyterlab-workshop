---
title: Scaffold a workshop
requires: [verify:scaffolded, verify:manifest-open]
---

# Scaffold a workshop

`jupyter workshop init` writes a starting manifest, two pages, a README
and a `.gitignore`. The directory name becomes the workshop name, and
the title is given on the command line. The directory here comes from
the `workshop_dir` variable of this workshop, so the commands below use
`{{ workshop_dir }}`.

```{execute}
:id: init
:session: author
jupyter workshop init {{ workshop_dir }} --title "My first workshop"
```

The check below passes once the manifest and the first page exist. It
runs by itself after the command.

```{verify}
:id: scaffolded
:label: The workshop has been scaffolded
:substrate: contents
:trigger: after:init
exists {{ workshop_dir }}/workshop.yaml
exists {{ workshop_dir }}/pages/01-welcome.md
```

```{hint}
:title: If init refuses to run
It never overwrites files. Delete the `{{ workshop_dir }}` directory and
run the command again, or choose another directory from the variables
panel (the gear icon above).
```

Open the manifest to see what was written. The `capabilities` list is
what a learner is asked to trust; `variables` declares values the pages
substitute; `pages` lists the pages in order.

```{file-open}
:id: open-manifest
:path: {{ workshop_dir }}/workshop.yaml
```

```{verify}
:id: manifest-open
:label: The manifest is open in the editor
:substrate: ui
:trigger: after:open-manifest
file-open {{ workshop_dir }}/workshop.yaml
```

Then look at the first page, `pages/01-welcome.md`. Its actions are
plain fenced blocks; the `verify` at the end checks the working directory
exists and is triggered by the action before it.

```{file-open}
:path: {{ workshop_dir }}/pages/01-welcome.md
```
