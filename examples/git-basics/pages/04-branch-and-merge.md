---
title: Branch and merge
requires: [verify:merged]
---

# Branch and merge

Branches let you work on a change without disturbing `main`. Create a
branch called `feature` and switch to it in one step.

```{execute}
:session: git
git switch -c feature
```

Make a change on the branch.

```{editor-insert}
:path: {{ repo_dir }}/README.md
:line: end
- Branches keep work in progress separate.
```

Commit it.

```{execute}
:session: git
git commit -am "Note what branches are for"
```

The history now shows `feature` one commit ahead of `main`.

```{execute}
:session: log
git log --oneline --graph --all
```

Switch back to `main`.

```{execute}
:session: git
git switch main
```

Reopen the file. The line you added is gone, because it only exists on
the `feature` branch.

```{file-open}
:path: {{ repo_dir }}/README.md
```

Merge the branch. Because `main` has not changed since `feature` was
created, git simply moves `main` forward, which it calls a fast-forward.

```{execute}
:session: git
git merge feature
```

Both branches now point at the same commit.

```{execute}
:session: log
git log --oneline --graph --all
```

This check runs a script shipped with the workshop in `verify/merged.py`
after the merge command, and every ten seconds.

```{verify}
:id: merged
:label: main includes the feature branch
:script: verify/merged.py
:trigger: after:branch-and-merge-7; interval 10s
```
