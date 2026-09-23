# Deploying workshops

This page is for whoever sets up the JupyterLab that learners use: a
Binder repository, a JupyterHub, a classroom image, or a static
JupyterLite site. It covers starting learners in the right place,
settling trust for them, keeping them to the workshops supplied,
reporting their progress, and the files a Binder repository needs. The
settings named here are listed in the [settings reference](settings.md)
and set through `overrides.json`, the JupyterLab file for site-wide
setting overrides, under the key `@jupyterlab-workshop/labextension:panel`.

## Starting in the browser

An image that offers a choice of workshops can start JupyterLab in the
workshop browser rather than at the launcher. With `browseOnStart` true,
a session that has no workshop to restore, no `defaultWorkshop` and no
launch link opens the browser in place of the launcher and collapses
both sidebars, so the learner sees only the catalogue until they pick a
workshop; the instructions panel then appears. Pointing
`workshopsDirectory` at a directory of workshops shipped in the image
lists them as installed and ready to open without a download.

A launch link can do the same for one session with a `collection` or
`catalog` parameter naming one by URL or by a path relative to the
JupyterLab root: `/lab?collection=https://example.org/python/collection.json`
or `/lab?catalog=https://example.org/catalog.json`. The collection or
catalog is added for that session only, alongside the subscribed
ones, and the browser offers Subscribe to make it stay;
`/lab?workshop=<path or URL>` opens one workshop directly; see
[launch links](collections.md#launch-links).

## Settling trust

Learners see the trust dialog the first time they open each workshop
unless the deployment settles it. The `trustPolicy` setting holds the
administrator's decisions:

```json
{
  "@jupyterlab-workshop/labextension:panel": {
    "defaultTrustLevel": "restricted",
    "trustPolicy": {
      "forcedLevel": null,
      "trustedSources": [
        "git:https://github.com/example-org/",
        "local:workshops/"
      ],
      "disabledCapabilities": ["ui-settings"]
    }
  }
}
```

- `defaultTrustLevel` is the button selected by default in the dialog.

- `forcedLevel` applies one level to every workshop and skips the
  dialog. `trusted` is the usual choice for an image whose workshops the
  operator chose.

- `trustedSources` lists source key prefixes that open as trusted
  without asking. Source keys look like `local:<directory>`,
  `git:<url>@<ref>/<subdir>` and `archive:<url>`, so a prefix can name
  an organisation's repositories or a directory in the image.

- `disabledCapabilities` never run, whatever the learner chose; the
  affected actions are skipped with a message.

## Locking down a deployment

An image built for a course usually wants learners to run the workshops
it supplies and nothing else: no opening other directories or URLs, no
editing, and no removing a workshop they may need again. The
`disabledFeatures` setting lists parts of the extension to remove. Each
key removes every entry point for the feature at once: the buttons in
the panel header and the browser, the launcher card, the command in the
palette and the matching launch link parameter.

| Key              | Removes                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-directory` | The folder button, "Open a directory" in the browser, "Open Workshop…" and "Open Workshop Path…", the file browser context menu item, and `workshop=<path>` launch links naming a directory outside the workshops directory. |
| `open-url`       | The download button, "Add from URL…", "Open Workshop from URL…", and `workshop=<url>` launch links for sources no subscribed collection lists.                                                                               |
| `collections`    | Subscribing to and unsubscribing from collections: the Collections tab of the dialog, Subscribe, and the `collection` launch link parameter, so only the `collections` setting counts.                                       |
| `catalogs`       | The same for catalogs: the Catalogs tab, "Collections you can subscribe to", and the `catalog` launch link parameter, so only the `catalogs` setting counts.                                                                 |
| `available`      | The Available section of the browser and its search and tag filters, leaving only the installed workshops; for an image whose subscribed collection offers more than the image should let learners install.                  |
| `install-all`    | The "Install all…" button and the "Remove all" menu item on a collection's heading in the browser, leaving single installs and removes, for a shared or metered machine where a bulk download is unwelcome.                  |
| `remove`         | The Remove buttons, "Workshop: Remove…", and "Remove all" on a collection's heading.                                                                                                                                         |
| `close`          | The close button and "Close Workshop".                                                                                                                                                                                       |
| `browse`         | The browse button, the launcher card and "Browse Workshops", for an image that runs a single workshop.                                                                                                                       |
| `author`         | The edit button, author mode and its commands, and the "New Workshop" launcher card. A workshop marked as the learner's own opens as a learner would see it.                                                                 |

The workshops under `workshopsDirectory` stay openable with
`open-directory` disabled, from the browser or a `workshop=<path>` launch
link, and the browser's Install and Update buttons keep working with
`open-url` disabled, because those sources come from the subscribed
collections.
Restart stays available whatever is disabled, since it is how a learner
starts over when Remove is gone; see [Using
workshops](using.md#starting-over-and-clearing-up).

These settings shape the interface rather than secure it: a learner
with a terminal or the browser console can still reach the files and
commands. Use the trust policy above to limit what workshops may do.

## A welcome message

A deployment can greet the learner with a message when JupyterLab
starts, before they pick a workshop: what the workshops are for, and
whatever the host needs saying, such as how to end a Binder session.
The `welcome` setting names a Markdown file by its path relative to
the JupyterLab root, and the file is shown in a dialog once JupyterLab
has restored, over the browser or the workshop that opened. A
level-one heading on the file's first line becomes the dialog's title;
without one the title is "Welcome". The rest is rendered as a workshop
page is, though actions have nothing to act on there and are best left
out.

The dialog is shown once per browser for the server, so a reload does
not repeat it, but a new Binder session, which is a new server, does.
"Workshop: Show Welcome Message" in the command palette shows it again.
A launch link can name a file instead, with `welcome=<path>`, which is
shown every time the link is used and takes the place of the setting
for that session; see [launch links](collections.md#launch-links).

Nothing is added to the message: what to say about the platform is the
deployment's to decide, which is why the file belongs with the
deployment's other files, such as a Binder repository's `binder/`
directory, rather than in a collection.

## A Binder repository

A repository holding workshops can serve as a
[Binder](https://mybinder.org) image, so a single link starts a
JupyterLab with the workshops installed and trusted. It needs:

- `binder/requirements.txt` installing `jupyterlab` and
  `jupyterlab-workshop`, pinned to a version, since Binder caches the
  image it builds for a commit.

- `binder/runtime.txt` selecting a Python the package supports.

- `binder/postBuild`, a script that writes an `overrides.json` into
  `$NB_PYTHON_PREFIX/share/jupyter/lab/settings/`:

- optionally `binder/welcome.md`, a [welcome message](#a-welcome-message)
  introducing the workshops and saying how to end the session, which
  the override names in `welcome`:

```json
{
  "@jupyterlab-workshop/labextension:panel": {
    "defaultWorkshop": "",
    "browseOnStart": true,
    "workshopsDirectory": "workshops",
    "welcome": "binder/welcome.md",
    "trustPolicy": { "forcedLevel": "trusted" },
    "disabledFeatures": [
      "open-directory",
      "open-url",
      "collections",
      "catalogs",
      "remove",
      "author"
    ]
  },
  "@jupyterlab/apputils-extension:notification": {
    "fetchNews": "false"
  }
}
```

The session then starts in the browser with every workshop in the
checkout listed as installed and ready to open, with no download and no
trust dialog, since the visitor chose the repository. The second block
is not the extension's; see [the Jupyter news
prompt](#the-jupyter-news-prompt). An image built
from a published collection rather than a checkout can fetch the
workshops at build time instead, with
`jupyter workshop install https://example.org/collection.json --root .`
in `postBuild` or a Dockerfile; see [the CLI](cli.md#install). The disabled
features keep the learner to those workshops but leave browsing and
closing, so they can move between the supplied workshops; there are
no subscriptions, so there is nothing more to install, and `available` need not
be disabled. A launch link of `urlpath=lab%3Fworkshop%3Dworkshops%2Fgit-basics`
opens one workshop directly, and `urlpath=lab%3Fcollection%3Dcollection.json`
gives the browser start without the override, apart from the trust
dialog. The [showcase repository](https://github.com/GrahamDumpleton/jupyterlab-workshop-showcase) follows this pattern,
with its workshops under `workshops/`, its index at the root and its
`binder/` files, and
[Publishing workshops](publishing.md#several-workshops-in-one-repository)
covers building the index.

An image meant to show off a catalog does the opposite: it subscribes
to nothing and disables nothing, and its launch link carries the
catalog, `urlpath=lab%3Fcatalog%3D<encoded url>`, so the visitor lands
in the browser with the catalog's collections on offer and can
subscribe to and install what they like.

The Finish dialog offers to shut the session down when the host is
Binder, which the extension recognises from the environment variables
Binder sets.

## The Jupyter news prompt

JupyterLab asks, the first time it starts for a user, whether to fetch
official Jupyter news. On a Binder launch, where every session is a
fresh container, that question is the first thing a visitor sees, ahead
of the welcome message and the workshop browser. The setting behind it
belongs to JupyterLab's notification plugin, not to the extension, and
an override turns it off:

```json
{
  "@jupyterlab/apputils-extension:notification": {
    "fetchNews": "false"
  }
}
```

The value is the string `"false"`; `"true"` fetches the news without
asking, and the default `"none"` asks. An override is a default, not a
user setting, so someone who has already answered in their own
JupyterLab keeps their answer. `jupyter workshop launch`, `lite` and
`test` write this block into the overrides they produce, since each is
a deliberate workshop run; a deployment that starts JupyterLab some
other way, as Binder, a dev container or a JupyterHub image does, adds
the block to its own `overrides.json` beside the extension's settings,
as the Binder example above does.

## JupyterHub

Under JupyterHub the same overrides apply, placed in the image or the
user environment. Workshops opened from a launch link land under each
user's `workshopsDirectory`, and Restart and Remove act only on that
user's copy. Progress events can carry the JupyterHub user name; see
below. A hub whose single-user servers get their kernels from a Kernel
Gateway or Enterprise Gateway is not supported; see
[Known limitations](limitations.md#remote-kernels-kernel-gateway-and-enterprise-gateway).

## Reporting progress

Every workshop writes its progress events to `_workshop/events.jsonl`
in its own directory, and a learner can export that file. A deployment
that wants every learner's events without asking sets the `analytics`
setting:

```json
{
  "@jupyterlab-workshop/labextension:panel": {
    "analytics": {
      "sink": "https://analytics.example.org/events",
      "token": "eyJhbGciOi...",
      "labels": { "deployment": "spring-cohort" },
      "identity": "hub"
    }
  }
}
```

`sink` is a URL that receives batches of events as JSON lines by POST.
`token` is sent with every batch as a bearer credential in the
`Authorization` header, and `labels` are stamped on every event so a
service can slice by deployment, course or term. `identity` is `none`
(the default) or `hub`, which adds the `JUPYTERHUB_USER` name to every
event as `user`. A sink set here applies to every workshop and takes
precedence over any `analytics` block a subscribed collection or a
workshop manifest declares. Delivery is best effort. [Progress
events](analytics.md) lists the events, the block's rules and what
events never contain.

Where the setting goes, and what identity it can carry, depends on the
host:

- **JupyterHub.** Put the setting in the singleuser image's
  `overrides.json` or a shared settings directory. `identity: hub`
  names each learner, and the sink may sit inside the cluster, reached
  over the cluster network, since the user's server posts the batches.
  The token is private to the operator and is a real credential.

- **Binder.** Write the setting into `overrides.json` from
  `binder/postBuild`, the way the showcase repository writes its other
  settings. Sessions are anonymous, so there is no identity to carry,
  and the token sits in a public repository, so a sink treats it as
  routing rather than a secret.

- **GitHub Codespaces.** Put the setting in the devcontainer image.
  The codespace's server posts the batches; events report `host` as
  `codespaces`, and a stopped and resumed codespace is a new instance,
  so a workshop in progress asks whether to restart or continue.

- **JupyterLite.** Build the setting into the site, from a settings
  file given to `jupyter workshop lite --settings`. There is no server,
  so the browser posts the batches and the sink must allow cross-origin
  requests from the site's origin, including the `Authorization`
  header. The browser's preflight carries no header, so the token is
  also sent on the sink's address as `?token=`, which is where a sink
  that ties origins to tokens looks for it. The token is public with
  the site. Such a site is usually built with `--trust trusted` and so
  shows no trust dialog; say that progress is reported in its welcome
  message (`--welcome`).

- **A standalone JupyterLab.** The setting lives in the user's own
  settings or an install's `overrides.json`, with whatever secrecy the
  user gives it. Without the setting, a collection's or a workshop's own
  block applies once the learner opts in from the trust dialog.

## A static site

Where no server can be run at all, a JupyterLite site carries the
workshops and runs in the browser, with the trust level, the default
workshop or the workshop browser to start in, the subscribed
collections and catalogs, a welcome message and any other settings
fixed at build time; see [Publishing
workshops](publishing.md#a-jupyterlite-site) for building and hosting
one and [JupyterLite](lite.md) for what workshops can do there.
