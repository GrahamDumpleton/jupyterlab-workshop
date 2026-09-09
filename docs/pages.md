# Pages and actions

A page is a MyST Markdown file: YAML front matter, prose, and fenced
blocks named in braces that are the actions. This page describes the
syntax, the options every action accepts, the inline roles, conditional
content, and how the editor actions point at text. The
[action reference](actions.md) lists the actions themselves.

## Front matter

```markdown
---
title: Your first commit
requires: [verify:first-commit, quiz:staging]
optional: false
when: track == "cli"
---
```

- `title` is shown in the panel and the page list. Without one the page
  is named after its file.

- `requires` lists the checks, quizzes and forms, as `verify:<id>`,
  `quiz:<id>` and `form:<id>`, that should be complete before leaving
  the page; the manifest's `gating` says how firmly. See
  [gating](checks.md#gating).

- `optional: true` marks the page as optional in the page list.

- `when` shows the page only while a condition holds, written like the
  `{when}` directive below. A page hidden this way is left out of the
  page list and the count, which is how [tracks](variables.md#tracks)
  work.

- `id` overrides the page id, which is otherwise the file name without
  its extension, such as `02-first-commit`. Directive ids and progress
  records are built on it, so renaming a file without setting `id`
  forgets the progress on that page.

## Directives

An action is a fenced block whose name is in braces. Options are
`:name: value` lines at the top of the block; everything after the
options is the body:

````markdown
```{execute}
:id: first-commit
:session: git
:title: Record the commit
git commit -m "Add README"
```
````

Every action gets an id, from `:id:` or, failing that, from the page id
and a running number over the blocks on the page that have none, such
as `first-commit-2`. Give an explicit `:id:` to anything another block
refers to: a `requires` entry, a verify `trigger`, a `cascade`, an
`auto: after:`. Short descriptive ids read best: `create-repo`,
`first-commit`, `staging-quiz`.

A body may hold alternatives for particular platforms, marked by a line
holding only `:windows:`, `:linux:`, `:macos:` or `:lite:`; see
[command variants](platforms.md#command-variants).

A directive whose body holds a fenced code block, such as a `hint` that
quotes some output or a `when` with a command in it, must itself be
fenced with more backticks than the block inside: four for the
directive, three for the code, as the examples on this page are. Lint
cannot see the mistake, since the result is valid Markdown: the inner
fence closes the directive, its body stops there, and the prose after
it renders as a code block.

Blank lines in a body follow two rules. A single blank line straight
after the options is taken as the separator between options and body
and dropped. The line break before the closing fence ends the last
line rather than adding a blank one, and actions that write the body to
a file end it with a single newline. Every other blank line is kept,
leading or trailing, so a `file-write` with `mode: append` that must
leave two blank lines above a Python definition starts its body with
three.

## Common options

- `id` names the directive so other blocks can refer to it.

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
  automatically, and stops the notebook actions that insert or run cells
  (`cell-insert`, `cell-run`, `cell-run-to`, `cell-run-all`) scrolling
  the notebook to the cell they acted on, which they otherwise do so the
  cell and its output are in view.

- `when` shows the action only while a condition holds, written the same
  way as the argument of the `{when}` directive below.

- `substitute: false` keeps `{{ }}` references in the body and options as
  written; see [substitution](#substitution).

- `on-error` decides what a failure does to a chain of automatic actions.
  By default a failing action stops the chain: nothing queued behind it
  runs, and its own followers are not started. `on-error: continue` lets
  the rest of the queued chain go on, for a step whose failure is
  tolerable, such as setting a configuration value that may already be
  set. It changes nothing for a clicked action, and the failed action's
  own `cascade` still does not fire, since a cascade follows success.

## Inline roles

A role is a small action inside a sentence, written as the role name in
braces followed by the text in backticks:

```markdown
Run {copy}`git status` to see the state, then open {open}`README.md`.
Your repository is in {var}`repo_dir`.
```

`{copy}` copies its text to the clipboard, `{open}` opens the named
file in the editor, `{highlight}` highlights the element matching a
selector, and `{var}` shows the value of a variable.

## Conditional content

The `{when}` directive takes a condition as its argument and shows its
body only when the condition holds:

````markdown
```{when} track == "pip"
Install the package with pip.
```
````

Conditions use `==`, `!=`, `in`, `not in`, `and`, `or`, `not` and
parentheses over variables, quoted strings and `[lists]`. A bare
variable name is true when it has a non-empty value. The same
conditions serve the `when` option of any directive and the `when`
field of a page's front matter.

## Substitution

Every directive body and option has `{{ name }}` references replaced
before the action runs, unless the directive says `substitute: false`,
which keeps them as written for content that uses double braces itself.
A file that `file-write` copies with `from` is the other way round: it
is written as it is, and only substitutes when the directive says
`substitute: true`. [Variables](variables.md) describes the syntax and
where values come from.

## Editor targets

The `editor-select`, `editor-highlight`, `editor-replace` and
`editor-insert` directives point at text in a file the same way: with
`match` or with `line`, never both.

- `match` is literal text, or a JavaScript regular expression when
  `regex: true`. The pattern runs over the whole file with the multiline
  flag, so `^` and `$` mark the start and end of a line, `.` does not
  cross a newline, and `[\s\S]*?` spans lines lazily.

- `occurrence` picks which matches count, from one: a number, a range
  such as `2-3`, or `all`. The default is the first. A select or
  highlight covers the chosen matches from the first to the last, a
  replace changes each of them, and an insert adds its body at each.

- `group`, on `editor-select` and `editor-highlight`, names a capture
  group by number or name whose span is used instead of the whole
  match, so a pattern can match on context and mark only part of it.
  Needs `regex`.

- `expand: true`, on `editor-replace`, expands group references in the
  body the way JavaScript's `replace` does: `$1`, `$<name>`, `$&` for
  the whole match, and `$$` for a dollar sign. It is off by default
  because command bodies are full of dollars. Needs `regex`.

- `line` is a line number, or a range such as `10-15` on select,
  highlight and replace. A replace swaps the whole lines for the body,
  and an empty body deletes them. `editor-insert` takes a single line,
  inserting before it, or `end` to append, which is the default.

- `position: after`, on `editor-insert`, puts the body after the matched
  or named line instead of before it.

The body of `editor-replace` loses its final newline, so a match that
stops short of a newline is replaced cleanly; the bodies of
`editor-insert` and of a replace by line gain one, so they are whole
lines. After a replace the new text is left selected, so a select, an
explanation and a replace with the same pattern show the learner what
is about to change and then what did.

`editor-insert` and `editor-replace` save the file after the edit
unless `save: false`, which leaves it modified in the editor. A
`file-write` to a file that is open in the editor goes through the
editor and saves, so it sees an unsaved edit rather than the stale file
on disk, and the two can be mixed freely on one file.

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
