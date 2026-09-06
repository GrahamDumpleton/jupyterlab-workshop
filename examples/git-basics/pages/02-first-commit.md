---
title: Your first commit
requires: [verify:first-commit, quiz:staging]
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

The check below looks for the commit whenever the terminal reports one,
so it turns green a moment after the commit runs.

```{verify}
:id: first-commit
:label: You have made a commit
:trigger: terminal-output "Add README"; interval 10s
:cascade: after-first-commit
import subprocess

out = subprocess.run(
    ["git", "-C", "{{ repo_dir }}", "log", "--oneline"],
    capture_output=True, text=True
).stdout

assert out.strip(), "No commits yet: run git commit"
print(f"{len(out.splitlines())} commit(s) so far")
```

A quick question before moving on.

```{quiz}
:id: staging
:title: Staging area
:attempts: 3
question: Which command moves changes into the staging area?
options:
  - { text: git add, correct: true }
  - { text: git commit, explanation: "git commit records what is already staged." }
  - { text: git stage-it }
explanation: git add stages changes; git commit records what is staged.
```

Once the check passes it saves a checkpoint of the repository, so a
`restore` action on a later page can bring you back to this state. You
can also take one yourself by clicking it.

```{checkpoint}
:id: after-first-commit
:name: after-first-commit
```
