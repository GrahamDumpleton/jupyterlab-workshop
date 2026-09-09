# Style guide for workshop pages

The panel is narrow and the learner is doing something else at the same
time, so pages are short, concrete and ordered.

## Pages

- One page per step a learner would describe in a sentence: "create the
  repository", "make the first commit". Five to eight pages for a 30
  minute workshop.

- Start with the front matter `title`, then a single `#` heading that
  repeats it, then one or two sentences of context.

- End every page with something the panel can confirm: a `verify`, a
  `quiz` or a `form`, listed in the page's `requires`.

- The first page states what the learner needs (tools, accounts) and the
  manifest declares them in `requires.tools`.

- The last page summarises and points at what to read next.

## Prose

- Say why before the action, and what to expect after it. Two or three
  sentences per action is enough.

- Second person, present tense, plain words. "Create the repository"
  rather than "We will now be creating the repository".

- Name files and commands in backticks. Use `{copy}` roles for values the
  learner types elsewhere, `{open}` roles for files to look at.

- Put background, alternatives and troubleshooting in a `hint`, not in
  the main flow.

- The instructions are a side panel; the editor, notebook and terminals
  are beside it, not above or below it. Point at them by name (`orders.py`,
  open in the editor; the workshop terminal) and keep "above" and "below"
  for things inside the panel, such as the step above or the Finish
  button below.

- No emdashes; use commas, colons or separate sentences.

## Actions

- One command per `execute` unless the commands only make sense
  together; the panel shows the body, so it must read as what will run.

- Give a `:title:` when the command does not explain itself.

- Give an explicit `:id:` to anything referenced elsewhere. Use short,
  descriptive ids: `create-repo`, `first-commit`, `staging-quiz`.

- Use the same `:session:` name throughout a workshop that works in one
  terminal; name a second session only when two terminals are needed at
  once.

- Prefer `file-write` with `:open: true` to asking the learner to type a
  file, and `editor-replace` with a `:match:` for small edits, so the
  learner sees the change happen.

- For notebooks, `notebook-create` with tagged cells, then `cell-run-all`
  or `cell-run` by tag, and `verify` with `learner-kernel` or the
  `contents` predicate `cell-executed`.

- Use `:auto: page-enter` and `:cascade:` sparingly and only for setup
  the learner need not watch; they need the `auto-run` capability and
  the trust dialog counts them.

## Checks

- Check the outcome, not the keystrokes: that a commit exists, not that
  `git commit` was typed.

- Write the failure message as advice: `assert path.exists(), "Run the
git init command above first"`.

- Trigger checks from the action they confirm (`after:<id>`) or from
  terminal output, so they pass without a click.

- Use the `contents` substrate when a file check is enough; it needs no
  capability and no kernel.

- A `shell` check's message is its whole output, so shape it: colour off,
  one line on success and the full output on failure. `pytest -q` prints
  the dots and the summary, `-qq` drops the summary, which is the wrong
  way round. This POSIX `sh` pattern does it, with the learner's tools
  named by path since no terminal is involved:

  ```
  out=$(.venv/bin/python -m pytest -q --color=no test_orders.py 2>&1) && { printf '%s\n' "$out" | tail -n 1; exit 0; }; printf '%s\n' "$out"; exit 1
  ```

## Notebook pages

- One thing per cell whose result the learner should see: a cell shows
  only its last expression, so a cell that changes some state and then
  makes a call shows the call's result and never the change.

- A value that is a multi-line string is shown with `print()`; as a bare
  expression it appears as a repr with `\n` in it.

- Add cells with `cell-insert` and `:run: true` where the learner should
  see the output appear, and keep one page per idea so the notebook and
  the panel stay in step.

## Quizzes and forms

- One question per quiz, three or four options, an `explanation` for
  each wrong option that teaches something.

- Forms only for values the workshop needs (names, choices); give every
  field a `default` so the self-test and impatient learners can proceed.

## Platforms

- Write commands for bash first; add `:windows:` variants for anything
  using `&&`, `export`, `ls`, `cat`, `rm`, `touch` or `/` in paths.

- Use `{{ path "a/b" }}` in prose that shows a path on the learner's
  machine.
