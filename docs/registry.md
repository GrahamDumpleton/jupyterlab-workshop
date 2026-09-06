# Finding and installing workshops

Workshops reach learners in four ways: the workshop browser, a launch
link, the "Open Workshop from URL…" command, and a local directory. This
page covers the first two and the registry index files behind the
browser. Trust, downloading and removal are described in
[Loading and trust](trust.md).

## The workshop browser

"Browse Workshops" (in the launcher under Workshops, in the command
palette, and from the panel's launcher button) opens a main-area tab with
two sections:

- **Installed** lists every workshop directory under the
  `workshopsDirectory` setting (default `workshops`), with its source,
  how many pages are done, and Resume or Open and Remove buttons. The
  workshop that is open is marked.

- **Available** lists the workshops of every configured registry as
  cards showing the title, version, description, platforms, capabilities
  and duration. A search box matches names, titles, descriptions and
  tags; tag buttons narrow the list further. Install downloads the
  newest version, checks its hash when the registry gives one, and opens
  it. Cards for workshops that do not list the current platform are
  dimmed but can still be installed. A registry workshop that is already
  installed appears only under Installed, where its card offers an
  Update button when the registry lists a different version. When every
  registry workshop is installed, as in an image that ships the workshops
  its registry lists, the Available section and its search and tags are
  not shown at all.

"Add from URL…" and "Open a directory…" run the corresponding commands,
and "Manage registries" opens the settings editor at the workshop
settings.

Once a workshop is opened, from the browser or anywhere else, the browser
tab closes and the workshop's instructions and [layout](layouts.md) take
over. It stays open while a workshop that is already open is browsed
alongside.

### Starting in the browser

An image that offers a choice of workshops can start JupyterLab in the
browser rather than at the launcher. With the `browseOnStart` setting
true, a session that has no workshop to restore, no `defaultWorkshop` and
no launch link opens the browser in place of the launcher and collapses
both sidebars, so the learner sees only the catalogue until they pick a
workshop; the instructions panel then appears on the right. Pointing
`workshopsDirectory` at a directory of workshops shipped in the image
lists them as installed and ready to open without a download.

A launch link can do the same for one session with a `registry`
parameter naming an index by URL or by a path relative to the JupyterLab
root: `/lab?registry=https://example.org/workshops/index.json`. The
registry is shown alongside the configured ones for that session only.

## Registries

A registry is a JSON index file. The `registries` setting lists where to
find them: `https` URLs, or paths relative to the JupyterLab root for a
classroom or offline index. The default points at the project's own
index, which lists the example workshops. Administrators typically set
the list through `overrides.json`:

```json
{
  "@jupyterlab-workshop/labextension:panel": {
    "registries": [
      "https://example.org/workshops/index.json",
      "shared/registry.json"
    ],
    "trustPolicy": {
      "trustedSources": ["git:https://github.com/example-org/"]
    }
  }
}
```

The server reads the index and hands it to the browser, so the host
serving it needs no CORS headers. In [JupyterLite](lite.md) the browser
reads it directly, so the host must send them, or the index can be a
file shipped inside the site and named by a relative path.

### Index format

```json
{
  "version": 1,
  "title": "Example workshops",
  "workshops": [
    {
      "name": "git-basics",
      "title": "Git from the command line",
      "description": "Learn init, add, commit, diff, branch and merge.",
      "tags": ["git", "cli"],
      "platforms": ["linux", "macos", "windows"],
      "capabilities": ["terminal", "write-files:workspace", "kernel-exec"],
      "duration": "30m",
      "versions": [
        {
          "version": "1.2.0",
          "source": {
            "git": "https://github.com/example-org/workshops",
            "ref": "v1.2.0",
            "subdir": "git-basics"
          },
          "sha256": "…"
        }
      ]
    }
  ]
}
```

Each version names a source: a git repository (`git`, `ref`, `subdir`)
on a forge that serves archives, or a direct `archive` URL. Versions are
listed newest first and the first is what Install fetches. A `sha256` is
optional but recommended: the download is refused when the archive's
hash differs. `jupyter workshop schema --registry` prints the full JSON
schema.

### Building an index

`jupyter workshop publish` writes an archive, its hash and a
`<name>-<version>.registry.json` entry for a workshop. `jupyter workshop
registry` merges such entries into an index, adding versions to entries
that exist already:

```
jupyter workshop publish git-basics --url https://example.org/w/git-basics-1.2.0.tar.gz
jupyter workshop registry index.json dist/git-basics-1.2.0.registry.json --title "Our workshops"
```

Host `index.json` and the archives anywhere that serves files over
HTTPS, such as GitHub Pages or an object store, and list the index URL
in the `registries` setting.

## Several workshops in one repository

A repository can hold a set of related workshops side by side, each in
its own directory, with one index at the root that lists them all:

```
workshops-repo/
  registry.json
  binder/
    requirements.txt
    postBuild
  workshops/
    git-basics/
      workshop.yaml
      pages/
    pandas-intro/
      workshop.yaml
      pages/
```

`jupyter workshop index` writes and updates `registry.json` from the
manifests, giving each entry a git source pointing at its directory in
the repository, so no archives are built or published:

```
jupyter workshop index workshops --repo https://github.com/example-org/workshops --ref main
```

Run from the checkout, the repository URL and branch are read from git
and can be left out, and the paths in the index are relative to the
checkout root; give `--ref` a tag when a course is pinned to a release. Commit the index with the workshops. Anyone can then add the
raw URL of `registry.json` to their `registries` setting, or start a
session in it with a `registry` launch link, and Install fetches each
workshop from the forge.

The same checkout serves as a [Binder](https://mybinder.org) image. Add
`binder/requirements.txt` installing `jupyterlab` and
`jupyterlab-workshop`, and a `binder/postBuild` that writes an
`overrides.json` such as this into `$NB_PYTHON_PREFIX/share/jupyter/lab/settings/`:

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
      "registries",
      "remove",
      "author"
    ]
  }
}
```

The session then starts in the browser with every workshop in the
checkout listed as installed and ready to open, with no download and no
trust dialog, since the visitor chose the repository. The
`disabledFeatures` list, described [below](#locking-down-a-deployment),
keeps the learner to those workshops. A launch link of
`urlpath=lab%3Fregistry%3Dregistry.json` gives the same start without
the override, apart from the trust dialog, and
`urlpath=lab%3Fworkshop%3Dworkshops%2Fgit-basics` opens one workshop
directly. This repository's own `examples/` directory, `registry/` index
and `binder/` files follow this pattern.

## Locking down a deployment

An image built for a course usually wants learners to run the workshops
it supplies and nothing else: no opening other directories or URLs, no
editing, and no removing a workshop they may need again. The
`disabledFeatures` setting, set through `overrides.json` like the trust
policy, lists parts of the extension to remove. Each key removes every
entry point for the feature at once: the buttons in the panel header
and the browser, the launcher card, the command in the palette and the
matching launch link parameter.

| Key              | Removes                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-directory` | The folder button, "Open a directory" in the browser, "Open Workshop…" and "Open Workshop Path…", the file browser context menu item, and `workshop=<path>` launch links naming a directory outside the workshops directory. |
| `open-url`       | The download button, "Add from URL…", "Open Workshop from URL…", and `workshop=<url>` launch links for sources no configured registry lists.                                                                                 |
| `registries`     | "Manage registries" and the `registry` launch link parameter, so only the `registries` setting counts.                                                                                                                       |
| `available`      | The Available section of the browser and its search and tag filters, leaving only the installed workshops.                                                                                                                   |
| `remove`         | The Remove buttons and "Workshop: Remove…".                                                                                                                                                                                  |
| `close`          | The close button and "Close Workshop".                                                                                                                                                                                       |
| `browse`         | The browse button, the launcher card and "Browse Workshops", for an image that runs a single workshop.                                                                                                                       |
| `author`         | The edit button, author mode and its commands, and the "New Workshop" launcher card. A workshop marked as the learner's own opens as a learner would see it.                                                                 |

The workshops under `workshopsDirectory` stay openable with
`open-directory` disabled, from the browser or a `workshop=<path>` launch
link, and the browser's Install and Update buttons keep working with
`open-url` disabled, because those sources come from the registries.
The Binder recipe above disables everything except browsing, the
Available section and closing, so learners can move between the
supplied workshops but not bring in others or change them.

These settings shape the interface rather than secure it: a learner
with a terminal or the browser console can still reach the files and
commands. Use the [trust policy](trust.md#administrator-policy) to
limit what workshops may do.

### Restarting a workshop

The first time a workshop is opened, before any action runs, its files
are archived as the reserved `pristine` checkpoint under `_workshop`.
"Workshop: Restart…", the restart button in the panel header and the
Restart button on an installed workshop's card put those files back,
deleting anything added to the directory since, forget all progress,
close the documents and terminals the workshop had open, and reopen the
workshop at its first page with its layout applied afresh. This works offline, for
workshops shipped in an image or opened from a local directory, and in
JupyterLite; it is the way to start over in a locked-down deployment
where Remove is unavailable. Update, shown on an installed workshop's
card when the registry lists a different version, fetches that version
from the registry and replaces the files, and remains available.

Two limits apply. Restart only covers files inside the workshop
directory, so a workshop that writes elsewhere, for example into the
home directory, is not undone. And a workshop first opened by a version
of the extension before the snapshot existed has none to restore; a
restart then forgets the progress, keeps the files and says so, and the
reopen takes a snapshot of the files as they are.

## Launch links

A JupyterLab URL with a `workshop` query parameter fetches and opens a
workshop as soon as JupyterLab has started:

```
https://hub.example.org/user/ada/lab?workshop=https://github.com/example-org/workshops&ref=v1.2.0&subdir=git-basics&var.repo_dir=sandbox
```

- `workshop` is a repository URL, a forge tree URL, an archive URL, or a
  directory relative to the JupyterLab root (for images that ship their
  workshops).

- `ref` and `subdir` select a git ref and directory, as for the
  "Open Workshop from URL…" command; `sha256` pins the archive hash.

- `var.<name>=<value>` sets workshop variables above the manifest
  defaults but below anything the learner enters.

The parameters are removed from the address bar once handled, so a
reload does not fetch again. The trust dialog still appears unless the
administrator's policy settles it, which is the usual arrangement for a
classroom: `forcedLevel` or a `trustedSources` prefix for the
organisation's repositories.

Launch links compose with services that start JupyterLab from a URL. On
[mybinder.org](https://mybinder.org) a single repository that installs
this package can open any workshop:

```
https://mybinder.org/v2/gh/example-org/launcher/main?urlpath=lab%3Fworkshop%3Dhttps%3A%2F%2Fgithub.com%2Fexample-org%2Fworkshops%26subdir%3Dgit-basics
```

The `urlpath` is `lab?workshop=…` URL-encoded; `lab?registry=…` works
the same way and lands in the browser instead. This repository's own
`binder/` directory is an example: `runtime.txt` selects a Python the
package supports, `requirements.txt` installs JupyterLab and the package,
and `postBuild` writes a settings override that starts in the browser
with the examples listed as installed, and trusts them. A workshop
repository can carry the same files and a launch badge, with the
`workshop` parameter naming a directory in the checkout rather than a
URL.

## Installed workshops and the server

The list in the browser comes from `GET jupyterlab-workshop/workshops`,
which describes every directory under the workshops directory that holds
a `workshop.yaml`, reading `_workshop/source.json` and
`_workshop/state.json` for the source and progress. Registries are read
through `GET jupyterlab-workshop/registry?url=…`. Both refuse paths outside
the JupyterLab root.
