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
| `remove`         | The Remove buttons and "Workshop: Remove…".                                                                                                                                                                                  |
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

```json
{
  "@jupyterlab-workshop/labextension:panel": {
    "defaultWorkshop": "",
    "browseOnStart": true,
    "workshopsDirectory": "workshops",
    "trustPolicy": { "forcedLevel": "trusted" },
    "disabledFeatures": [
      "open-directory",
      "open-url",
      "collections",
      "catalogs",
      "remove",
      "author"
    ]
  }
}
```

The session then starts in the browser with every workshop in the
checkout listed as installed and ready to open, with no download and no
trust dialog, since the visitor chose the repository. The disabled
features keep the learner to those workshops but leave browsing and
closing, so they can move between the supplied workshops; there are
no subscriptions, so there is nothing more to install, and `available` need not
be disabled. A launch link of `urlpath=lab%3Fworkshop%3Dworkshops%2Fgit-basics`
opens one workshop directly, and `urlpath=lab%3Fcollection%3Dcollection.json`
gives the browser start without the override, apart from the trust
dialog. This repository's own `examples/` directory, its index under
`collections/examples/` and its `binder/` files follow this pattern, and
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

## JupyterHub

Under JupyterHub the same overrides apply, placed in the image or the
user environment. Workshops opened from a launch link land under each
user's `workshopsDirectory`, and Restart and Remove act only on that
user's copy. Progress events can carry the JupyterHub user name; see
below.

## Reporting progress

Every workshop writes its progress events to `_workshop/events.jsonl`
in its own directory, and a learner can export that file. A deployment
that wants every learner's events without asking sets the `analytics`
setting:

```json
{
  "@jupyterlab-workshop/labextension:panel": {
    "analytics": {
      "sink": "https://workshops.example.org/events",
      "identity": "hub"
    }
  }
}
```

`sink` is a URL that receives batches of events as JSON lines by POST.
`identity` is `none` (the default) or `hub`, which adds the
`JUPYTERHUB_USER` name to every event as `user`. Batches are posted by
the server, so the sink needs no CORS headers, and a few lines of any
web framework that appends the body to a file is enough; in JupyterLite
the browser posts them and the sink must allow the site's origin.
Delivery is best effort. [Progress events](analytics.md) lists the
events and what they never contain.

## A static site

Where no server can be run at all, a JupyterLite site carries the
workshops and runs in the browser, with the trust level, the default
workshop and the subscribed collections and catalogs set at build time;
see [Publishing
workshops](publishing.md#a-jupyterlite-site) for building and hosting
one and [JupyterLite](lite.md) for what workshops can do there.
