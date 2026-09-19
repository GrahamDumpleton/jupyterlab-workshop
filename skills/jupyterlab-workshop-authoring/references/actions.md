# Action reference

Generated from the action catalogue in `packages/core`. Every directive also
accepts the common options `id`, `title`, `auto`, `cascade`, `delay`, `scroll`, `when`, `substitute`, `on-error`,
described in [Pages and actions](pages.md#common-options), which also covers
the page syntax, inline roles, conditions and how the editor actions point at
text. Paths in options are relative to the learner's workspace, except `from`,
which names a shipped file and is relative to the workshop directory; see
[paths](platforms.md#paths). The `area` option of the actions that open
something names the layout area it goes in; see
[where actions open things](layouts.md#where-actions-open-things).

## Terminal

| Directive         | Capability  | Body     | Options                             | Description                                                             |
| ----------------- | ----------- | -------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `execute`         | terminal    | required | `session`, `cwd`, `wait`, `timeout` | Run a command in a named terminal.                                      |
| `execute-capture` | kernel-exec | required | `capture`, `cwd`, `timeout`         | Run a command in the background and capture its output into a variable. |
| `terminal-open`   | terminal    | none     | `session`, `cwd`, `area`            | Open or reveal a named terminal, optionally in a layout area.           |
| `terminal-clear`  | terminal    | none     | `session`                           | Clear a named terminal.                                                 |
| `terminal-close`  | terminal    | none     | `session`                           | Close a named terminal and end its session.                             |
| `terminal-type`   | terminal    | required | `session`                           | Type text into a terminal without pressing Enter.                       |
| `send-key`        | terminal    | none     | `session`, `keys`                   | Send key strokes to a terminal.                                         |
| `interrupt`       | terminal    | none     | `session`                           | Interrupt the command running in a terminal.                            |

## Files and editor

| Directive             | Capability  | Body     | Options                                                             | Description                                                                              |
| --------------------- | ----------- | -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `file-write`          | write-files | optional | `path`, `open`, `mode`, `from`, `area`                              | Write the body, or a file shipped with the workshop, to a file.                          |
| `file-open`           | none        | none     | `path`, `line`, `area`                                              | Open a file in the editor, optionally at a line.                                         |
| `file-close`          | none        | none     | `path`                                                              | Close every editor and preview showing a file.                                           |
| `file-delete`         | write-files | none     | `path`, `recursive`, `missing`                                      | Delete a file, or a directory and its contents, closing its tabs.                        |
| `file-rename`         | write-files | none     | `path`, `to`                                                        | Rename or move a file or directory, following it in open tabs.                           |
| `file-copy`           | write-files | none     | `path`, `to`                                                        | Copy a file to a new path.                                                               |
| `directory-create`    | write-files | none     | `path`                                                              | Create a directory and any missing parents.                                              |
| `editor-insert`       | write-files | required | `path`, `line`, `match`, `regex`, `occurrence`, `position`, `save`  | Insert the body into a file before a line or a match, or at the end.                     |
| `editor-replace`      | write-files | optional | `path`, `line`, `match`, `regex`, `occurrence`, `expand`, `save`    | Replace the first match of a pattern, chosen matches, or a range of lines with the body. |
| `editor-select`       | none        | none     | `path`, `line`, `match`, `regex`, `occurrence`, `group`             | Select matching text or a range of lines in a file.                                      |
| `editor-highlight`    | none        | none     | `path`, `line`, `match`, `regex`, `occurrence`, `group`, `duration` | Briefly highlight matching text or a range of lines in a file.                           |
| `file-browser-reveal` | none        | none     | `path`                                                              | Show a path in the file browser.                                                         |
| `download`            | none        | none     | `path`                                                              | Download a file to the learner’s machine.                                                |
| `upload-prompt`       | none        | none     | `path`                                                              | Ask the learner to upload files.                                                         |

`file-write` writes its body line for line with one newline at the
end; a blank line straight after the options is dropped as the
separator, and other blank lines are kept, so an appended Python
definition that must sit two blank lines below the last one starts its
body with three (see [directives](pages.md#directives)). With `open` it
shows the file in the editor with the cursor
at the start of what it wrote: the top of the file, or with `mode:
append` the first appended line, so a long file opens where the change
is. An editor already showing the file is moved there whether or not
`open` is set, since its cursor may have been in text the write
replaced. `editor-insert` leaves the cursor on the first inserted line,
and `editor-replace` selects the new text. New text is scrolled to the
top of the view so it reads downward from there; the text `file-open`
with `line`, `editor-select` and `editor-highlight` point at is
centred, so it has context on both sides. Either way a position that is
already in view is left where it is, and the ends of the file limit
the scroll, so a match near the top sits as far down as the lines
before it allow.

`file-delete` refuses the workshop directory and its `_workshop` state
directory however the path is spelt, and refuses a directory unless
`recursive` is set; a path that does not exist is nothing to do unless
`missing` is `error`. `file-rename` and `file-copy` create the
destination's directory when it is missing and refuse a destination
that exists, so neither replaces the learner's work; `file-rename` also
moves, since `to` is a full path. All four go through the contents API,
so they behave the same on every platform, including JupyterLite, and
the paths stay inside the workspace like any write.

## Notebooks and kernels

| Directive          | Capability  | Body     | Options                                      | Description                                                                                              |
| ------------------ | ----------- | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `notebook-open`    | none        | none     | `path`, `cell`, `area`                       | Open a notebook, optionally at a cell.                                                                   |
| `notebook-create`  | write-files | yaml     | `path`, `kernel`, `existing`, `open`, `area` | Create a notebook with the cells listed in the body, replacing one already there unless told to keep it. |
| `cell-insert`      | write-files | required | `path`, `at`, `kind`, `tags`, `run`          | Insert a cell into a notebook.                                                                           |
| `cell-run`         | kernel-exec | none     | `path`, `cell`                               | Run a cell of a notebook.                                                                                |
| `cell-run-all`     | kernel-exec | none     | `path`                                       | Run every cell of a notebook.                                                                            |
| `cell-run-to`      | kernel-exec | none     | `path`, `cell`                               | Run every cell up to and including one.                                                                  |
| `cell-select`      | none        | none     | `path`, `cell`                               | Make a cell the active cell.                                                                             |
| `cell-highlight`   | none        | none     | `path`, `cell`, `duration`                   | Briefly highlight a cell.                                                                                |
| `kernel-restart`   | kernel-exec | none     | `path`                                       | Restart the kernel of a notebook.                                                                        |
| `kernel-interrupt` | none        | none     | `path`                                       | Interrupt the kernel of a notebook.                                                                      |
| `kernel-select`    | none        | none     | `path`, `kernel`                             | Change the kernel of a notebook.                                                                         |
| `kernel-execute`   | kernel-exec | required | `path`, `kernel`, `silent`, `capture`        | Run code in a kernel, optionally capturing the output into a variable.                                   |
| `console-open`     | none        | none     | `path`, `area`                               | Open a console attached to a notebook.                                                                   |
| `output-clear`     | none        | none     | `path`                                       | Clear the outputs of a notebook.                                                                         |

`notebook-create` writes the notebook afresh each time it runs: a
notebook already at the path is closed and replaced with the cells in
the body, which is what a learner asking for a clean start wants from a
click. With `existing: keep` a notebook already there is opened as it
is and nothing is written. Use that on any `notebook-create` that runs
on its own, such as one with `auto: page-enter` that makes a workshop
open with its notebook showing: the page is entered again whenever the
learner comes back to it, and replacing would discard every cell they
had added and run since. The linter reports `notebook-overwrite` for an
automatic `notebook-create` without it.

`cell-insert` with `run` reports an error when the kernel never ran the
cell, since what the cell defines is then missing for the steps after
it. A cell that ran and raised still counts as run: showing an error
can be the point of the cell.

## Interface and layout

| Directive       | Capability  | Body     | Options         | Description                                                      |
| --------------- | ----------- | -------- | --------------- | ---------------------------------------------------------------- |
| `command`       | none        | optional | `command`       | Run a JupyterLab command, with JSON arguments in the body.       |
| `layout`        | none        | none     | `name`          | Arrange the JupyterLab panels using a named layout.              |
| `panel-open`    | none        | none     | `id`            | Show a JupyterLab panel or widget by id.                         |
| `panel-close`   | none        | none     | `id`, `side`    | Collapse a sidebar, by default the one beside the instructions.  |
| `focus`         | none        | none     | `id`            | Give a widget focus.                                             |
| `settings-set`  | ui-settings | required | `plugin`, `key` | Change a setting of the editor, with the JSON value in the body. |
| `launcher-open` | none        | none     | `area`          | Open the launcher, or show the open one.                         |

## Guidance

| Directive   | Capability | Body     | Options                       | Description                                         |
| ----------- | ---------- | -------- | ----------------------------- | --------------------------------------------------- |
| `highlight` | none       | optional | `selector`, `duration`        | Draw attention to part of the interface.            |
| `tour`      | none       | yaml     | (none)                        | Walk through interface elements listed in the body. |
| `toast`     | none       | required | `type`, `duration`            | Show a notification message.                        |
| `tooltip`   | none       | required | `selector`                    | Pin a note to an element until dismissed.           |
| `dialog`    | none       | required | `title`, `buttons`, `capture` | Ask a question and store the answer in a variable.  |
| `hint`      | none       | markdown | `title`, `open`               | Collapsible help text.                              |

## Flow and variables

| Directive   | Capability | Body     | Options                                 | Description                                                |
| ----------- | ---------- | -------- | --------------------------------------- | ---------------------------------------------------------- |
| `choice`    | none       | optional | `variable`, `options`, `track`, `label` | Let the learner pick a value, optionally choosing a track. |
| `env-set`   | none       | required | `name`, `value`                         | Set a variable, with the value in the body.                |
| `next-page` | none       | none     | (none)                                  | Go to the next page.                                       |

## Checks, forms and checkpoints

| Directive    | Capability  | Body     | Options                                                      | Description                                                                   |
| ------------ | ----------- | -------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `verify`     | none        | optional | `label`, `trigger`, `substrate`, `script`, `path`, `timeout` | Check learner progress with code, a script, or file and interface predicates. |
| `quiz`       | none        | yaml     | `type`, `shuffle`, `attempts`                                | Ask a multiple choice question with the options in the body.                  |
| `form`       | none        | yaml     | `label`                                                      | Collect variable values from the learner with the fields in the body.         |
| `checkpoint` | none        | none     | `name`                                                       | Snapshot the workshop files and variables under a name.                       |
| `restore`    | write-files | none     | `name`                                                       | Restore the workshop files and variables from a checkpoint.                   |

## External

| Directive            | Capability       | Body     | Options | Description                                                                                                                                                                                            |
| -------------------- | ---------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `copy`               | none             | required | (none)  | Copy the body to the clipboard.                                                                                                                                                                        |
| `environment-create` | install-packages | none     | `force` | Create the isolated environment declared in the manifest and register its kernel; a no-op once it exists unless `:force: true`. JupyterLab only: the linter warns when a manifest lists `jupyterlite`. |

## Inline roles

| Role          | Description                                  |
| ------------- | -------------------------------------------- |
| `{copy}`      | Copy the text to the clipboard.              |
| `{open}`      | Open the named file in the editor.           |
| `{highlight}` | Highlight the element matching the selector. |
| `{var}`       | Show the value of a variable.                |

## Structure

The `{when}` directive takes a condition as its argument and shows its body only
when the condition holds, for example ` ```{when} track == "pip" `.
Conditions use `==`, `!=`, `in`, `not in`, `and`, `or`, `not` and parentheses
over variables, quoted strings and `[lists]`.

The `verify`, `quiz`, `form`, `checkpoint` and `restore` directives are described
in [checks.md](checks.md).
