---
title: Resolve a conflict
requires: [verify:conflict-resolved]
---

# Resolve a conflict

A merge conflict happens when two branches change the same lines. Create
one on purpose. Start a `hotfix` branch and change the description line of
the README.

```{execute}
:session: git
git switch -c hotfix
```

```{editor-insert}
:path: {{ repo_dir }}/README.md
:line: 3
A small project for practising git, patched on the hotfix branch.
```

```{execute}
:session: git
git commit -am "Update description on hotfix"
```

Now go back to `main` and change the same line differently.

```{execute}
:session: git
git switch main
```

```{editor-insert}
:path: {{ repo_dir }}/README.md
:line: 3
A small project for practising git, revised on main.
```

```{execute}
:session: git
git commit -am "Update description on main"
```

Try to merge. Git stops and reports a conflict in `README.md`.

```{execute}
:session: git
git merge hotfix
```

Open the file at the conflict. Git has left both versions in place between
`<<<<<<<`, `=======` and `>>>>>>>` markers.

```{file-open}
:path: {{ repo_dir }}/README.md
:line: 3
```

Resolve the conflict by replacing the file with the version you want to
keep. Here the two descriptions are combined and the markers removed.

```{file-write}
:path: {{ repo_dir }}/README.md
:open: true
# Demo project

A small project for practising git, revised on main and patched on hotfix.

A small project for practising git.

## Notes

- Created the repository.
- Learned how git diff shows unstaged changes.
- Branches keep work in progress separate.
```

Tell git the conflict is resolved by staging the file, then complete the
merge with a commit.

```{execute}
:session: git
git add README.md
```

```{execute}
:session: git
git commit -m "Merge hotfix into main"
```

The history shows the merge commit joining the two branches.

```{execute}
:session: log
git log --oneline --graph --all
```

That is the end of the workshop.

```{toast}
:type: success
You have completed Git from the command line.
```

```{verify}
:id: conflict-resolved
:label: The conflict is resolved and merged
:trigger: terminal-output "Merge hotfix"; interval 10s
import subprocess

def git(*args):
    return subprocess.run(
        ["git", "-C", "{{ repo_dir }}", *args], capture_output=True, text=True
    ).stdout

readme = open("{{ repo_dir }}/README.md").read()

assert "<<<<<<<" not in readme, "README.md still has conflict markers"
assert "hotfix" in git("branch", "--merged", "main"), "hotfix is not merged into main"
print("Conflict resolved and merged")
```

## Starting over

Marking the "Your first commit" page done saved a checkpoint of the
repository as it was after the first commit. To practise the branching and
merging pages again, restore it: the files go back to that state and the
later commits disappear. Saving a checkpoint of the finished state first
lets you come back here too.

```{checkpoint}
:name: finished
```

```{restore}
:name: after-first-commit
```
