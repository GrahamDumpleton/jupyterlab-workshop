# Page template

A complete page showing the usual shape: context, an action, a file, a
check and a question. Copy it and replace the specifics.

````markdown
---
title: Your first commit
requires: [verify:first-commit, quiz:staging]
---

# Your first commit

Git records a snapshot of the files you have staged. Create a file to
commit, stage it, and record the commit with a message.

```{file-write}
:id: readme
:path: {{ repo_dir }}/README.md
:open: true
# {{ repo_dir }}

A practice repository.
```

Stage the file. Staging chooses what the next commit contains.

```{execute}
:id: stage
:session: git
git add README.md
```

Record the commit. The message goes with the snapshot forever, so make
it say what changed.

```{execute}
:id: commit
:session: git
git commit -m "Add README"
```

```{verify}
:id: first-commit
:label: You have made a commit
:trigger: after:commit; terminal-output "Add README"
import subprocess
out = subprocess.run(
    ["git", "-C", "{{ repo_dir }}", "log", "--oneline"],
    capture_output=True, text=True
).stdout
assert out.strip(), "No commits yet: run the git commit command above"
```

```{hint}
:title: If git asks who you are
Set your name and email once with `git config user.name` and
`git config user.email`, then run the commit again.
```

```{quiz}
:id: staging
question: What does git add do?
options:
  - { text: Chooses the changes the next commit will contain, correct: true }
  - { text: Records a commit, explanation: "That is git commit." }
  - { text: Uploads to a server, explanation: "That is git push." }
explanation: git add stages changes; git commit records what is staged.
```
````

Notes on the template:

- The page id comes from the file name (`02-first-commit.md` gives
  `02-first-commit`), so directives without `:id:` are named
  `02-first-commit-1`, `02-first-commit-2` and so on.

- `{{ repo_dir }}` is a manifest variable with a default, so the page
  renders before the learner changes anything.

- The verify uses the default `kernel` substrate because `.git` is hidden
  from the `contents` substrate.
