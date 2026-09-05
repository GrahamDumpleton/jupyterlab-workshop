---
title: Files and the editor
---

# Files and the editor

Files shipped with the workshop can be written into place. This one is a
template: the greeting uses your name.

```{file-write}
:path: scratch/notes.md
:from: files/notes.md
:open: true
```

Text in an open file can be replaced, selected and highlighted.

```{editor-replace}
:path: scratch/notes.md
:match: shipped with the workshop
was shipped with this workshop
```

```{editor-select}
:path: scratch/notes.md
:match: file-write
```

```{editor-highlight}
:path: scratch/notes.md
:line: 1
:duration: 3s
```

The file browser can be pointed at a directory, and files offered for
download.

```{file-browser-reveal}
:path: scratch
```

```{download}
:path: scratch/notes.md
```

A terminal is never far away.

```{execute}
:session: shell
ls -la scratch
:windows:
Get-ChildItem scratch
```
