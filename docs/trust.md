# Loading and trust

A workshop drives the learner's JupyterLab session: it runs commands in
terminals, writes files, executes code in kernels and changes the
interface. Before any of that happens the learner is told what the
workshop asks for and chooses how far to trust it. This page describes
where workshops come from, what capabilities are, how trust levels change
the behaviour of actions, and how a workshop is removed again.

## Sources

A workshop is opened from one of these sources:

- A local directory relative to the JupyterLab root, through the
  "Open Workshop…" command or the `defaultWorkshop` setting. The directory
  is used in place, which suits authoring.

- A git repository on a forge that serves archives, through the
  "Open Workshop from URL…" command. GitHub, GitLab, Codeberg and Gitea
  are recognised. A tree URL such as
  `https://github.com/owner/repo/tree/v1.2.0/workshops/git-basics` names
  the ref and the directory inside the repository. No `git` binary is
  needed: the server downloads the archive, checks its SHA-256, unpacks it
  guarding against path traversal, and places it under the
  `workshopsDirectory` setting (default `workshops`) in a directory named
  after the manifest's `name`.

- A direct `.zip` or `.tar.gz` URL, handled the same way.

- A registry entry chosen in the workshop browser, or a launch link in
  the JupyterLab URL, both of which resolve to one of the above; see
  [Finding and installing workshops](registry.md).

Downloaded workshops carry a `_workshop/source.json` record with the
source, the archive URL and its hash, so reopening the directory later
identifies it. The server endpoints are `POST educates-workshop/fetch`
and `DELETE educates-workshop/workshops?path=...`; both refuse paths
outside the JupyterLab root, and removal only deletes directories that
contain a `workshop.yaml`.

## Capabilities

Every action type needs a capability, listed in the
[action reference](actions.md). The manifest declares the capabilities
the workshop uses:

```yaml
capabilities:
  - terminal
  - write-files: [workspace]
  - network: [github.com, pypi.org]
  - kernel-exec
  - auto-run
```

| Capability         | Grants                                                               |
| ------------------ | -------------------------------------------------------------------- |
| `terminal`         | Running commands and typing into terminals.                          |
| `write-files`      | Creating and changing files and notebooks. Scopes below.             |
| `network`          | Downloading from the listed hosts (informational; checked by lint).  |
| `install-packages` | Creating the workshop's isolated environment (`environment-create`). |
| `kernel-exec`      | Running code in kernels, including background captures.              |
| `auto-run`         | Actions with `auto` or `cascade` options that run without a click.   |
| `ui-settings`      | Changing JupyterLab settings.                                        |

The `write-files` scopes are `workspace` (paths must stay inside the
workshop directory, the default), `home` and `any` (paths may reach
anywhere under the JupyterLab root; the contents API cannot go higher).

An action whose capability the manifest does not declare never runs, at
any trust level. It shows a "not allowed" badge in the panel and the trust
dialog lists the problem. The linter reports the same as an error, and
warns about declared capabilities that no page uses.

## The trust dialog

Opening a workshop shows a dialog with the source, the content hash (the
archive's SHA-256 for downloads, a hash of the manifest and pages for local
directories), the capabilities it declares and how many actions use each,
the number of automatic actions, and any lint findings, including the
danger heuristics: piping downloads into a shell, `sudo`, recursive
deletes outside the workshop, `eval`, executing base64-decoded content,
home directory paths, absolute paths in file actions, and hosts that are
not in the declared `network` list.

A workshop opened in author mode (see [Writing workshops in
JupyterLab](authoring.md)) is marked as the learner's own and is trusted
at every hash from then on, so editing it never brings the dialog back.
"Workshop: Remove…" forgets the mark along with the decision.

The learner picks a level:

| Level         | Behaviour                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trust         | Every declared capability is allowed, including automatic runs.                                                                                                                                                                                                                                  |
| Restricted    | `execute` types the command into the terminal without pressing Enter. File writes, editor changes, notebook changes, kernel execution, key presses and settings changes show what they will do and ask for confirmation. Automatic runs are skipped and logged as skipped. Everything else runs. |
| Ask each time | Actions with a capability other than `none` ask for confirmation, with an option to allow that capability for the rest of the workshop.                                                                                                                                                          |

A workshop that names an analytics sink in its manifest adds a checkbox,
off by default, asking whether progress may be reported to it; see
[Progress events](analytics.md).

Cancelling leaves the workshop closed. The decision is stored in the
JupyterLab state database keyed by source and hash, so the same content
opens again without asking, and a changed workshop asks again. The badge
in the panel header shows the current level; clicking it, or the
"Workshop: Change Trust Level…" command, reopens the dialog.

In restricted mode the panel marks affected actions: "types only",
"confirms" and "auto off". A confirmation for `file-write` shows a line
diff against the file's current content.

## Administrator policy

The `trustPolicy` setting, normally set through `overrides.json`, adjusts
the behaviour for every learner:

```json
{
  "@educates/jupyterlab-workshop:panel": {
    "defaultTrustLevel": "restricted",
    "trustPolicy": {
      "forcedLevel": null,
      "trustedSources": ["git:https://github.com/educates/", "local:examples/"],
      "disabledCapabilities": ["ui-settings"]
    }
  }
}
```

- `defaultTrustLevel` is the button selected by default in the dialog.

- `forcedLevel` applies one level to every workshop and skips the dialog.

- `trustedSources` lists source key prefixes that open as trusted without
  asking. Source keys look like `local:<directory>`,
  `git:<url>@<ref>/<subdir>` and `archive:<url>`.

- `disabledCapabilities` never run, whatever the learner chose; the
  affected actions are skipped with a message.

## Removing and resetting

"Workshop: Remove…" lists what it will do before doing it: delete the
workshop directory for downloaded workshops (for local directories only
the `_workshop` state directory is removed), restore any JupyterLab
settings the workshop changed with `settings-set`, unregister the kernel
of an [isolated environment](environment.md) it created, and forget the
trust decision. The workshop browser's Remove button does the same for
workshops that are not open.

"Workshop: Reset Progress…" forgets page progress, action results,
captured variables and the log, restores changed settings, and reopens
the workshop at its first page.

## Action log

Every action that ran, was downgraded, confirmed or skipped is recorded
with its time, page, type, description, trigger and result in
`_workshop/state.json` and shown by "Workshop: Show Action Log".
