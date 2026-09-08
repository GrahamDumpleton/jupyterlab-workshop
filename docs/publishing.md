# Publishing workshops

A finished workshop reaches learners in one of three shapes: an archive
listed in a collection that the workshop browser installs from, a git
repository that holds one or more workshops and its own collection
index, or a JupyterLite site that runs in the browser with nothing
installed. This page covers building each, and building a catalog that
points learners at several collections. [Finding and installing
workshops](collections.md) describes what learners see.

## An archive and a collection entry

`jupyter workshop publish my-workshop` builds an archive of the workshop
under `dist/`, leaving out `_workshop`, `.git`, `scratch` and the like,
writes its SHA-256 beside it, and writes a collection entry: a JSON
snippet with the name, version, description and hash, and, with
`--url`, the address the archive will be published at. The archive is
built with fixed ownership and timestamps, so the hash is the same on
every machine and can be checked by whoever installs it.

`jupyter workshop collection collection.json ENTRY...` merges such
entries into a collection index, creating it if needed. Publishing a new
version of a workshop that is already listed updates its entry in place
and keeps the earlier versions, newest first; a new workshop is appended,
so the order of the file is yours to arrange:

```
jupyter workshop publish git-basics --url https://example.org/w/git-basics-1.2.0.tar.gz
jupyter workshop collection collection.json dist/git-basics-1.2.0.collection.json --title "Our workshops" --icon icon.svg
```

Host `collection.json`, its icon and the archives anywhere that serves
files over HTTPS, such as GitHub Pages or an object store, and give
learners the index URL to subscribe to, through the Collections dialog, the
`collections` setting or a launch link. The
[index format](collections.md#index-format) is a JSON document, and
`jupyter workshop schema --collection` prints its schema. The
[command line](cli.md#publish) page lists every option of `publish`
and `collection`.

## Several workshops in one repository

A repository can hold a set of related workshops side by side, each in
its own directory, with one index at the root that lists them all:

```
workshops-repo/
  collection.json
  icon.svg
  workshops/
    git-basics/
      workshop.yaml
      pages/
    pandas-intro/
      workshop.yaml
      pages/
```

`jupyter workshop index` writes and updates `collection.json` from the
manifests, giving each entry a git source pointing at its directory in
the repository, so no archives are built or published:

```
jupyter workshop index workshops --repo https://github.com/example-org/workshops --ref main
```

Every workshop found under the directories given becomes an entry whose
source is its path in the repository, fetched from `--repo` at `--ref`.
Run from the checkout, both are read from git and can be left out; give
`--ref` a tag when a course is pinned to a release, and `--ordered` when
the workshops are meant to be taken in the order listed. An existing index
is updated rather than replaced, so older versions stay listed and the
order of the workshops, which is the order the browser shows, is kept;
reorder the file by hand when the course changes. The
[command line](cli.md#index) page has the full set of options and what
is skipped when searching.

Commit the index with the workshops. Anyone can then subscribe to the
raw URL of `collection.json`, or start a session with it through a `collection`
[launch link](collections.md#launch-links), and Install fetches each
workshop from the forge. The same checkout can serve as a Binder image
that lists the workshops as installed; see [the Binder
recipe](collections.md#several-workshops-in-one-repository). The
[showcase repository](https://github.com/GrahamDumpleton/jupyterlab-workshop-showcase) follows the pattern, down to a
workflow that lints and self-tests every workshop on each push.

## A catalog of collections

An organisation with several collections publishes one catalog that
points at them all, so learners subscribe to one URL and pick:

```
courses-repo/
  catalog.json
  logo.svg
  python-basics/
    collection.json
    icon.svg
    first-steps/
      workshop.yaml
  kubernetes/
    collection.json
    icon.svg
    pods/
      workshop.yaml
```

`jupyter workshop catalog` builds the catalog from the collections
themselves, restating each one's title, description, publisher and icon
so the browser can show them without reading every index, and refreshes
the entries whenever a collection changes:

```
jupyter workshop index python-basics --out python-basics/collection.json --title "Python basics" --icon icon.svg
jupyter workshop index kubernetes --out kubernetes/collection.json --title "Kubernetes" --icon icon.svg
jupyter workshop catalog catalog.json python-basics/collection.json kubernetes/collection.json --relative --title "Example Academy" --icon logo.svg
jupyter workshop catalog catalog.json
```

`--relative` records each collection by its path relative to the
catalog, so the whole tree can be served from GitHub Pages or as raw
files and moved as one; a collection hosted elsewhere is named by its
URL instead. The last line, with no collections named, re-reads every
entry, which is what a CI job runs after a change, together with
`jupyter workshop lint catalog.json` to check that every collection can
be read. The [catalog format](collections.md#catalogs) is a JSON
document, and `jupyter workshop schema --catalog` prints its schema.

## A JupyterLite site

The build needs the `lite` extra, `uv add "jupyterlab-workshop[lite]"`
or `pip install "jupyterlab-workshop[lite]"`.

```
jupyter workshop lite my-workshop [other-workshop ...] [--out lite-site]
                                  [--default NAME] [--trust LEVEL]
                                  [--collection URL] [--catalog URL]
                                  [--no-terminal] [--lite-dir DIR]
                                  [--serve] [--port PORT]
```

The command copies the workshops into the site's contents (leaving
`_workshop/` progress behind), writes the extension settings that open a
workshop on start (`--default`, or the only workshop given) and, with
`--trust`, apply a trust level without asking, then runs `jupyter lite
build`. The site includes whatever JupyterLab extensions are installed in
the environment, this one among them. `--serve` serves the result on a
local port, under a sub-path as GitHub Pages would, to try it out.

The terminal needs `node`, `npm` and `micromamba` on the path when
building, because the terminal extension fetches its WebAssembly
commands from emscripten-forge. The site declares terminals available,
so File, New, Terminal and the launcher card work as well as the
workshop's own actions. `--no-terminal` leaves it out. `--lite-dir`
names the directory JupyterLite keeps its build state and those
downloads in; the default is under the Jupyter data directory so that
later builds are quick.

Pyodide itself is loaded from a CDN when the site opens, so learners
need network access on first use. The built site is relative-path only
and works from any sub-path. What a workshop can and cannot do there is
described under [JupyterLite](lite.md), and `jupyter workshop test
--lite` self-tests it in that form.

### GitHub Pages

The repository's own workflow (`.github/workflows/pages.yml`) runs
`just pages`, which assembles the project site: a landing page, the JSON
schemas, and the example workshop built as a JupyterLite site under
`demo/`. The result is deployed with `actions/deploy-pages` to
<https://grahamdumpleton.github.io/jupyterlab-workshop/>. A workshop
repository can do the same with just the JupyterLite build:

```yaml
- run: pip install "jupyterlab-workshop[lite]"
- run: |
    curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest \
      | tar -xj -C /usr/local bin/micromamba
- run: jupyter workshop lite . --out site
- uses: actions/upload-pages-artifact@v3
  with:
    path: site
```

A link to the deployed site with `?workshop=<name>` opens that workshop;
add `restart=force` to start it afresh on every visit, as the project's
demo link does. See [launch links](collections.md#launch-links).
