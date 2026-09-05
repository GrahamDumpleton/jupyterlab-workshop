---
title: Welcome
---

# Welcome

Hello {{ learner }}. This workshop is a tour of the actions a workshop can
use to drive JupyterLab. Each block below is clickable. Start with a
message.

```{toast}
:type: success
Welcome to the workshop, {{ learner }}.
```

Actions can point things out. This one outlines the file browser tab for
a few seconds.

```{highlight}
:selector: .jp-SideBar .lm-TabBar-tab[data-id="filebrowser"]
:duration: 4s
The file browser lives here.
```

They can switch panels. Open the file browser, then come back here.

```{panel-open}
:id: filebrowser
```

```{panel-open}
:id: jupyterlab-workshop-panel
```

A tour walks through several parts of the interface with a button to move
on.

```{tour}
- selector: "#jp-top-panel"
  text: The menu bar.
- selector: "#jp-main-dock-panel"
  text: Notebooks, editors and terminals open here.
- selector: "#jupyterlab-workshop-panel"
  text: The instructions you are reading.
```

Any JupyterLab command can be run too. This opens the launcher.

```{launcher-open}

```

```{hint}
:title: What is a command?
JupyterLab exposes everything it can do as commands, such as
`apputils:activate-command-palette`. The `command` action runs one by id.
```
