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
  dimmed but can still be installed.

"Add from URL…" and "Open a directory…" run the corresponding commands,
and "Manage registries" opens the settings editor at the workshop
settings.

## Registries

A registry is a JSON index file. The `registries` setting lists where to
find them: `https` URLs, or paths relative to the JupyterLab root for a
classroom or offline index. The default points at the project's own
index, which lists the example workshops. Administrators typically set
the list through `overrides.json`:

```json
{
  "@educates/jupyterlab-workshop:panel": {
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
serving it needs no CORS headers.

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

The `urlpath` is `lab?workshop=…` URL-encoded.

## Installed workshops and the server

The list in the browser comes from `GET educates-workshop/workshops`,
which describes every directory under the workshops directory that holds
a `workshop.yaml`, reading `_workshop/source.json` and
`_workshop/state.json` for the source and progress. Registries are read
through `GET educates-workshop/registry?url=…`. Both refuse paths outside
the JupyterLab root.
