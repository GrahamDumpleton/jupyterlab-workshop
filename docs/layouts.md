# Layouts

A workshop can say how the JupyterLab window should look: which side the
instructions sit on and how wide they are, whether the file browser is
out of the way, and what the main area holds, such as a terminal below a
rendered README. The main area is described by a named layout declared
in `workshop.yaml`, applied by the `layout` field when the workshop
opens, by the `layout` directive from a page, and by the "Workshop:
Reset Layout" command. This page describes the format, what applying a
layout does, and where the things actions open end up.

## Declaring a layout

```yaml
instructions: { side: right, width: 0.25 }
layout: default
layouts:
  default:
    main:
      areas:
        - { tabs: ['markdown:../README.md'] }
        - { size: 0.4, tabs: ['terminal:git'] }
```

The `layout` field names the layout applied when the workshop opens. The
`layouts` mapping declares layouts by name; a page can switch between
them with the `layout` directive. Two layouts are built in and need no
declaration:

- `default` opens a terminal named `workshop` below whatever is open,
  taking two fifths of the height.

- `terminal-only` opens that terminal filling the main area.

A manifest with no `layout` field leaves the main area alone.

Both built-in layouts open a terminal, so they suit a workshop that
uses one and no other. A notebook workshop names neither: it declares a
layout of its own or has no `layout` field. The linter reports
`layout-terminal` when a layout the workshop applies opens a terminal
and the manifest does not declare the `terminal` capability, since no
page could then use it. `jupyter workshop init` writes `layout: default`
only for a workshop with that capability.

## The main area

`main` is a tree. Each area is either a set of `tabs` or a `split` into
child `areas`, and rows are the direction unless said otherwise:

```yaml
main:
  areas:
    - { tabs: ['file:frontend.py'] }
    - size: 0.4
      split: columns
      areas:
        - { tabs: ['terminal:shell'] }
        - { tabs: ['terminal:client'] }
```

That is two rows, a file above a pair of terminals side by side. A
full-height column is the other nesting:

```yaml
main:
  split: columns
  areas:
    - areas:
        - { tabs: ['file:frontend.py'] }
        - { tabs: ['terminal:shell'] }
    - { size: 0.3, tabs: ['terminal:client'] }
```

The rules:

- An area has `tabs` or `areas`, never both and never neither. The
  linter reports `layout-area` otherwise.

- `size` is the fraction of the parent split the area takes, between 0
  and 1. Siblings without a `size` share the remainder equally.

- The first entry of a `tabs` list is the active tab.

- An empty `tabs` list is the placeholder: whatever is open that the
  layout does not name goes there. The built-in `default` is a
  placeholder above a terminal, which is how "a terminal below whatever
  is open" is written. A placeholder with nothing to hold is dropped and
  its siblings fill the space. A layout has at most one.

- `name` labels an area so an action can open into it; see
  [where actions open things](#where-actions-open-things). Names are
  unique within a layout and may be reused across layouts.

Widgets are named by kind and target:

| Reference         | Opens                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal:<name>` | A workshop terminal with that name, created if needed.                                                                                                  |
| `file:<path>`     | The file in the editor. Paths follow the [rule for actions](platforms.md#paths): relative to the workspace, so a shipped `README.md` is `../README.md`. |
| `markdown:<path>` | The Markdown file rendered as a preview rather than as source.                                                                                          |
| `notebook:<path>` | The notebook.                                                                                                                                           |
| `launcher`        | A new launcher.                                                                                                                                         |

Terminals named in a layout are the same terminals that `execute` and
other terminal actions use, so a layout that opens `terminal:git` and
actions with `:terminal: git` share one shell.

Layouts are part of the manifest and are not
[substituted](variables.md): a reference written as
`notebook:{{ notebook }}` looks for a file of exactly that name and
finds none. Write the path out, even when a variable holds the same
path for the pages.

## What applying a layout does

A layout describes a result, not a sequence of steps. Applying one opens
what it names, gathers everything else that is open into the
placeholder, and arranges the main area to match, whatever it looked
like before. So applying the same layout twice gives the same window,
and a page can switch layouts knowing what the learner will see.

A layout never closes anything. A terminal it does not name keeps its
shell, its environment and its scrollback; a notebook keeps its kernel
and its outputs; an editor keeps unsaved text. They are out of view as
tabs behind what the layout named, which JupyterLab keeps fully alive,
and a click on the tab brings one back exactly as it was. The one
exception is the launcher JupyterLab shows for an empty session, which
holds nothing and is closed once the layout adds its widgets. So when a
page says a layout "replaces" a file with a preview, the file is still
there as a tab beside it. Removing something is an explicit act:
`file-close`, `terminal-close`, or the learner closing the tab.

Closing a tab is different from hiding one, and only for the widget
itself. Closing a notebook tab leaves its kernel running, and reopening
the notebook reconnects to it. Closing a terminal tab leaves the shell
session running unless the terminal extension's `shutdownOnClose`
setting is on, and reopening it from the Running panel reconnects with
the working directory and environment intact; only the scrollback,
which lived in the browser, is gone. A page reload behaves the same way
for both.

A widget the layout names but cannot open, a file that does not exist
yet or a path with a typo, is left out. The rest of the layout is still
arranged, and the action reports an error naming what was missing, so
running it again once the file exists completes the arrangement. The
self-test fails such a step.

The layout the manifest opens with is applied before any page has run,
so it has no action to report through, and a file it names that a page
only creates later is always missing the first time. The learner is
shown nothing; the self-test notes it, as a skipped `(workshop)/layout`
line naming what was left out, which is where a typo in the opening
layout shows up. To open a workshop on a notebook its first page
creates, have the action do it rather than the layout: a
`notebook-create` with `:auto: page-enter` and `:existing: keep` shows
the notebook as the workshop opens and leaves it alone when the learner
comes back to the page.

When the main area holds nothing but the launcher JupyterLab shows for
an empty session, the launcher is closed once the layout adds its
widgets, so a rendered README or a notebook takes its place rather than
sitting beside it.

## Sidebars

JupyterLab has two sidebars. The instructions panel lives in one of
them, and the top-level `instructions` field says which and how wide:

```yaml
instructions:
  side: right
  width: 0.3
```

`side` is the same for the whole workshop, since the panel is what the
learner reads while the window changes around it. Left out, the
`panelSide` setting decides, and dragging the panel to the other side
is remembered by JupyterLab. `width` is a fraction of the window and is
the default for every layout; a layout may override it for its own
step, when a wide preview or a pair of terminals needs the room:

```yaml
layouts:
  diagram:
    instructions: { width: 0.2 }
```

Applying any layout, Reset Layout included, puts the panel back on the
declared side at the declared width, so a layout is also how a page
puts back a panel the learner moved or resized. When the panel's
sidebar has no width at all when a workshop opens, as after a session
that started in the workshop browser with both sidebars collapsed, the
panel takes a quarter of the window unless a width is given. If the two
sidebars together would take more than four fifths of the width, both
are scaled down so the main area keeps some room.

The other sidebar, usually the file browser's, is collapsed when a
workshop opens, since a workshop with no up-front need for the file
browser is better off with the space. A workshop that wants it from the
start says so at the top level, and a layout may say otherwise for its
own step:

```yaml
sidebar: filebrowser
layouts:
  focus:
    sidebar: hidden
```

`sidebar` is `hidden`, or the id of a sidebar widget to bring forward,
such as `filebrowser`, `running-sessions`, `jp-property-inspector` or
`debugger-sidebar`. A widget that sits in the same sidebar as the
instructions is moved to the other one first, so the two never cover
each other; `panel-open` and `file-browser-reveal` do the same. A layout
that says nothing about `sidebar` leaves that sidebar as it is.

## Where actions open things

Actions that open something, `file-open`, `file-write` with `open`,
`notebook-open`, `notebook-create` with `open`, `terminal-open`,
`console-open`, `launcher-open` and `url-open`, take an `area` option
saying where it goes. Its value is the `name` of an area declared in a layout:

```yaml
layouts:
  default:
    main:
      areas:
        - { name: code, tabs: ['file:main.py'] }
        - { name: shells, size: 0.4, tabs: ['terminal:shell'] }
```

````markdown
```{file-open}
:path: test_shop.py
:area: code
```
````

If anything in that area is still open, the widget joins it as a tab and
is brought forward. If the learner closed everything in it, the layout
is applied again with the widget in that area, which is safe because
applying keeps everything else where it was. A widget that is already
open is moved into the area, so a page can pull the terminal up beside a
file for one step without declaring a layout for it.

Three keywords place relative to the current widget instead: `tab` puts
the widget beside it, `right` and `bottom` split it off to that side.

Without `area`, a document goes beside the first document the layout
holds, or into the placeholder when there is none, and a terminal goes
beside the first terminal. A workshop with no layout gets JupyterLab's
own placement, with the first terminal below the main area.

The linter reports `unknown-layout-area` for an `area` value that is
neither a keyword nor a name some layout declares.

## When a layout is applied

The layout named by the `layout` field is applied the first time a
workshop is opened in a JupyterLab workspace, every time it is opened
from a [launch link](collections.md), including from Binder or the
`jupyter workshop test` command, and again after the layout, the
`instructions` field or the `sidebar` field changes. After that,
JupyterLab restores whatever arrangement the learner left, so reloading
the page or reopening the workshop from the browser keeps their
sidebars and panes as they were and only brings the instructions panel
forward, at the width the manifest asks for if its sidebar had none.

A workshop that opens with no recorded progress counts as opened for
the first time, so the layout is applied again after
[Restart or Reset Progress](using.md#starting-over-and-clearing-up), and
after its `_workshop` directory is deleted by hand or by a clean-up
script. Removing a workshop forgets that its layout was applied.

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
