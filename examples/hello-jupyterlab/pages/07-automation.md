---
title: Automation
---

# Automation

Actions can run on their own. The first block below runs when the page
opens, then cascades to the next with a short pause so you can follow.

```{toast}
:id: auto-start
:auto: page-enter
:cascade: true
This message appeared on its own.
```

```{execute}
:id: auto-echo
:session: shell
:cascade: true
:delay: 2s
echo "Cascaded into the terminal"
```

```{file-write}
:id: auto-write
:path: scratch/automation.txt
:open: true
Written by a cascade.
```

Some blocks wait for another to finish instead.

```{highlight}
:auto: after:auto-write
:selector: .jp-FileEditor
:duration: 3s
The cascade wrote and opened this file.
```

Use the stop icon in the panel header to interrupt a running chain.
The terminal has done its work for now, so the last action closes it;
a later `execute` opens it again.

```{terminal-close}
:session: shell
```
