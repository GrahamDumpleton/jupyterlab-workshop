# Publishing workshops

A finished workshop reaches learners in one of three shapes: an archive
listed in a registry index that the workshop browser installs from, a
git repository that holds one or more workshops and its own index, or a
JupyterLite site that runs in the browser with nothing installed. This
page covers building each. [Finding and installing
workshops](registry.md) describes what learners see.

## An archive and a registry entry

```
jupyter workshop publish my-workshop [--out dist] [--url URL]
```

Builds `dist/<name>-<version>.tar.gz` (excluding `_workshop`, `.git`,
`scratch` and similar), writes its SHA-256 next to it, and writes a
registry entry JSON snippet with the hash and, when given, the URL the
archive will be published at. The archive is built with fixed ownership
and timestamps so the hash is the same on every machine. `--out` names
the output directory; the default is `dist/` in the current directory.

```
jupyter workshop registry index.json ENTRY... [--title TITLE]
```

Merges the entry files written by `publish` into a registry index,
creating it if needed. An entry for a name that is already listed
replaces the listing and keeps the earlier versions, newest first:

```
jupyter workshop publish git-basics --url https://example.org/w/git-basics-1.2.0.tar.gz
jupyter workshop registry index.json dist/git-basics-1.2.0.registry.json --title "Our workshops"
```

Host `index.json` and the archives anywhere that serves files over
HTTPS, such as GitHub Pages or an object store, and list the index URL
in the `registries` setting of the learners' JupyterLab. The
[index format](registry.md#index-format) is a JSON document, and
`jupyter workshop schema --registry` prints its schema. The extension
checks the archive's hash against the entry when it installs, so a
`sha256` in the entry is worth keeping.

## Several workshops in one repository

A repository can hold a set of related workshops side by side, each in
its own directory, with one index at the root that lists them all:

```
workshops-repo/
  registry.json
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

```
jupyter workshop index [DIRECTORY...] [--root ROOT] [--out FILE] [--repo URL] [--ref REF] [--title TITLE]
```

Every workshop found under the directories given (the current directory
by default) becomes an entry whose source is the workshop's path
relative to `--root`, the git checkout holding the first directory
unless given, fetched from `--repo` at `--ref`. Run from the checkout,
the repository URL and branch are read from git and can be left out; an
SSH remote is rewritten as the https URL. Give `--ref` a tag when a
course is pinned to a release. The index is written to `registry.json`
under the root, or `--out`, and an existing index is updated: entries
are replaced by name and their other versions kept. Hidden directories,
`node_modules`, build outputs and `_workshop` state are not searched,
nor are the contents of a workshop.

Commit the index with the workshops. Anyone can then add the raw URL of
`registry.json` to their `registries` setting, or start a session in it
with a `registry` [launch link](registry.md#launch-links), and Install
fetches each workshop from the forge. The same checkout can serve as a
Binder image that lists the workshops as installed; see [the Binder
recipe](registry.md#several-workshops-in-one-repository). This
repository's own `examples/` directory and `registry/` index follow the
pattern.

## A JupyterLite site

The build needs the `lite` extra, `uv add "jupyterlab-workshop[lite]"`
or `pip install "jupyterlab-workshop[lite]"`.

```
jupyter workshop lite my-workshop [other-workshop ...] [--out lite-site]
                                  [--default NAME] [--trust LEVEL]
                                  [--registry URL] [--no-terminal]
                                  [--lite-dir DIR] [--serve] [--port PORT]
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
demo link does. See [launch links](registry.md#launch-links).
