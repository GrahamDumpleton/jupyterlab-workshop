---
title: Create a repository
requires: [form:identity, verify:repo-created]
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

Git records who made each commit, so tell it who you are. Fill in the
form and the command below picks up your answers.

```{form}
:id: identity
:title: Who you are
- { name: user_name, type: text, label: Name, required: true, default: Workshop Learner }
- { name: user_email, type: email, label: Email, required: true, default: learner@example.com }
```

```{execute}
:session: git
git config user.name "{{ user_name }}" && git config user.email "{{ user_email }}"
```

Finally, ask git for the state of the repository. It should report that
there are no commits yet.

```{execute}
:session: git
git status
```

The check below passes once the repository exists. It runs by itself
after the `git init` command, and you can click Check at any time.

```{verify}
:id: repo-created
:label: The repository has been created
:substrate: contents
:trigger: after:create-a-repository-2; terminal-output "Initialized empty Git repository"
exists {{ repo_dir }}
```
