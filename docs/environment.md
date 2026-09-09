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
`kernel` names the kernelspec to register and defaults to
`workshop-<name>`. The `install-packages` capability must be declared;
the linter reports an error otherwise.

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
kernel checks.

Nothing outside the workshop directory changes except the kernelspec,
and "Workshop: Remove…" unregisters it before deleting the directory.

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

## Limits

- Only pip requirements files and virtual environments are supported;
  conda environments are not.

- Creating the environment needs network access to a package index, and
  takes as long as `pip install` does. The banner shows "Creating…"
  meanwhile and the log on failure.

- The kernelspec is registered for the user running the server, which
  is the right scope on a personal machine and under JupyterHub.
