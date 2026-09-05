---
title: Create a repository
---

# Create a repository

This workshop walks through the everyday git commands from the command
line. Every command below is a clickable action: click it and it runs in a
terminal that opens beneath the main area. You can also type the commands
yourself if you prefer.

First, check that git is installed.

```{execute}
:session: git
git --version
```

Create a new repository in the `{{ repo_dir }}` directory, with `main` as
the name of the default branch.

```{execute}
:session: git
git init -b main {{ repo_dir }}
```

Move into the new repository. The rest of the workshop runs inside it.

```{execute}
:session: git
cd {{ repo_dir }}
```

Git records who made each commit, so tell it who you are. These settings
apply only to this repository.

```{execute}
:session: git
git config user.name "Workshop Learner" && git config user.email "learner@example.com"
```

Finally, ask git for the state of the repository. It should report that
there are no commits yet.

```{execute}
:session: git
git status
```
