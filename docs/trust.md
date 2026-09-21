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
  "Open Workshop from URL…" command. GitHub and GitLab are recognised
  by host, and any other host is assumed to serve archives the way
  Gitea, Codeberg and Forgejo do. A tree URL such as
  `https://github.com/owner/repo/tree/v1.2.0/workshops/git-basics` names
  the ref and the directory inside the repository. No `git` binary is
  needed: the server downloads the archive, checks its SHA-256, unpacks it
  guarding against path traversal, and places it under the
  `workshopsDirectory` setting (default `workshops`) in a directory named
  after the manifest's `name`.

- A direct `.zip` or `.tar.gz` URL, handled the same way.

- A collection entry chosen in the workshop browser, or a launch link in
  the JupyterLab URL, both of which resolve to one of the above; see
  [Finding and installing workshops](collections.md).

Downloaded workshops carry a `_workshop/source.json` record with the
source, the archive URL and its hash, so reopening the directory later
identifies it. The server endpoints are `POST jupyterlab-workshop/fetch`
and `DELETE jupyterlab-workshop/workshops?path=...`; both refuse paths
outside the JupyterLab root, and removal only deletes directories that
contain a `workshop.yaml`.

## Capabilities

Every action type needs a capability, listed in the
[action reference](actions.md). The manifest declares the capabilities
the workshop uses:

```yaml
capabilities:
  - terminal
  - write-files
  - kernel-exec
  - auto-run
```

| Capability         | Grants                                                               |
| ------------------ | -------------------------------------------------------------------- |
| `terminal`         | Running commands and typing into terminals.                          |
| `write-files`      | Creating and changing files and notebooks in the workspace.          |
| `install-packages` | Creating the workshop's isolated environment (`environment-create`). |
| `kernel-exec`      | Running code in kernels, including background captures.              |
| `auto-run`         | Actions with `auto` or `cascade` options that run without a click.   |
| `ui-settings`      | Changing settings of the editor the workshop runs in.                |

Each capability is a name; none carries a value. Every one gates an
action type, so the dialog shows only what the extension enforces. There
is no network capability: `terminal` already says that commands run,
and a command can reach anything the machine can, which no list of
hosts could honestly narrow. Write actions are confined to the
workshop's [workspace](concepts.md#the-workspace), and the workshop's
own files, the manifest, the pages, the shipped `files/` and the
requirements file, are read-only to actions: an action that names one,
or a path outside the workspace, is refused with a "not allowed" badge,
and lint reports it as an error.

An action whose capability the manifest does not declare never runs, at
any trust level. It shows a "not allowed" badge in the panel and the trust
dialog lists the problem. The linter reports the same as an error, and
warns about declared capabilities that no page uses.

## The trust dialog

Opening a workshop shows a dialog with the source, the content hash (the
archive's SHA-256 for downloads, a hash of the manifest and pages for local
directories and for downloads made by [JupyterLite](lite.md), which
fetches files one by one and so cannot check a collection's archive hash),
where it will run, the capabilities it declares and how many actions use
each, the number of automatic actions, and any lint findings, including
the danger heuristics: piping downloads into a shell, `sudo`, recursive
deletes outside the workshop, `eval`, executing base64-decoded content,
home directory paths, and absolute paths in file actions.

The capabilities say what a workshop may do; where it runs decides how
far that reaches. So above the capabilities the dialog names the host
the session was [detected](platforms.md) to be on and says, in the same
order each time, where commands and code execute, where files go and
what the network reaches:

| Host                            | What the dialog says                                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The computer running JupyterLab | Commands and code run directly on it, as the account JupyterLab was started by, with all of that account's files, credentials and networks, and what they change outside the workshop folder stays changed.                        |
| A container                     | Commands and code see the container's files and the folders shared into it, with the network the container was given; whether files outlive it depends on how it was started.                                                      |
| Binder                          | A temporary container on a public service: files are deleted when the session ends or sits idle, the network is the public internet within the operator's limits, and passwords or tokens should not be entered.                   |
| GitHub Codespaces               | A container on a virtual machine hosted by GitHub: files stay until the codespace is deleted, the internet is fully reachable, the codespace's GitHub token lets commands act on its repository, and running time counts as usage. |
| JupyterHub                      | A server run by someone else, as the hub user: files go to that user's storage on the hub, which may hold other work, and the network is whatever the operator allows, which can include an internal one.                          |
| This browser (JupyterLite)      | Everything stays in the browser tab: files are in the browser's storage for the site, and code runs in the browser's sandbox with no more reach than a web page.                                                                   |

The first of these is never called the learner's own computer. With no
hosting service detected, all the extension knows is that code runs
where JupyterLab was started, which is as true of a server reached over
a tunnel as of a laptop. When the page was loaded from anything but the
loopback address, the dialog shows that host name beside the host.

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

A workshop whose manifest names an analytics sink, or one listed by a
subscribed collection whose index names one, adds a checkbox, off by
default, asking whether progress may be reported to it, naming the
collection when the sink is the collection's. No checkbox appears when
the deployment's own `analytics` setting names a sink, since that
applies to every workshop without asking; see [Progress
events](analytics.md).

Cancelling leaves the workshop closed. The decision is stored in the
JupyterLab state database keyed by source and hash, so the same content
opens again without asking, and a changed workshop asks again. The state
database is shared by every JupyterLab server the same user runs, but a
local workshop is named by its path under the server's root, so
decisions are kept per server: a workshop trusted under one root asks
again under another, and so does one marked as your own. The badge
in the panel header shows the current level; clicking it, or the
"Workshop: Change Trust Level…" command, reopens the dialog.

In restricted mode the panel marks affected actions: "types only",
"confirms" and "auto off". A confirmation for `file-write` shows a line
diff against the file's current content.

## Administrator policy

The `trustPolicy` setting, normally set through `overrides.json`, can
force a level for every workshop, trust sources by prefix, and disable
capabilities outright; see [settling trust](deploying.md#settling-trust)
and the [settings reference](settings.md).

## Removing, resetting and the log

Restart, Reset Progress and Remove, what closing a workshop cleans up,
and the action log are described for learners under
[Using workshops](using.md#starting-over-and-clearing-up). The log is
kept in `_workshop/state.json` and shown by "Workshop: Show Action Log".
