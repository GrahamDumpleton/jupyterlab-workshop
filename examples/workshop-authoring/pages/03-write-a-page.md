---
title: Write a page
requires: [verify:page-listed]
---

# Write a page

A page is Markdown with front matter. Write a third page for the new
workshop: it asks the learner to create a file and checks that they did.
The action below writes the file and opens it.

````{file-write}
:id: write-page
:path: {{ workshop_dir }}/pages/03-hello.md
:open: true
---
title: Say hello
requires: [verify:hello-file]
---

# Say hello

Create a file with a greeting in it.

```{execute}
:id: hello
echo hello > hello.txt
```

```{verify}
:id: hello-file
:label: The greeting file exists
:substrate: contents
:trigger: after:hello
exists hello.txt
```
````

The outer block uses four backticks because the page it writes contains
three-backtick blocks of its own. Three things to notice in that page:

- The `requires` line in the front matter names the check, so the page
  is not done until the check passes.

- The `execute` block has an `:id:` so the check can be triggered by it
  with `:trigger: after:hello`.

- The `contents` substrate needs no code: `exists hello.txt` is checked
  through the file system.

A page only counts once the manifest lists it. Append it to the `pages`
list at the end of `workshop.yaml`; the action inserts the line and
saves the file.

```{editor-insert}
:id: add-page
:path: {{ workshop_dir }}/workshop.yaml
:save: true
  - pages/03-hello.md
```

The check reads the manifest back. It runs after the action and again
whenever the manifest is saved, so you can also edit the file by hand.

```{verify}
:id: page-listed
:label: The manifest lists the new page
:trigger: after:add-page; file-saved {{ workshop_dir }}/workshop.yaml
import pathlib
import yaml

data = yaml.safe_load(pathlib.Path("{{ workshop_dir }}/workshop.yaml").read_text())
assert "pages/03-hello.md" in data["pages"], "Add pages/03-hello.md to the pages list in workshop.yaml"
```

List the pages the tool sees.

```{execute}
:session: author
jupyter workshop pages {{ workshop_dir }}
```
