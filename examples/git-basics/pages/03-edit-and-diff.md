---
title: Edit and diff
---

# Edit and diff

Now change a tracked file and look at what git makes of it. The action
below appends a line to {open}`{{ repo_dir }}/README.md` in the editor and
saves it.

```{editor-insert}
:path: {{ repo_dir }}/README.md
:line: end
- Learned how git diff shows unstaged changes.
```

Ask git to show the difference between the working tree and the last
commit. Added lines are prefixed with a plus sign.

```{execute}
:session: git
git diff
```

Open a second terminal to keep an eye on the history as it grows. It runs
alongside the first one.

```{execute}
:session: log
cd {{ repo_dir }} && git log --oneline --graph --all
```

Back in the first terminal, commit the change. The `-a` flag stages every
tracked file that has changed, so a separate `git add` is not needed.

```{execute}
:session: git
git commit -am "Note what git diff shows"
```

Refresh the history in the second terminal. You can also copy the command
with {copy}`git log --oneline --graph --all` and paste it yourself.

```{execute}
:session: log
git log --oneline --graph --all
```
