# Layouts

A workshop can say how the JupyterLab window should be arranged when it
opens: which sidebars are shown or collapsed and how wide they are, and
what the main area holds, such as a terminal below a rendered README. The
arrangement is a named layout declared in `workshop.yaml`, applied by the
`layout` field when the workshop opens and by the `layout` directive from a
page. This page describes the layout format and when layouts are applied.

## Declaring a layout

```yaml
layout: default
layouts:
  default:
    left: collapsed
    right: { widget: instructions, size: 0.2 }
    main:
      - { area: top, widgets: ['markdown:README.md'] }
      - { area: bottom, widgets: ['terminal:git'], size: 0.4 }
```

The `layout` field names the layout applied when the workshop opens. The
`layouts` mapping declares layouts by name; a page can switch between them
with the `layout` directive. Three layouts are built in and need no
declaration:

- `default` opens a terminal named `workshop` below the main area.

- `terminal-only` opens that terminal filling the main area.

- `notebook` leaves the main area as it is.

## Sidebars

The `left` and `right` fields say what happens to each sidebar. Each is
either a word or a mapping:

- `instructions` shows the workshop instructions panel on that side,
  moving it there if it sits on the other side.

- `collapsed` collapses the sidebar so only its activity bar shows.

- Any other word is the id of a sidebar widget to bring forward, such as
  `filebrowser`, `running-sessions`, `jp-property-inspector` or
  `debugger-sidebar`.

- A mapping combines `widget` (one of the above), `collapsed` (true or
  false) and `size`, the fraction of the window width the sidebar takes,
  between 0 and 1. A sidebar without a `size` keeps its width.

The instructions panel is always brought forward when a layout finishes,
so collapsing the side it sits on has no lasting effect; collapse the
other side instead. When its sidebar has no width at that point, as
after a session that started in the workshop browser with both sidebars
collapsed, the panel takes a quarter of the window unless the layout
gives its side a `size`. If both sidebars ask for a size and together they
would take more than four fifths of the width, both are scaled down so the
main area keeps some room.

## Main area

The `main` list splits the main area into regions, in order. Each entry
names an `area` (`top`, `bottom`, `left` or `right`), the `widgets` to
open there and, optionally, a `size`. The first region splits off the
whole main area; each later region splits off the previous one. The first
widget of a region is placed by the split and the rest become tabs beside
it. The `size` is the fraction of the main area the region takes, between
0 and 1; without it JupyterLab shares the space evenly.

Widgets are named by kind and target:

| Reference         | Opens                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal:<name>` | A workshop terminal with that name, created if needed.                                                                                                  |
| `file:<path>`     | The file in the editor. Paths follow the [rule for actions](platforms.md#paths): relative to the workspace, so a shipped `README.md` is `../README.md`. |
| `markdown:<path>` | The Markdown file rendered as a preview rather than as source.                                                                                          |
| `notebook:<path>` | The notebook.                                                                                                                                           |
| `launcher`        | A new launcher.                                                                                                                                         |
| `editor`          | Whatever widget is current, used to anchor other regions.                                                                                               |

Terminals named in a layout are the same terminals that `execute` and
other terminal actions use, so a layout that opens `terminal:git` and
actions with `:terminal: git` share one shell.

When the main area holds nothing but the launcher JupyterLab shows for an
empty session, the launcher is closed once the layout adds its widgets, so
a rendered README or a notebook takes its place rather than sitting beside
it.

## When a layout is applied

The layout named by the `layout` field is applied the first time a
workshop is opened in a JupyterLab workspace, and every time it is opened
from a [launch link](collections.md), including from Binder or the
`jupyter workshop test` command. After that, JupyterLab restores whatever
arrangement the learner left, so reloading the page or reopening the
workshop from the browser keeps their sidebars and panes as they were and
only brings the instructions panel forward.

A learner can put things back with the "Workshop: Reset Layout" command
in the command palette, and a page can apply any declared layout with the
`layout` directive:

````markdown
```{layout}
:name: terminal-only
```
````

The linter reports a `layout` field or directive that names a layout that
is neither declared nor built in, and widget references of an unknown kind
or without the path they need.
