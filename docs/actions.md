# Action reference

Generated from the action catalogue in `packages/core`. Every directive also
accepts the common options `id`, `title`, `auto`, `cascade`, `delay`, `scroll`, `when`, `substitute`, `on-error`.

## Terminal

| Directive         | Capability  | Body     | Options                             | Description                                                             |
| ----------------- | ----------- | -------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `execute`         | terminal    | required | `session`, `cwd`, `wait`, `timeout` | Run a command in a named terminal.                                      |
| `execute-capture` | kernel-exec | required | `capture`, `cwd`, `timeout`         | Run a command in the background and capture its output into a variable. |
| `terminal-open`   | terminal    | none     | `session`, `cwd`, `area`            | Open or reveal a named terminal.                                        |
| `terminal-clear`  | terminal    | none     | `session`                           | Clear a named terminal.                                                 |
| `terminal-type`   | terminal    | required | `session`                           | Type text into a terminal without pressing Enter.                       |
| `send-key`        | terminal    | none     | `session`, `keys`                   | Send key strokes to a terminal.                                         |
| `interrupt`       | terminal    | none     | `session`                           | Interrupt the command running in a terminal.                            |

## Files and editor

| Directive             | Capability  | Body     | Options                                 | Description                                                     |
| --------------------- | ----------- | -------- | --------------------------------------- | --------------------------------------------------------------- |
| `file-write`          | write-files | optional | `path`, `open`, `mode`, `from`          | Write the body, or a file shipped with the workshop, to a file. |
| `file-open`           | none        | none     | `path`, `line`, `split`                 | Open a file in the editor, optionally at a line.                |
| `editor-insert`       | write-files | required | `path`, `line`, `save`                  | Insert the body into a file at a line, or at the end.           |
| `editor-replace`      | write-files | optional | `path`, `match`, `regex`, `all`, `save` | Replace text matching a pattern in a file with the body.        |
| `editor-select`       | none        | none     | `path`, `match`, `line`                 | Select text in a file.                                          |
| `editor-highlight`    | none        | none     | `path`, `match`, `line`, `duration`     | Briefly highlight text in a file.                               |
| `file-browser-reveal` | none        | none     | `path`                                  | Show a path in the file browser.                                |
| `download`            | none        | none     | `path`                                  | Download a file to the learner’s machine.                       |
| `upload-prompt`       | none        | none     | `path`                                  | Ask the learner to upload files.                                |

## Notebooks and kernels

| Directive          | Capability  | Body     | Options                               | Description                                                            |
| ------------------ | ----------- | -------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `notebook-open`    | none        | none     | `path`, `cell`, `split`               | Open a notebook, optionally at a cell.                                 |
| `notebook-create`  | write-files | yaml     | `path`, `kernel`, `open`              | Create a notebook with the cells listed in the body.                   |
| `cell-insert`      | write-files | required | `path`, `at`, `kind`, `tags`, `run`   | Insert a cell into a notebook.                                         |
| `cell-run`         | kernel-exec | none     | `path`, `cell`                        | Run a cell of a notebook.                                              |
| `cell-run-all`     | kernel-exec | none     | `path`                                | Run every cell of a notebook.                                          |
| `cell-run-to`      | kernel-exec | none     | `path`, `cell`                        | Run every cell up to and including one.                                |
| `cell-select`      | none        | none     | `path`, `cell`                        | Make a cell the active cell.                                           |
| `cell-highlight`   | none        | none     | `path`, `cell`, `duration`            | Briefly highlight a cell.                                              |
| `kernel-restart`   | kernel-exec | none     | `path`                                | Restart the kernel of a notebook.                                      |
| `kernel-interrupt` | none        | none     | `path`                                | Interrupt the kernel of a notebook.                                    |
| `kernel-select`    | none        | none     | `path`, `kernel`                      | Change the kernel of a notebook.                                       |
| `kernel-execute`   | kernel-exec | required | `path`, `kernel`, `silent`, `capture` | Run code in a kernel, optionally capturing the output into a variable. |
| `console-open`     | none        | none     | `path`                                | Open a console attached to a notebook.                                 |
| `output-clear`     | none        | none     | `path`                                | Clear the outputs of a notebook.                                       |

## Interface and layout

| Directive       | Capability  | Body     | Options         | Description                                                   |
| --------------- | ----------- | -------- | --------------- | ------------------------------------------------------------- |
| `command`       | none        | optional | `command`       | Run a JupyterLab command, with JSON arguments in the body.    |
| `layout`        | none        | none     | `name`          | Arrange the JupyterLab panels using a named layout.           |
| `panel-open`    | none        | none     | `id`            | Show a JupyterLab panel or widget by id.                      |
| `panel-close`   | none        | none     | `id`, `side`    | Hide a JupyterLab sidebar panel.                              |
| `focus`         | none        | none     | `id`            | Give a widget focus.                                          |
| `settings-set`  | ui-settings | required | `plugin`, `key` | Change a JupyterLab setting, with the JSON value in the body. |
| `launcher-open` | none        | none     | (none)          | Open the launcher.                                            |

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
| `mark-done` | none       | none     | (none)                                  | Mark the current page done.                                |
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

| Directive | Capability | Body     | Options | Description                     |
| --------- | ---------- | -------- | ------- | ------------------------------- |
| `copy`    | none       | required | (none)  | Copy the body to the clipboard. |

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
