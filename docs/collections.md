# Finding and installing workshops

Workshops reach learners in four ways: the workshop browser, a launch
link, the "Open Workshop from URL…" command, and a local directory. This
page covers the first two, and the collections and catalogs behind the
browser. Trust, downloading and removal are described in
[Loading and trust](trust.md).

Two words carry the page. A **collection** is a published list of
workshops: a course, a team's training material, or an unrelated set
that one person maintains. Its index is a JSON file, `collection.json`
by convention, saying where each workshop can be fetched from. A
**catalog** is a published list of collections, `catalog.json` by
convention, so that one URL can point learners at everything an
organisation offers. A JupyterLab subscribes to some collections and
catalogs, in its settings or for a session, and the browser shows what
they offer. Subscribing stores only the URL: the index is read afresh
whenever the browser lists it, so a published change shows at once.
There are no subscriptions out of the box.

## The workshop browser

"Browse Workshops" (in the launcher under Workshops, in the command
palette, and from the panel's launcher button) opens a main-area tab
with two sections:

- **Installed** lists every workshop directory under the
  `workshopsDirectory` setting (default `workshops`), with its source,
  the collection it came from, how many pages are done, and buttons to
  Open or Resume it, Restart it once started, Update it when its
  collection lists another version, and Remove it. The workshop that is
  open is marked. Workshops are listed in their collection's own order,
  so a course reads top to bottom: the collection recorded when a
  workshop was installed or, for a directory with no record, the one
  subscribed collection that lists its name. The rest follow by title.
  A collection that declares its workshops a sequence, a course, has its
  cards numbered, "2 of 5", in both sections, and the first one not yet
  finished marked "Up next".

- **Available** lists the workshops of every subscribed collection, one
  group per collection. A group is headed by the collection's icon,
  title, description and publisher, and can be collapsed; the cards
  under it show each workshop's title, version, description, platforms,
  capabilities and duration, and carry the collection's name; the title
  links to the workshop's website when its manifest gives one. A search
  box matches names, titles, descriptions and tags across every group;
  tag buttons narrow the list further. Install downloads the newest
  version, checks its hash when the collection gives one, and lists it
  under Installed, where Open starts it. When more than one workshop of
  a collection is left to install, its heading offers "Install all…",
  which asks first; see [Installing a whole collection](#installing-a-whole-collection).
  Cards for workshops that do not list the current platform are dimmed
  but can still be installed. A workshop that is already installed
  appears only under Installed, where its card offers an Update button
  when its collection lists a different version. When every workshop
  the collections list is installed, as in an image that ships the
  workshops its collection lists, the Available section and its search
  and tags are not shown at all; a single collection with everything
  installed keeps its heading, with a note saying so.

```{figure} _static/browser.png
:alt: The workshop browser with an installed ordered collection and another subscribed collection
:width: 100%

The workshop browser: the three workshops of the showcase collection
installed, numbered and with the first marked up next, and another
subscribed collection's workshops grouped under its heading.
```

"Add from URL…" and "Open a directory…" run the corresponding commands.
"Collections…" opens the dialog described next. With no subscriptions
and nothing installed, the Available section says so and offers to
subscribe to a collection or a catalog. With a subscribed catalog whose
collections are not subscribed to, they are listed under "Collections
you can subscribe to", each with a Subscribe button.

Once a workshop is opened, from the browser or anywhere else, the browser
tab closes and the workshop's instructions and [layout](layouts.md) take
over. It stays open while a workshop that is already open is browsed
alongside.

### The Collections dialog

"Collections…" in the browser, or "Workshop: Collections…" in the
command palette, opens a dialog with two tabs. **Collections** lists
each subscribed collection with its icon, title, description, publisher
and location, and where the subscription came from: your settings, the
defaults an administrator set, or this session, for one a launch link
added. A field subscribes to a collection by the URL or root-relative
path of its `collection.json`; Unsubscribe drops one; a session's
collection has Subscribe, which writes it into your settings so it
stays, and Remove, which drops it for the session. Below, "From
subscribed catalogs" lists every collection the subscribed catalogs
offer, with Subscribe on those not yet subscribed to. **Catalogs** does
the same for catalogs: the subscribed ones, subscribe by URL,
unsubscribe.

Update on an installed card downloads the collection's newest version
over the files, without opening it either.

### Installing a whole collection

An ordered collection is a course, and a learner about to work offline
wants everything at once, so a collection's heading offers "Install
all…" whenever more than one of its workshops is not installed yet. It
opens a dialog listing every workshop of the collection with a
checkbox: those already installed are greyed out, those that do not
list the current platform start unticked, and the rest start ticked,
with the count that will be installed shown underneath. Cancel is the
default button, so nothing downloads by accident.

The downloads then run one at a time, in the collection's order, with
a notification showing which is in progress and a Cancel action that
stops after the current one finishes, keeping what has landed. Each
workshop goes through the same hash check and size limit as a single
install, and the same naming, so a name another collection has already
installed gets the same suffix it would from the card. One failure does
not stop the rest, but when the first few fail the same way, as when
the network is down, the run stops rather than trying them all. A run
that did not install everything ends with a summary of what landed,
what failed and why, and what was not attempted, with "Retry
remaining" to try those again. A download whose hash does not match
the collection is called out separately, since it means the collection
is out of date or the files have changed.

```{figure} _static/install-all-dialog.png
:alt: The Install all dialog listing a collection's workshops with checkboxes
:width: 100%

The Install all dialog for a collection with nothing installed yet.
```

Nothing runs during an install, however many workshops it covers;
opening a workshop asks for trust as it always does. The `install-all`
key of `disabledFeatures` removes the button on machines where a bulk
download is unwelcome, leaving single installs; see
[locking down a deployment](deploying.md#locking-down-a-deployment).

The "…" menu beside a collection's heading holds "Remove all", which
deletes every workshop that was installed from that collection, with
their progress, after a confirmation listing the directories. It is
there only when Remove is allowed, and it leaves alone workshops that
merely share a name with the collection's entries, such as a checkout's
own directories, since those were never installed from it.

For an image or a script, `jupyter workshop install <collection>` does
the same from the command line; see [the CLI](cli.md#install).

```{figure} _static/collections-dialog.png
:alt: The Collections dialog
:width: 100%

The Collections dialog: two subscribed collections, and one more
offered by a catalog.
```

The dialog edits the `collections` and `catalogs` settings, so the
JupyterLab settings editor shows the same lists and can edit them as
raw text. Unsubscribing from a collection an administrator's overrides
supplied writes the shortened list into your own settings, which JupyterLab then
uses in place of the overrides.

### Same name, different collections

Two collections may each offer a workshop named `git-basics`. They are
kept apart: the browser matches an installed workshop to the collection
it was installed from, so each is offered, installed and updated on its
own. (A workshop with no collection recorded, a local directory or one
added from a URL, is matched by name alone: it takes the order and the
Update button of the one subscribed collection that lists its name, and
a name two collections offer is left without either rather than
guessed.) The first lands in
`workshops/git-basics`; a second of the same name from another
collection lands in `workshops/git-basics-<hash>`,
where the hash is the first seven characters of the SHA-256 of the
collection's location, the way a short commit hash abbreviates a commit.
The same collection always maps to the same directory, so reinstalling
finds it. The directory name never shows in the browser, which shows
titles, but it is what the file browser, a terminal and a launch link
written against the path would show, which is a reason to hand out
[collection links](#launch-links) rather than installed paths.

### Starting in the browser

An image that offers a choice of workshops can start JupyterLab in the
browser instead of at the launcher, with the `browseOnStart` setting or
a `collection` or `catalog` launch link; see
[Deploying workshops](deploying.md#starting-in-the-browser).

## Collections

The `collections` setting lists the subscribed collections: `https` URLs
of their index files, or paths relative to the JupyterLab root for a
classroom or offline index. The list is empty by default. A learner
changes it through the Collections dialog or the settings editor; an
administrator sets it for everyone through `overrides.json`:

```json
{
  "@jupyterlab-workshop/labextension:panel": {
    "collections": [
      "https://example.org/workshops/python/collection.json",
      "shared/collection.json"
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

Subscribing to a collection never trusts its workshops: each still shows the
trust dialog when opened, unless a policy settles it. Fetching an index
tells its host that the learner is there, as does the icon it names.

### Index format

```json
{
  "version": 1,
  "title": "Python basics",
  "description": "The language from the first print to a small program.",
  "publisher": { "name": "Example Academy", "url": "https://example.org" },
  "homepage": "https://example.org/python-basics",
  "icon": "icon.svg",
  "tags": ["python", "beginner"],
  "ordered": true,
  "workshops": [
    {
      "name": "python-first-steps",
      "title": "First steps in Python",
      "description": "Values, names and the notebook.",
      "tags": ["python", "beginner"],
      "platforms": ["linux", "macos", "windows", "lite"],
      "capabilities": ["kernel-exec"],
      "duration": "45m",
      "versions": [
        {
          "version": "1.2.0",
          "source": {
            "git": "https://github.com/example-org/python-basics",
            "ref": "v1.2.0",
            "subdir": "first-steps"
          },
          "sha256": "…"
        }
      ]
    }
  ]
}
```

Everything above `workshops` describes the collection itself and is
optional: `title`, `description`, `publisher` (a name, or an object with
a `name` and a `url`), `homepage`, `icon` and `tags`. The browser shows
them on the group heading and in the Collections dialog.

The `workshops` list is shown in the order written. A course lists its
workshops in sequence and says so with `ordered: true`, which numbers
the cards in the browser, marks the next one to take, and has the
Finish dialog offer it; an unrelated set lists them however its author
likes and leaves the flag out. Each version names a source: a git repository (`git`, `ref`,
`subdir`) on a forge that serves archives, or a direct `archive` URL.
Versions are listed newest first and the first is what Install fetches.
A `sha256` is optional but recommended: the download is refused when the
archive's hash differs. `jupyter workshop schema --collection` prints
the full JSON schema.

### Icons

A collection's `icon`, and a catalog's, is an `http(s)` URL, a URL
relative to the file it appears in, or a `data:` URI holding a small
SVG. It is drawn inside a square box, about 48 pixels beside a group
heading and 64 in the dialog, scaled to fit and centred, so a wide logo
shows at full width and a square mark fills the box; nothing needs to be
cropped. SVG is the format to prefer, since it scales cleanly to both
sizes; a PNG should be at least 128 pixels on its long side to stay
sharp on a high density screen. A collection or catalog without an icon
gets a tile with the first letter of its title on a colour chosen from
the title, so lists with and without icons line up. The intent is a
subject mark for a collection, a Python or Kubernetes logo for a course
on it, and a publisher's logo for a catalog.

### Building an index

`jupyter workshop publish` writes an archive, its hash and a collection
entry for a workshop, `jupyter workshop collection` merges such entries
into an index, and `jupyter workshop index` lists every workshop in a
repository without archives. Both keep the order of an existing index,
updating entries in place and appending new ones, so an author orders
the file once and the tools respect it; both take `--title`,
`--description`, `--publisher`, `--publisher-url`, `--homepage`,
`--icon` and `--tag` for the collection's own fields, keeping an
existing index's values when not given. See
[Publishing workshops](publishing.md).

## Catalogs

A catalog is a JSON file listing collections, with the URL of each
collection's index and a restatement of its title, description,
publisher, icon and tags, so the browser can show what is on offer
without fetching every index:

```json
{
  "version": 1,
  "title": "Example Academy",
  "description": "Courses from Example Academy.",
  "publisher": { "name": "Example Academy", "url": "https://example.org" },
  "icon": "logo.svg",
  "collections": [
    {
      "url": "python-basics/collection.json",
      "title": "Python basics",
      "description": "The language from the first print to a small program.",
      "publisher": { "name": "Example Academy" },
      "icon": "python-basics/icon.svg",
      "tags": ["python", "beginner"]
    },
    {
      "url": "https://other.example/kubernetes/collection.json",
      "title": "Kubernetes from the command line"
    }
  ]
}
```

A collection's `url` and every `icon` may be relative to the catalog
file, so one repository can hold a `catalog.json` at its root and a
`collection.json` in each subdirectory, served by GitHub Pages or as raw
files; the catalog can also point at collections anywhere else.
`jupyter workshop schema --catalog` prints the schema.

The `catalogs` setting lists the subscribed catalogs, empty by default
and edited the same ways as `collections`. Subscribing to a catalog
subscribes to none of its collections; the browser offers them, and the
learner picks. An administrator can subscribe everyone to a catalog in
`overrides.json` to give a class one place to look.

`jupyter workshop catalog catalog.json COLLECTION...` reads each
collection named by URL or file, and writes or refreshes its entry from
the index's own metadata, keeping an existing entry's position; run
with no collections named, it refreshes every entry already listed.
`--relative` records a file by its path relative to the catalog, for the
one-repository layout; `--title` and the other metadata options set the
catalog's own fields. `jupyter workshop lint catalog.json` checks a
catalog, including that every collection it names can be read, and
`jupyter workshop lint collection.json` checks an index, which gives a
repository of workshops a CI check. See [the command line](cli.md).

## Several workshops in one repository

A repository can hold a set of related workshops side by side, each in
its own directory, with a `collection.json` at the root that
`jupyter workshop index` builds from their manifests; see
[Publishing workshops](publishing.md#several-workshops-in-one-repository).
Anyone can subscribe to the raw URL of that index, or start a session with it
through a `collection` launch link, and Install fetches each workshop
from the forge. The same checkout can serve as a Binder image; see
[Deploying workshops](deploying.md#a-binder-repository).

## Locking down a deployment

The `disabledFeatures` setting removes the buttons, commands and launch
link parameters that let a learner open other directories or URLs,
subscribe to collections or catalogs, edit or remove workshops; see
[Deploying workshops](deploying.md#locking-down-a-deployment).
Restart, which puts a workshop back as it was first opened, stays
available; see [Using workshops](using.md#starting-over-and-clearing-up).

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

- `restart` starts a workshop that is already present over before
  opening it, as [Restart](using.md#starting-over-and-clearing-up) does: files back to
  the first-open snapshot, progress forgotten, layout applied afresh.
  On its own it asks first when the workshop has recorded progress, and
  goes straight ahead when there is nothing to lose; `restart=force`
  never asks, for a demo link that must always start clean. It applies
  to a directory; a download replaces the files anyway. JupyterLab's own
  `reset` parameter clears the window's tabs and panels, so a link that
  should look untouched carries both: `lab?reset&workshop=…&restart=force`.

Two more parameters add sources for the session, and open the
browser when no workshop is named:

- `collection=<url>` adds a collection for the session: the browser
  shows its workshops alongside the subscribed ones, and the
  Collections dialog offers Subscribe to write it into the settings.
  With `workshop=<name>` as
  well, where the name is one of the collection's workshops rather than
  a URL or path, that workshop is installed from the collection,
  recording where it came from, and opened: the "start lesson three"
  link for a course.

- `catalog=<url>` adds a catalog for the session, so the browser
  offers its collections under "Collections you can subscribe to".

- `welcome=<path>` shows the Markdown file at that path, relative to
  the JupyterLab root, in a dialog once JupyterLab has started, on its
  own or over whatever the other parameters open; see
  [a welcome message](deploying.md#a-welcome-message). Alone, it leaves
  the start as it would otherwise be.

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

The `urlpath` is `lab?workshop=…` URL-encoded; `lab?collection=…` and
`lab?catalog=…` work the same way and land in the browser instead, which
is how one link can show off everything a catalog offers. This
repository's own `binder/` directory is an example: `runtime.txt`
selects a Python the package supports, `requirements.txt` installs
JupyterLab and the package, and `postBuild` writes a settings override
that starts in the browser with the examples listed as installed, and
trusts them. A workshop repository can carry the same files and a
launch badge, with the `workshop` parameter naming a directory in the
checkout rather than a URL.

## Installed workshops and the server

The list in the browser comes from `GET jupyterlab-workshop/workshops`,
which describes every directory under the workshops directory that holds
a `workshop.yaml`, reading `_workshop/source.json` and
`_workshop/state.json` for the source, the collection it was installed
from, and the progress. Collections are read through
`GET jupyterlab-workshop/collection?url=…` and catalogs through
`GET jupyterlab-workshop/catalog?url=…`, which returns the catalog with
its relative locations resolved. All refuse paths outside the JupyterLab
root.
