# Workshop libraries

A workshop library is one place for everything you have in the way of
workshops: the ones you install from collections, kept by collection,
the ones you make for yourself, and the courses you are preparing for
others. It is a workshops directory with a registry file,
`library.json`, that holds your subscriptions, so what you are
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

A library keeps what you made apart from what you installed:

```
<library>/
  library.json                               the registry
  personal/
    workshops/<name>/                        your own workshops, one directory each
    courses/<name>/                          your courses, repositories kept here or linked in
  installed/
    collections/<collection>/<name>/         workshops installed from a collection
    workshops/<name>-<hash>/                 workshops downloaded from a URL of their own
```

A workshop is one directory with a `workshop.yaml` at its top. A course
is a repository of workshops with the indexes that publish them: one or
more collections, with a catalog over them when there are several, so
a course is the repository form of a collection rather than another
name for one. Both are yours, so git is where their history lives;
nothing under `installed/` is.

The workshop browser shows the library in sections, in this order:

- **My workshops**, the workshops under `personal/workshops/`.

- **My courses**, a group for each course with the workshops in it, in
  the order the course's own index gives.

- **Installed**, the downloaded workshops grouped by the collection
  they came from, as in a plain directory, with those downloaded from a
  URL of their own under Other workshops.

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

Nothing is ever downloaded to the top of a library, or into
`personal/`, where your own directories are.

Each collection's workshops go in a directory of their own under
`installed/collections/`, named from the collection's `id` followed by
a short hash of its location, so a collection with the id
`example.org/course` installs into something like
`installed/collections/example.org-course-858442f/`. A collection with
no usable id gets the hash alone. The choice is recorded in the
registry the first time a workshop of the collection is installed, and
kept, so a collection that later changes its id or its index never
moves anything. Since every collection has its own directory, two
collections that both offer a `git-basics` never compete for one.

A workshop downloaded from a URL of its own, with "Open Workshop from
URL…" or a launch link that names no collection, goes under
`installed/workshops/`, named after the workshop followed by a short
hash of where it came from: the URL and the directory in it, not the
branch or revision. Downloading the same source again, at any revision,
replaces it in place, and a workshop of the same name from anywhere else
gets a directory of its own. The hashes are there to keep names apart;
nothing asks you to choose or type them.

A download only ever replaces a directory that holds a download of the
same workshop, from the same source or installed from the same
collection. Anything else in the way, a workshop of your own above all,
is left alone and the download refused, in a library or not.

`jupyter workshop install COLLECTION --root DIR --directory .` installs
into a library the same way, and subscribes the library to the
collection, so the browser lists it and orders its workshops by it.
`jupyter workshop update` installs the newer versions collections offer,
and `jupyter workshop remove` removes installed workshops, as the
browser's Update and Remove buttons do.

## Your own workshops

The workshops under `personal/workshops/` are yours, so they open
trusted without the trust dialog, as long as they were not downloaded
there. They open as a learner sees them; author mode is a button away
as usual. In a library, the New Workshop dialog and a recording saved
as a new workshop suggest a directory under `personal/workshops/`, and
each workshop made there, by the dialog, by Workshop Author or by
`jupyter workshop init`, starts as a git repository of its own, with
nothing committed until you, or the agent when you tell it, commit.

Remove on one of them asks which you mean, since the directory has no
other copy: Clean up deletes only the progress recorded in it, so the
workshop stays and starts afresh, much as Restart does; Delete deletes
the directory and everything in it. "Workshop: Remove…" on an open
personal workshop offers the same choice, and `jupyter workshop remove
--delete` is the command line's Delete.
[Workshop Author](authoring.md#workshop-author), the AI agent, writes
the workshops it creates there too, and works on the workshops under
`personal/workshops/` and on courses, never on downloaded ones.

A card of your own also has Show files, which takes the file browser
into the workshop's directory, where the browser's own menus give you a
terminal or a launcher there, Move to course…, which moves the workshop
into one of your [courses](#courses), and Publish…, which asks whether
to publish it as a [gist](publishing.md#a-workshop-in-a-gist) or to a
[GitHub repository](publishing.md#a-repository-on-github) and whether
publicly, and sends nothing until you press Publish; a new gist is
secret and a new repository private unless you say otherwise. A course's
group has Edit course with AI, Show files and Publish to GitHub… in its
heading, and "Workshop: Show in File Browser" in the command palette does
the same for the open workshop.

## Courses

A course is a repository whose workshops the library shows, typically
one you are writing workshops in to publish. Cloning a repository into
`personal/courses/` is enough, and so is writing a new one there with
[`jupyter workshop course init`](publishing.md#a-course-repository) or
with [Create Course with AI](authoring.md#creating-a-course):

```
git clone https://github.com/example-org/course-workshops ~/Workshops/personal/courses/course-workshops
jupyter workshop course init ~/Workshops/personal/courses/new-course --title "A new course"
```

A workshop of your own that belongs in a course moves into it with Move
to course… on its card, or with `jupyter workshop course promote`:

```
jupyter workshop course promote ~/Workshops/personal/workshops/git-basics ~/Workshops/personal/courses/new-course --collection basics
```

The directory moves whole into the course's `workshops/`, with its
progress and its gist record, so publishing it again later updates the
same gist. The course takes it in: an entry written from its manifest
and pages goes into `OUTLINE.md` under the collection it joins, that
collection's index is rebuilt with it last, and the collection's order
in the `Justfile` gains its name, so `just index` keeps it there. The
move is committed in the course, since the workshop's own repository
ends with the move and its files join the course's history; when git
has no identity to commit as, the move is left for you to commit and
the dialog says so. A course with one collection needs no `--collection`,
and the card's dialog asks which part when there are several. If the
workshop's Workshop Author conversation is open, it hands over to the
course's conversation with the workshop named.

The library works out where a course's workshops are, taking the first
of these that finds any:

1. The workshops directory named in the course's registry entry, for a
   repository whose workshops are somewhere the rules below would not
   look (see linking, next).

2. The repository's own index. A `catalog.json` at its top lists its
   collections, and each collection's `collection.json` lists its
   workshops, by the `subdir` of each entry's git source. Each
   collection inside the repository becomes a section, in the catalog's
   order, with its workshops in the index's order; a workshop two
   collections list appears in both. Without a catalog, a
   `collection.json` at the top gives a single section. Workshops under
   `workshops/` that no index lists yet follow in a section of their
   own, so a workshop you have just started shows before you run
   `jupyter workshop index`.

3. The repository itself, when it is a single workshop with its
   `workshop.yaml` at the top.

4. The workshops directly under its `workshops/` directory.

5. The workshops directly at the top of the repository.

Only those files and directories are read, never anything deeper, so a
git submodule holding workshops of its own is not taken for the
course's. Some layouts and how they are shown:

```
personal/courses/wrapt-workshops/    sections, from the index
  catalog.json                       lists the three collections
  collections/
    decorators/collection.json       Decorators with wrapt
    monkey-patching/collection.json  Monkey patching with wrapt
    object-proxies/collection.json   Object proxies with wrapt
  workshops/                         every workshop, in one place
  reference/jupyterlab-workshop/     a submodule, not looked in

personal/courses/course-workshops/   one section, from the index
  collection.json
  workshops/git-basics/
  workshops/pandas-intro/

personal/courses/my-workshop/        the repository is the workshop
  workshop.yaml
  pages/

personal/courses/drafts/             no index: the workshops in workshops/
  workshops/first-try/
```

A repository that keeps its workshops somewhere else, or one kept
outside the library, is linked in:

```
jupyter workshop course link ~/src/course-workshops
jupyter workshop course link ~/src/jupyterlab-workshop --workshops examples
jupyter workshop course list
jupyter workshop course unlink jupyterlab-workshop
```

Linking makes `personal/courses/<name>` a symbolic link to the
repository, or a directory junction on Windows, which needs no special
rights, and records the course and its target in the registry.
JupyterLab reaches the repository through the link, and the extension
accepts paths behind it because the registry vouches for it; a link the
registry does not list is still treated as outside the JupyterLab root.
These commands use the default library unless `--root` or `--directory`
name another.

A course's workshops record their progress in `_workshop/` beside their
pages, inside the repository, so the repository should ignore that
directory; `course link` mentions it when the repository's `.gitignore`
does not. Remove on a course's workshop clears only that progress,
never the repository's files.

When a linked repository is deleted or moved, the course is shown as
missing in the browser, with its recorded path and an Unlink button,
and `course list` marks it. Unlinking removes the link and the entry,
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
  collection's directory under `installed/collections/`, its progress
  with it, and each one downloaded from a URL of its own moves under
  `installed/workshops/`.

- A workshop with its own [isolated environment](environment.md) stays
  where it is, since the environment and its kernel hold paths a move
  would break, and so does the workshop that is open.

- Local directories, which the browser did not download, stay where
  they are.

`jupyter workshop library DIR --init-only` makes a directory a library
from the command line, without moving anything.

## Upgrading a library from an earlier release

Libraries made before 0.28.0 kept their own workshops directly under
`personal/`, their courses under `projects/`, and their downloads under
`collections/` and `standalone/`, with a version 1 registry. Such a
library is recognised but not listed: the browser shows a notice with
an "Upgrade library…" button, and `jupyter workshop library` offers the
upgrade when it starts, or does it without asking with `--yes`. Either
way it says what will move first.

The upgrade moves each tree whole to where this release keeps it,
`personal/` to `personal/workshops/`, `projects/` to
`personal/courses/`, `standalone/` to `installed/workshops/` and
`collections/` to `installed/collections/`, with the progress in every
workshop and the links of linked courses, and writes the registry as
version 2 with its `projects` renamed `courses`. A workshop with an
isolated environment has it removed first, since the environment holds
the paths it was made at; it is made again when the workshop is next
opened. Nothing is moved while anything is in the way, and until the
upgrade is done nothing writes to the library: installing, subscribing
and Workshop Author all say it needs upgrading instead.

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
  "version": 2,
  "collections": ["https://example.org/course/collection.json"],
  "catalogs": [],
  "directories": {
    "https://example.org/course/collection.json": "example.org-course"
  },
  "courses": [
    {
      "name": "jupyterlab-workshop",
      "target": "/home/me/src/jupyterlab-workshop",
      "workshops": "examples"
    }
  ]
}
```

| Key           | Holds                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`     | `2`. A registry at `1` is one from before 0.28.0, which the upgrade above rewrites.                                                             |
| `collections` | Subscribed collections in order. Absent, the settings apply; present, even empty, it takes their place.                                         |
| `catalogs`    | Subscribed catalogs, absent or present as for collections.                                                                                      |
| `directories` | The directory under `installed/collections/` for each collection location, chosen at its first install.                                         |
| `courses`     | Courses that need an entry: a linked one, with its `target`, or one whose workshops the library would not find, with its `workshops` directory. |

`jupyter workshop schema --library` prints its JSON schema, which is
also published at
<https://grahamdumpleton.github.io/jupyterlab-workshop/schemas/v1alpha1/library.schema.json>.
The browser and the command line both write the file, each reading it
just before writing so neither drops the other's change.
