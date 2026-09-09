---
title: Files and the editor
---

# Files and the editor

Files shipped with the workshop can be written into place. This one is a
template kept outside the workspace: the greeting uses your name, so it
is filled in as it is written rather than copied in when the workshop
opens.

```{file-write}
:path: notes.md
:from: templates/notes.md
:substitute: true
:open: true
```

Text in an open file can be replaced, inserted, selected and highlighted.
An action points at text with literal `match` text, a regular expression,
or line numbers.

```{editor-replace}
:id: replace-literal
:path: notes.md
:match: shipped with the workshop
shipped with this workshop
```

```{editor-insert}
:id: insert-after-title
:path: notes.md
:regex: true
:match: ^# Notes
:position: after
Revised by an editor-insert action.
```

A regular expression can capture part of what it matches and reuse it in
the replacement.

```{editor-replace}
:id: replace-expand
:path: notes.md
:regex: true
:expand: true
:match: ^# Notes for (.*)$
# Revised notes for $1
```

```{editor-select}
:id: select-second
:path: notes.md
:match: action
:occurrence: 2
```

```{editor-highlight}
:id: highlight-lines
:path: notes.md
:line: 1-2
:duration: 3s
```

The file browser can be pointed at a directory, and files offered for
download.

```{file-browser-reveal}
:path: .
```

```{download}
:path: notes.md
```

A terminal is never far away.

```{execute}
:session: shell
ls -la
:windows:
Get-ChildItem
```

When a file is no longer needed on screen, an action can close its tabs,
whether the editor, a preview or both.

```{file-close}
:path: notes.md
```

Files can also be managed without a terminal, in the same way on every
platform: copied, renamed or moved, and deleted, with directories
created along the way. A copy or rename refuses to replace a file that
exists, and a delete refuses a directory unless told it is meant.

```{file-copy}
:id: copy-notes
:path: notes.md
:to: archive/notes-copy.md
```

```{file-rename}
:id: rename-notes
:path: archive/notes-copy.md
:to: archive/notes-old.md
```

```{directory-create}
:id: create-drafts
:path: drafts
```

```{file-delete}
:id: delete-archive
:path: archive
:recursive: true
```
