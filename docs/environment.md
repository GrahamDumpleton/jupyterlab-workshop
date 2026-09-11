# Isolated environments

A workshop that needs Python packages can ask for its own environment
rather than installing into whatever JupyterLab runs in:

```yaml
capabilities:
  - install-packages
environment:
  requirements: requirements.txt
  kernel: workshop-pandas
```

`requirements` is a pip requirements file in the workshop directory.
`kernel` is the base name of the kernelspec to register and defaults to
`workshop-<name>`; the name actually registered adds a short hash of
the workshop's location, `workshop-pandas-3f9c1a72` say, so the same
workshop installed in two directories keeps two kernels rather than
sharing one. The kernel picker shows the workshop's title, not the
name. The `install-packages` capability must be declared; the linter
reports an error otherwise.

## What happens

When such a workshop opens, the panel shows a banner offering to create
the environment. Creating it:

1. Makes a virtual environment at `_workshop/venv` inside the workshop
   directory with the server's Python.

2. Installs the requirements and `ipykernel` into it.

3. Registers a kernelspec for it under the learner's Jupyter data
   directory, with the workshop's title as its display name.

The steps are logged to `_workshop/environment.log`, and
`_workshop/environment.json` records the kernel name and the hash of
the requirements file. If the requirements change later the banner
returns, offering to recreate the environment. Creating an environment
that already exists from the same requirements, with its kernel
registered, does nothing and reports so; the banner's Recreate button
and the action's `:force: true` option rebuild it regardless.

Once the kernel is registered, notebooks created by `notebook-create`
without an explicit `kernel` use it, and so does the hidden workshop
kernel behind `execute-capture`, `kernel-execute` without a `path`, and
kernel checks. Before the environment is ready, a notebook action in
such a workshop fails, saying the environment must be created first,
rather than silently opening the notebook on the server's own Python,
which would only fail later with a missing module; and the action checks
that JupyterLab's kernel list has the kernel before opening a notebook
on it, since JupyterLab would otherwise fall back to its default kernel
without a word. The kernelspec sets `VIRTUAL_ENV` and puts the
environment's programs first on `PATH` for every kernel started from
it, as activating the environment would, so `!pip` in a notebook and a
`subprocess` in a check reach the environment rather than the server's
Python.

## Terminals and commands

Workshop terminals see the environment too: once it exists, the
environment file the terminals load exports `VIRTUAL_ENV` and puts the
environment's `bin` (`Scripts` on Windows) first on `PATH`, so `python`,
`pip`, `pytest` and whatever the requirements installed are the
environment's, with no activation step on the page. Terminals already
open pick it up when the environment is created. `execute-capture`,
`shell` checks and `script` checks run with the same `PATH`. A workshop
that needs Python packages in a terminal therefore declares them in the
requirements file and lets the learner start work, instead of walking
them through `python -m venv` and `pip install`.

A workshop that teaches virtual environments wants the bare `python`
in its terminals, and says so:

```yaml
environment:
  requirements: requirements.txt
  terminals: false
```

The kernel still comes from the environment; only terminals and the
commands that run without one are left alone.

Nothing outside the workshop directory changes except the kernelspec.
"Workshop: Remove…" unregisters it before deleting the directory, and
"Workshop: Restart…" removes the environment with the rest of the
workshop's state, kernelspec included, so the banner returns and a
fresh one can be created: a learner who has installed into the
environment by hand can get back to a known one that way. "Workshop:
Reset Progress…" keeps it, as it keeps the files.

## Trust

Creating the environment is the `environment-create` action with the
`install-packages` capability, so the trust level applies: it runs when
trusted, asks for confirmation when restricted or under "ask each time",
and never runs when the manifest does not declare the capability or an
administrator has disabled it. A page can carry the action explicitly to
make it a visible step:

````markdown
```{environment-create}
:title: Set up the workshop environment
```
````

While a page with the action is showing, the banner stays out of the
way, since the page is explaining the step, and the action shows as
done once the environment exists, whether the learner clicked it, used
the banner on an earlier page, or created it in an earlier session.
Put the action on the first page of a notebook workshop: the self-test
runs only what the pages carry, so without it the test's notebooks
would run on the server's kernel. The command "Workshop: Create
Environment" does the same from the palette.

## Kernels across sessions

A kernelspec is registered for the user, under the Jupyter data
directory, not for one server or one JupyterLab root, so every
JupyterLab the user starts lists every workshop kernel registered and
not yet removed, in the launcher and the kernel picker. Remove and
Restart unregister a workshop's own kernel, and a workshop whose venv
is still there but whose spec has gone, deleted by hand or by an older
release that shared names between copies, gets it registered again
when it is next opened, with no rebuild.

Only a spec whose Python lives under a workshop's `_workshop/venv`
directory is ever unregistered, and only by the workshop that venv
belongs to; the server's kernel and any kernel registered for other
purposes are never touched. Kernels whose environment has gone, because
the workshop directory was deleted or moved, stay registered until
pruned:

```
jupyter workshop kernels --prune
```

lists the workshop kernels with `ok` or `stale` beside each and, with
`--prune`, unregisters the stale ones; see [kernels](cli.md#kernels).

## Limits

- Only pip requirements files and virtual environments are supported;
  conda environments are not.

- Creating the environment needs network access to a package index, and
  takes as long as `pip install` does. The banner shows "Creating…"
  meanwhile and the log on failure.

- The kernelspec is registered for the user running the server, which
  is the right scope on a personal machine and under JupyterHub; see
  [kernels across sessions](#kernels-across-sessions) for what that
  means over time.
