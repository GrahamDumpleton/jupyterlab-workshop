# Workshop libraries

A workshop library is one place for everything you have in the way of
workshops: the ones you install from collections, kept by collection,
the ones you make for yourself, and the repositories you are preparing
workshops in for others. It is a workshops directory with a registry
file, `library.json`, that holds your subscriptions, so what you are
subscribed to belongs to the library rather than to your JupyterLab
settings, and a second library elsewhere has its own.

A workshops directory without the registry is a plain one and works
exactly as [Finding and installing workshops](collections.md)
describes. Nothing becomes a library unless you make it one.

## Starting your library

```
jupyter workshop library
```

starts JupyterLab with your library as its root, creating it the first
time. The library is `~/Workshops` unless the `JUPYTER_WORKSHOP_LIBRARY`
environment variable names another directory, and a directory given on
the command line wins over both:

```
jupyter workshop library ~/learning
```

With the package installed [as a uv tool](getting-started.md#as-a-tool),
the command is `jupyter-workshop library`. `--init-only` creates the
library and stops without starting JupyterLab; the other options,
`--collection`, `--trust`, `--port`, `--no-browser`, `--fresh` and
`--token`, are those of [launch](cli.md#launch). See
[library](cli.md#library).

## What is in a library

```
<library>/
  library.json                    the registry
  installed/<collection>/<name>/  workshops installed from a collection
  personal/<name>/                your own workshops
  projects/<repository>/          repositories, cloned in or linked
```

The workshop browser shows the library in sections, in this order:

- **My workshops**, the workshops under `personal/`.

- **Projects**, a group for each project with the workshops in it.

- **Installed**, the downloaded workshops grouped by the collection
  they came from, as in a plain directory.

- **Available**, what the subscribed collections offer that is not
  installed.

A workshop directory directly in the library, as in a plain workshops
directory, is still listed: under its collection's heading when it was
downloaded, else under Other workshops.

## How a library is found

There is no separate setting for it: the library is the workshops
directory, `<JupyterLab root>/<workshopsDirectory>`, when that directory
holds `library.json`. The rule is the same however JupyterLab starts.

- `jupyter lab` started by hand has the current directory as its root,
  unless `--ServerApp.root_dir` names another, and `workshopsDirectory`
  defaults to `workshops`, so the library would be `./workshops`.

- `jupyter workshop launch` takes the root from `--root`, the current
  directory by default, and finds the same directory.

- `jupyter workshop library` makes its directory both the root and the
  library, by setting `workshopsDirectory` to `.` for the session.

`workshopsDirectory` set to `.`, or left empty, means the root itself.

## Subscriptions

In a library, subscribing in the Collections dialog, or with Subscribe
on a collection a launch link added, writes the registry rather than
your JupyterLab settings. Once the registry has a list of collections,
that list takes the place of the collections in the settings, the
shipped defaults and an administrator's included, just as a list in
your own settings does; until then, the settings apply. Catalogs work
the same way. Collections a launch link adds for the session come after
either, as always.

The command line changes the same lists:

```
jupyter workshop subscribe --library https://example.org/course/collection.json
jupyter workshop subscribe --library --catalog https://example.org/catalog.json
jupyter workshop unsubscribe --library https://example.org/course/collection.json
jupyter workshop list --library
```

`--library` means the library `jupyter workshop library` would open;
`--root` and `--directory` name any other. Outside a library,
subscriptions live in the JupyterLab settings, which only the browser
changes, so `subscribe` and `unsubscribe` refuse a plain directory.

## Installing into a library

Each collection's workshops go in a directory of their own under
`installed/`. Its name comes from the collection's `id`, so a
collection with the id `example.org/course` installs into
`installed/example.org-course/`; a collection with no id, or one whose
id another collection's directory already has, uses the short hash of
its location, as the clash suffix does outside a library. The choice
is recorded in the registry the first time a workshop of the
collection is installed, and kept, so a collection that later changes
its id or its index never moves anything. Since every collection has
its own directory, two collections that both offer a `git-basics` never
compete for one.

`jupyter workshop install COLLECTION --root DIR --directory .` installs
into a library the same way, and subscribes the library to the
collection, so the browser lists it and orders its workshops by it.
`jupyter workshop update` installs the newer versions collections offer,
and `jupyter workshop remove` removes installed workshops, as the
browser's Update and Remove buttons do.

## Your own workshops

The workshops under `personal/` are yours, so they open trusted without
the trust dialog, as long as they were not downloaded there. They open
as a learner sees them; author mode is a button away as usual. In a
library, the New Workshop dialog and a recording saved as a new
workshop suggest a directory under `personal/`.

## Projects

A project is a repository whose workshops the library shows, typically
one you are writing workshops in to publish. Cloning a repository into
`projects/` is enough:

```
git clone https://github.com/example-org/course-workshops ~/Workshops/projects/course-workshops
```

Its workshops are expected in its `workshops/` directory. A repository
that keeps them elsewhere, or one kept outside the library, is linked
in:

```
jupyter workshop project link ~/src/course-workshops
jupyter workshop project link ~/src/jupyterlab-workshop --workshops examples
jupyter workshop project list
jupyter workshop project unlink jupyterlab-workshop
```

Linking makes `projects/<name>` a symbolic link to the repository, or
a directory junction on Windows, which needs no special rights, and
records the project and its target in the registry. JupyterLab reaches
the repository through the link, and the extension accepts paths
behind it because the registry vouches for it; a link the registry
does not list is still treated as outside the JupyterLab root. These
commands use the default library unless `--root` or `--directory` name
another.

A project's workshops record their progress in `_workshop/` beside
their pages, inside the repository, so the repository should ignore
that directory; `project link` mentions it when the repository's
`.gitignore` does not. Remove on a project's workshop clears only that
progress, never the repository's files.

When a linked repository is deleted or moved, the project is shown as
missing in the browser, with its recorded path and an Unlink button,
and `project list` marks it. Unlinking removes the link and the entry,
never anything the link pointed to. A link deleted by hand while its
repository is still there is recreated the next time
`jupyter workshop library` starts.

## Making an existing directory a library

The browser offers "Make this a workshop library…" in a plain workshops
directory, on a JupyterLab server, when subscribing is allowed. It
shows what it will do and asks first:

- The registry is written with the collections and catalogs you
  subscribed to in your settings. The defaults and an administrator's
  lists are left to keep applying.

- Each downloaded workshop that recorded its collection moves into that
  collection's directory under `installed/`, its progress with it.

- A workshop with its own [isolated environment](environment.md) stays
  where it is, since the environment and its kernel hold paths a move
  would break, and so does the workshop that is open.

- Local directories, which the browser did not download, stay where
  they are.

`jupyter workshop library DIR --init-only` makes a directory a library
from the command line, without moving anything.

## Libraries and deployments

A deployment set up as the workshop repositories set up Binder,
Codespaces or a JupyterLite site has no `library.json`, so nothing
changes there: no new sections, no offer to make a library, and
installs go where they always have. The `library` entry in
[`disabledFeatures`](deploying.md#locking-down-a-deployment) goes
further and ignores a registry the workshops directory holds, and
`personal` hides the My workshops section. JupyterLite reads a library
the same way, through the browser's storage, but does not offer to make
one, since its subscriptions come from the site it was built as.

## The registry

`library.json` is plain JSON, written with two space indents:

```json
{
  "version": 1,
  "collections": ["https://example.org/course/collection.json"],
  "catalogs": [],
  "directories": {
    "https://example.org/course/collection.json": "example.org-course"
  },
  "projects": [
    {
      "name": "jupyterlab-workshop",
      "target": "/home/me/src/jupyterlab-workshop",
      "workshops": "examples"
    }
  ]
}
```

| Key           | Holds                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`     | Always `1`.                                                                                                                                   |
| `collections` | Subscribed collections in order. Absent, the settings apply; present, even empty, it takes their place.                                       |
| `catalogs`    | Subscribed catalogs, absent or present as for collections.                                                                                    |
| `directories` | The directory under `installed/` for each collection location, chosen at its first install.                                                   |
| `projects`    | Projects that need an entry: a linked one, with its `target`, or one whose workshops are not in `workshops/`, with its `workshops` directory. |

`jupyter workshop schema --library` prints its JSON schema, which is
also published at
<https://grahamdumpleton.github.io/jupyterlab-workshop/schemas/v1alpha1/library.schema.json>.
The browser and the command line both write the file, each reading it
just before writing so neither drops the other's change.
