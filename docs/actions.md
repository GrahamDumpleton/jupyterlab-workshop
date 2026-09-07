# Action reference

Generated from the action catalogue in `packages/core`. Every directive also
accepts the common options `id`, `title`, `auto`, `cascade`, `delay`, `scroll`, `when`, `substitute`, `on-error`,
described under [Common options](#common-options).

## Terminal

| Directive         | Capability  | Body     | Options                             | Description                                                             |
| ----------------- | ----------- | -------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `execute`         | terminal    | required | `session`, `cwd`, `wait`, `timeout` | Run a command in a named terminal.                                      |
| `execute-capture` | kernel-exec | required | `capture`, `cwd`, `timeout`         | Run a command in the background and capture its output into a variable. |
| `terminal-open`   | terminal    | none     | `session`, `cwd`, `area`            | Open or reveal a named terminal.                                        |
| `terminal-clear`  | terminal    | none     | `session`                           | Clear a named terminal.                                                 |
| `terminal-close`  | terminal    | none     | `session`                           | Close a named terminal and end its session.                             |
| `terminal-type`   | terminal    | required | `session`                           | Type text into a terminal without pressing Enter.                       |
| `send-key`        | terminal    | none     | `session`, `keys`                   | Send key strokes to a terminal.                                         |
| `interrupt`       | terminal    | none     | `session`                           | Interrupt the command running in a terminal.                            |

## Files and editor

| Directive             | Capability  | Body     | Options                                                             | Description                                                                              |
| --------------------- | ----------- | -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `file-write`          | write-files | optional | `path`, `open`, `mode`, `from`                                      | Write the body, or a file shipped with the workshop, to a file.                          |
| `file-open`           | none        | none     | `path`, `line`, `split`                                             | Open a file in the editor, optionally at a line.                                         |
| `file-close`          | none        | none     | `path`                                                              | Close every editor and preview showing a file.                                           |
| `editor-insert`       | write-files | required | `path`, `line`, `match`, `regex`, `occurrence`, `position`, `save`  | Insert the body into a file before a line or a match, or at the end.                     |
| `editor-replace`      | write-files | optional | `path`, `line`, `match`, `regex`, `occurrence`, `expand`, `save`    | Replace the first match of a pattern, chosen matches, or a range of lines with the body. |
| `editor-select`       | none        | none     | `path`, `line`, `match`, `regex`, `occurrence`, `group`             | Select matching text or a range of lines in a file.                                      |
| `editor-highlight`    | none        | none     | `path`, `line`, `match`, `regex`, `occurrence`, `group`, `duration` | Briefly highlight matching text or a range of lines in a file.                           |
| `file-browser-reveal` | none        | none     | `path`                                                              | Show a path in the file browser.                                                         |
| `download`            | none        | none     | `path`                                                              | Download a file to the learner’s machine.                                                |
| `upload-prompt`       | none        | none     | `path`                                                              | Ask the learner to upload files.                                                         |

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
| `launcher-open` | none        | none     | (none)          | Open the launcher, or show the open one.                      |

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

| Directive            | Capability       | Body     | Options | Description                                                                       |
| -------------------- | ---------------- | -------- | ------- | --------------------------------------------------------------------------------- |
| `copy`               | none             | required | (none)  | Copy the body to the clipboard.                                                   |
| `environment-create` | install-packages | none     | (none)  | Create the isolated environment declared in the manifest and register its kernel. |

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

## Common options

- `id` names the directive so other blocks can refer to it: a `requires`
  entry, a verify `trigger`, a `cascade`, an `auto: after:`. Without one
  the id comes from the page and the directive's position, such as
  `first-commit-2`.

- `title` is the label on the button, in place of the description the
  action would otherwise generate from its options.

- `auto` runs the action without a click: `page-enter` when the page is
  shown, or `after:<id>` when the named action succeeds. It needs the
  `auto-run` capability.

- `cascade` runs another action when this one succeeds: `true` for the
  next action on the page, an id for a named one, or `<id> after 2s` to
  wait first. It also needs `auto-run`. Setting `cascade` under
  `defaults.actions` in the manifest applies it to every action.

- `delay` waits before an automatic run, as a duration such as `500ms` or
  `2s`. `defaults.actions.delay` in the manifest sets the fallback.

- `scroll: false` stops the panel scrolling to the action when it runs
  automatically.

- `when` shows the action only while a condition holds, written the same
  way as the argument of the `{when}` directive below.

- `substitute: false` keeps `{{ }}` references in the body and options as
  written; see [Variables in bodies and files](#variables-in-bodies-and-files).

- `on-error` decides what a failure does to a chain of automatic actions.
  By default a failing action stops the chain: nothing queued behind it
  runs, and its own followers are not started. `on-error: continue` lets
  the rest of the queued chain go on, for a step whose failure is
  tolerable, such as setting a configuration value that may already be
  set. It changes nothing for a clicked action, and the failed action's
  own `cascade` still does not fire, since a cascade follows success.

## Variables in bodies and files

Every directive body and option has `{{ name }}` references replaced before
the action runs, unless the directive says `substitute: false`, which keeps
them as written for content that uses double braces itself. A file that
`file-write` copies with `from` is the other way round: it is written as it
is, and only substitutes when the directive says `substitute: true`.

## Editor targets

The `editor-select`, `editor-highlight`, `editor-replace` and `editor-insert`
directives point at text in a file the same way: with `match` or with
`line`, never both.

- `match` is literal text, or a JavaScript regular expression when
  `regex: true`. The pattern runs over the whole file with the multiline
  flag, so `^` and `$` mark the start and end of a line, `.` does not cross
  a newline, and `[\s\S]*?` spans lines lazily.

- `occurrence` picks which matches count, from one: a number, a range such
  as `2-3`, or `all`. The default is the first. A select or highlight covers
  the chosen matches from the first to the last, a replace changes each of
  them, and an insert adds its body at each.

- `group`, on `editor-select` and `editor-highlight`, names a capture group
  by number or name whose span is used instead of the whole match, so a
  pattern can match on context and mark only part of it. Needs `regex`.

- `expand: true`, on `editor-replace`, expands group references in the body
  the way JavaScript's `replace` does: `$1`, `$<name>`, `$&` for the whole
  match, and `$$` for a dollar sign. It is off by default because command
  bodies are full of dollars. Needs `regex`.

- `line` is a line number, or a range such as `10-15` on select, highlight
  and replace. A replace swaps the whole lines for the body, and an empty
  body deletes them. `editor-insert` takes a single line, inserting before
  it, or `end` to append, which is the default.

- `position: after`, on `editor-insert`, puts the body after the matched or
  named line instead of before it.

The body of `editor-replace` loses its final newline, so a match that stops
short of a newline is replaced cleanly; the bodies of `editor-insert` and of
a replace by line gain one, so they are whole lines. After a replace the new
text is left selected, so a select, an explanation and a replace with the
same pattern show the learner what is about to change and then what did.

Highlight a function and its body, then replace the body and keep the
signature:

````markdown
```{editor-highlight}
:path: app/main.py
:regex: true
:match: ^def greet\(.*\n(?:    .*\n)+
```

```{editor-replace}
:path: app/main.py
:regex: true
:expand: true
:match: ^(def greet\(.*\n)(?:    .*\n)+
$1    for name in names:
        print(f"Hello, {name}!")
```
````

Add imports before the first function, replace the middle two of four
`print(` calls, and replace lines by number:

````markdown
```{editor-insert}
:path: app/main.py
:regex: true
:match: ^def
import logging

```

```{editor-replace}
:path: app/main.py
:match: print(
:occurrence: 2-3
log(
```

```{editor-replace}
:path: app/main.py
:line: 10-15
    for name in names:
        print(f"Hello, {name}!")
```
````
