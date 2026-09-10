# Variables

Variables let one workshop adapt to the learner, the machine and the
choices made along the way. A page refers to one as `{{ name }}`, in
prose, in action options and in action bodies, and the value is filled
in before the text is shown or the action runs. This page covers the
syntax, where values come from, how they reach terminals and kernels,
and conditions.

## Syntax

```markdown
Your repository is in {{ repo_dir }}.
Run it as {{ command | shell }} from {{ path "src/app" }}.
```

A reference is the name in double braces. Filters follow a pipe:

| Filter       | Effect                                                              |
| ------------ | ------------------------------------------------------------------- |
| `lower`      | Lower case.                                                         |
| `upper`      | Upper case.                                                         |
| `slug`       | Lower case with runs of anything but letters and digits as hyphens. |
| `default(x)` | The value `x` when the variable is empty.                           |
| `shell`      | Quoted for use as one word in a POSIX shell command.                |
| `path`       | Forward slashes replaced by the platform's separator.               |

`{{ path "src/app.py" }}` renders a literal path with the platform's
separator. A backslash before the braces, `\{{ name }}`, leaves the
reference as text. The `{var}` role, ``{var}`repo_dir` ``, shows a
value in prose and updates when it changes, and a declared variable
with no value yet shows its name, muted, rather than nothing.

An unknown variable is left as written and reported by the linter. A
variable the workshop declares but has not set yet, for example one a
form on a later page collects, renders as empty.

## Declaring variables

The manifest declares the variables a workshop uses:

```yaml
variables:
  - name: repo_dir
    type: path
    default: sandbox
    description: Directory the repository is created in
  - name: mood
    type: select
    options: [great, fine, tired]
  - name: api_token
    type: secret
```

`name` is required. `type` is one of `text`, `number`, `boolean`,
`select`, `multiselect`, `secret`, `path`, `url` and `email`, and shapes
the field the learner sees in the Variables dialog and in forms.
`default` supplies a value until something else sets one, `options`
lists the choices of a select, `readonly` stops the learner changing
it, and `secret` keeps the value out of the state file. The
[manifest reference](reference/manifest.md#variables-entries) has the
full list.

## Where values come from

Several sources can set the same variable. The one furthest down this
list wins:

1. **Built-ins** describe the machine and the session: `platform`,
   `shell`, `path_sep`, `workshop_dir`, `workspace`, `home`, `user`,
   `host` and `container`. They cannot be changed.
   [Platforms](platforms.md) says what each holds.

2. **Manifest defaults**, from the `default` of a declaration.

3. **Launch link overrides**: `var.<name>=<value>` parameters on a
   [launch link](collections.md#launch-links), for a class where the
   instructor sets, say, the directory everyone works in.

4. **Forms**: a `form` directive the learner submits. Values are stored
   and the pages re-render, so commands after the form can use them.
   Secrets reach commands through the environment file only.

5. **Captures**: output stored by `execute-capture`, `kernel-execute`
   with `capture`, a `dialog` with `capture`, a `choice`, or an
   `env-set` action.

6. **The learner**, through the Variables dialog opened from the gear
   button in the panel header or "Workshop: Variables…", which lists
   every declared variable with its current value and source.

Reset Progress clears what forms, captures and the learner set, leaving
the built-ins and manifest defaults. The linter reports a page that uses
a variable before the page whose form sets it, unless the manifest gives
it a default (`use-before-form`).

## Terminals and kernels

The variables are exported to workshop terminals as environment
variables: `repo_dir` becomes `REPO_DIR`, and the built-ins get a
`WORKSHOP_` prefix, so `platform` is `WORKSHOP_PLATFORM`. They are
written to `_workshop/env.sh`, `env.fish`, `env.ps1` and `env.cmd`, one
per shell, and every workshop terminal loads the file when it starts and
again whenever a value changes. The same file sets the [workshop
prompt](platforms.md#the-workshop-prompt). Under JupyterLite the terminal
cannot source a file, so the values are sent as `export` commands
instead. A manifest `env` mapping adds fixed environment variables of
its own, such as a pager setting; see [terminal
shells](platforms.md#terminal-shells).

```{warning}
Because a declared variable is exported under its own name in upper
case, a name that upper-cases to one the shell or operating system
already uses replaces the real value in every workshop terminal. A
variable called `path` becomes `PATH` and leaves the terminal unable to
find commands; `term`, `lang`, `tmpdir`, `ps1`, `ifs` and
`pythonpath` are equally unsafe on Linux and macOS, and `temp`, `tmp`,
`userprofile`, `comspec`, `pathext`, `systemroot` and `windir` on
Windows, where environment names are case-insensitive. Pick names
that say what the workshop stores, such as `repo_dir` or
`project_name`, rather than generic single words. Only the built-ins
carry the `WORKSHOP_` prefix.
```

The hidden workshop kernel that runs `execute-capture`, `kernel-execute`
without a `path`, and kernel checks has the same environment, so a check
can read `os.environ["REPO_DIR"]`, and its code can equally use
`{{ repo_dir }}` directly, since bodies are substituted before they run.
A workshop with an [isolated environment](environment.md) also has
`VIRTUAL_ENV` set and the environment first on `PATH`, in terminals and
kernels alike.

## Conditions

A condition shows or hides content by the variables: the `{when}`
directive around prose and actions, the `when` option on any directive,
and the `when` field of a page's front matter, which hides the page
from the list altogether.

````markdown
```{when} platform == "windows" and not container
Windows users: run the commands in PowerShell.
```
````

Conditions use `==`, `!=`, `in`, `not in`, `and`, `or`, `not` and
parentheses over variables, quoted strings and `[lists]`. A bare
variable name is true when it has a non-empty value.

## Tracks

A track is a named path through a workshop that the learner chooses.
The manifest declares the tracks, a `choice` directive with
`:track: true`, or a form field with `set_track: true`, sets the `track`
variable, and pages carry `when: track == "pip"` in their front matter
so only the chosen path shows:

```yaml
tracks:
  - { id: pip, label: pip }
  - { id: conda, label: conda }
```

````markdown
```{choice}
:track: true
Which package manager do you use?
```
````

The Hello JupyterLab example does exactly this on its variables page,
with one page for pip and one for conda after it.

## Showing what a command found

Values captured from the session are variables like any other, so a
page can run a command in the background, store its output and show it
in prose:

````markdown
```{execute-capture}
:capture: kernels
:auto: page-enter
jupyter kernelspec list --json | python -c "import json,sys; print(', '.join(json.load(sys.stdin)['kernelspecs']))"
```

The kernels on this machine are {var}`kernels`.
````

`kernel-execute` with `:capture:` does the same from Python, which also
works where there is no shell command to run. The page-enter trigger
needs the `auto-run` capability; without it the learner clicks the
action and the sentence fills in.
