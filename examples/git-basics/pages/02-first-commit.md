---
title: Your first commit
---

# Your first commit

A commit records a snapshot of the files git has been told to track. Start
by creating a file to track. Clicking the action below writes the file and
opens it in the editor.

```{file-write}
:path: {{ repo_dir }}/README.md
:open: true
# Demo project

A small project for practising git.

## Notes

- Created the repository.
```

Git has noticed the new file but is not yet tracking it. The file is shown
as untracked.

```{execute}
:session: git
git status
```

Tell git to track the file by adding it to the staging area, the set of
changes that will go into the next commit.

```{execute}
:session: git
git add README.md
```

Run `git status` again and the file is now listed as a change to be
committed.

```{execute}
:session: git
git status
```

Record the commit with a message describing the change.

```{execute}
:session: git
git commit -m "Add README"
```

The commit now appears in the history. The commands run in the terminal
highlighted below.

```{execute}
:session: git
git log --oneline
```

```{highlight}
:selector: .jp-Terminal
:duration: 3s
Commands run in this terminal.
```
