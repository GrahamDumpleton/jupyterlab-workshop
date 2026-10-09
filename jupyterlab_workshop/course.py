"""Course repositories: scaffolding one and keeping it current.

A course is a repository of workshops with the indexes that publish
them: one or more collections under ``collections/<name>/collection.json``
with a ``catalog.json`` over them, every workshop flat under
``workshops/``, and around them what a repository needs to be written
in with an agent, checked, and hosted: a uv project pinning the
extension, agent guidance, the design document ``OUTLINE.md``, a
Justfile, the Binder and Codespaces files, a test workflow and, for a
course written for JupyterLite, the site files and a Pages workflow.

``jupyter workshop course init`` writes all of it, and Workshop Author
calls the same code, so the two agree on what a course contains. The
scaffold records what it wrote, and the hash of each file, in
``course.json``, which is how ``course update`` later tells a file that
is still as generated, and may be regenerated for a new release, from
one the author has edited, which is left alone and reported.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from string import Template
from typing import Any
from urllib.parse import urlsplit

try:
    from ._version import __version__
except ImportError:  # pragma: no cover - a source checkout without a build
    __version__ = "0.0.0"

#: The record a course scaffold leaves at its root.
COURSE_FILE = "course.json"

#: The record format version.
COURSE_VERSION = 1

#: The Python version a new course is written for.
DEFAULT_PYTHON = "3.14"

#: The features a hosted launch of a course switches off: visitors are kept
#: to the course's workshops, and the library and authoring parts, which a
#: course repository is not, stay out of the way.
DISABLED_FEATURES = (
    "open-directory",
    "open-url",
    "collections",
    "catalogs",
    "remove",
    "author",
    "library",
    "personal",
    "ai-authoring",
)

#: The sink hosted launches report to when a collection index declares one.
ANALYTICS_POLICY = {"report": "always"}

NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class CourseError(Exception):
    """A course that cannot be scaffolded or updated as asked."""


@dataclass(frozen=True)
class CollectionSpec:
    """One collection of a course: a part of it with an index of its own."""

    name: str
    title: str
    description: str = ""


@dataclass(frozen=True)
class CourseOptions:
    """What a course scaffold is written from."""

    name: str
    title: str
    description: str
    collections: tuple[CollectionSpec, ...]

    #: The prefix of every collection id, ``<prefix>/<course>/<collection>``.
    id_prefix: str

    #: The repository's URL on GitHub, or empty before it has one.
    repository: str = ""

    #: Whether the course is written for JupyterLite as well as JupyterLab.
    lite: bool = False

    python: str = DEFAULT_PYTHON

    #: The jupyterlab-workshop release the course pins.
    version: str = __version__

    def collection_id(self, collection: CollectionSpec) -> str:
        """The id of one of the course's collections."""

        return f"{self.id_prefix}/{self.name}/{collection.name}"

    def to_dict(self) -> dict[str, Any]:
        """The options as ``course.json`` records them."""

        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "collections": [
                {"name": c.name, "title": c.title, "description": c.description}
                for c in self.collections
            ],
            "idPrefix": self.id_prefix,
            "repository": self.repository,
            "lite": self.lite,
            "python": self.python,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any], version: str) -> CourseOptions:
        """The options a ``course.json`` records, pinned to ``version``."""

        collections = tuple(
            CollectionSpec(
                name=str(item["name"]),
                title=str(item.get("title") or item["name"]),
                description=str(item.get("description") or ""),
            )
            for item in data.get("collections") or []
            if isinstance(item, dict) and item.get("name")
        )

        if not collections:
            raise CourseError(f"{COURSE_FILE} names no collections")

        return cls(
            name=str(data["name"]),
            title=str(data.get("title") or data["name"]),
            description=str(data.get("description") or ""),
            collections=collections,
            id_prefix=str(data.get("idPrefix") or data["name"]),
            repository=str(data.get("repository") or ""),
            lite=bool(data.get("lite", False)),
            python=str(data.get("python") or DEFAULT_PYTHON),
            version=version,
        )


@dataclass
class UpdateReport:
    """What ``update_course`` did to each generated file."""

    #: Files written again because they were still as generated.
    refreshed: list[str] = field(default_factory=list)

    #: Files the author had edited, left as they are.
    kept: list[str] = field(default_factory=list)

    #: Files the scaffold now writes that the course did not have.
    added: list[str] = field(default_factory=list)

    #: The release the course was pinned to before, and is pinned to now.
    previous: str = ""
    version: str = ""


def check_options(options: CourseOptions) -> None:
    """Refuse options the scaffold cannot write."""

    if not NAME_PATTERN.match(options.name):
        raise CourseError(
            f'"{options.name}" cannot be a course name: use lower case letters, '
            "digits and hyphens"
        )

    if not options.collections:
        raise CourseError("A course needs at least one collection")

    seen: set[str] = set()

    for collection in options.collections:
        if not NAME_PATTERN.match(collection.name):
            raise CourseError(
                f'"{collection.name}" cannot be a collection name: use lower '
                "case letters, digits and hyphens"
            )

        if collection.name in seen:
            raise CourseError(f"The collection {collection.name} is named twice")

        seen.add(collection.name)

    if not options.id_prefix or any(ch.isspace() for ch in options.id_prefix):
        raise CourseError("The collection id prefix must have no spaces")

    if not re.match(r"^\d+\.\d+$", options.python):
        raise CourseError(f'"{options.python}" is not a Python version like 3.14')


def id_prefix_for(repository: str, name: str) -> str:
    """The default id prefix: the forge and owner of the repository when
    one is known, as ``github.com/owner``, else the course's own name."""

    if repository:
        parts = urlsplit(repository)
        owner = parts.path.strip("/").split("/")[0] if parts.path else ""

        if parts.netloc and owner:
            return f"{parts.netloc.lower()}/{owner}"

    return name


def course_files(directory: Path, options: CourseOptions) -> dict[Path, str]:
    """Every file the scaffold writes for a course, by path."""

    check_options(options)

    files: dict[Path, str] = {
        directory / "pyproject.toml": pyproject(options),
        directory / ".gitignore": gitignore(options),
        directory / ".mcp.json": mcp_config(),
        directory / "CLAUDE.md": "@AGENTS.md\n",
        directory / "AGENTS.md": agents(options),
        directory / "OUTLINE.md": outline(options),
        directory / "README.md": readme(options),
        directory / "Justfile": justfile(options),
        directory / "jupyter_lab_config.py": lab_config(options),
        directory / "catalog.json": catalog(options),
        directory / "workshops" / ".gitkeep": "",
        directory / "binder" / "runtime.txt": f"python-{options.python}\n",
        directory / "binder" / "requirements.txt": requirements(options),
        directory / "binder" / "postBuild": binder_post_build(options),
        directory / "binder" / "welcome.md": welcome(options, "binder"),
        directory / ".devcontainer" / "devcontainer.json": devcontainer(options),
        directory / ".devcontainer" / "setup.sh": devcontainer_setup(options),
        directory / ".devcontainer" / "start.sh": devcontainer_start(),
        directory / ".devcontainer" / "welcome.md": welcome(options, "codespaces"),
        directory / ".github" / "workflows" / "test.yml": test_workflow(options),
    }

    for collection in options.collections:
        files[directory / "collections" / collection.name / "collection.json"] = (
            collection_stub(options, collection)
        )

    if options.lite:
        files[directory / "lite" / "settings.json"] = lite_settings()
        files[directory / "lite" / "welcome.md"] = welcome(options, "lite")
        files[directory / ".github" / "workflows" / "pages.yml"] = pages_workflow()

    return files


def write_course(directory: Path, options: CourseOptions) -> list[Path]:
    """Write a course scaffold, refusing to overwrite any file that exists,
    and record it in ``course.json``. Returns the files written."""

    files = course_files(directory, options)
    existing = [path for path in files if path.exists()]

    if (directory / COURSE_FILE).exists():
        existing.append(directory / COURSE_FILE)

    if existing:
        names = ", ".join(sorted(str(path.relative_to(directory)) for path in existing))

        raise CourseError(f"Refusing to overwrite existing files: {names}")

    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    _make_executable(directory / "binder" / "postBuild")
    _make_executable(directory / ".devcontainer" / "setup.sh")
    _make_executable(directory / ".devcontainer" / "start.sh")

    write_record(directory, options, files)

    return [*files, directory / COURSE_FILE]


def read_record(directory: Path) -> dict[str, Any] | None:
    """The ``course.json`` of a course, or None when there is none."""

    path = directory / COURSE_FILE

    if not path.is_file():
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise CourseError(f"Unable to read {path}: {error}") from error

    if not isinstance(data, dict) or data.get("version") != COURSE_VERSION:
        raise CourseError(f"{path} is not a course record this release understands")

    return data


def write_record(
    directory: Path, options: CourseOptions, files: dict[Path, str]
) -> None:
    """Record the options and the hash of each generated file."""

    record = {
        "version": COURSE_VERSION,
        **options.to_dict(),
        "jupyterlab-workshop": options.version,
        "generated": {
            path.relative_to(directory).as_posix(): _digest(content)
            for path, content in sorted(files.items())
        },
    }

    (directory / COURSE_FILE).write_text(
        json.dumps(record, indent=2) + "\n", encoding="utf-8"
    )


def update_course(directory: Path, version: str | None = None) -> UpdateReport:
    """Bring a course's generated files up to a release of the extension.

    The pin moves in ``pyproject.toml`` and ``binder/requirements.txt``
    whatever else is in them. Every other generated file is written
    again when it is still as the scaffold last wrote it, added when it
    is missing, and left alone and reported when the author has edited
    it. The record is rewritten with the new hashes.
    """

    record = read_record(directory)

    if record is None:
        raise CourseError(f"{directory} is not a course made by jupyter workshop")

    previous = str(record.get("jupyterlab-workshop") or "")
    options = CourseOptions.from_dict(record, version or __version__)
    files = course_files(directory, options)
    recorded = record.get("generated") or {}
    report = UpdateReport(previous=previous, version=options.version)
    hashes: dict[str, str] = {}

    for path, content in files.items():
        relative = path.relative_to(directory).as_posix()

        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            report.added.append(relative)
            hashes[relative] = _digest(content)

            continue

        current = path.read_text(encoding="utf-8")

        if relative in ("pyproject.toml", "binder/requirements.txt"):
            moved = _move_pin(current, options.version)

            if moved != current:
                path.write_text(moved, encoding="utf-8")
                report.refreshed.append(relative)

            hashes[relative] = _digest(moved)

            continue

        if _digest(current) == recorded.get(relative):
            if current != content:
                path.write_text(content, encoding="utf-8")
                report.refreshed.append(relative)

            hashes[relative] = _digest(content)
        else:
            # An edited file keeps the hash of what was generated, so it
            # stays an edited file to every later update too.
            report.kept.append(relative)

            if relative in recorded:
                hashes[relative] = str(recorded[relative])

    record["jupyterlab-workshop"] = options.version
    record["generated"] = dict(sorted(hashes.items()))
    (directory / COURSE_FILE).write_text(
        json.dumps(record, indent=2) + "\n", encoding="utf-8"
    )

    return report


def _move_pin(text: str, version: str) -> str:
    return re.sub(
        r"jupyterlab-workshop(\[[^\]]*\])?==[0-9][^\s\"']*",
        lambda match: f"jupyterlab-workshop{match.group(1) or ''}=={version}",
        text,
    )


def _digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _make_executable(path: Path) -> None:
    path.chmod(path.stat().st_mode | 0o111)


class _Fill(Template):
    """A template whose placeholders are ``§name``, so the shell and
    Justfile text it holds can use ``$`` and braces as they are."""

    delimiter = "§"
    idpattern = r"[a-z_]+"


def _fill(template: str, **values: str) -> str:
    return _Fill(template).substitute(values)


def _collection_paths(options: CourseOptions) -> list[str]:
    return [f"collections/{c.name}/collection.json" for c in options.collections]


def _overrides(options: CourseOptions, welcome_path: str, trusted: bool) -> str:
    panel: dict[str, Any] = {
        "defaultWorkshop": "",
        "browseOnStart": True,
        "workshopsDirectory": "workshops",
        "collections": _collection_paths(options),
        "welcome": welcome_path,
    }

    if trusted:
        panel["trustPolicy"] = {"forcedLevel": "trusted"}

    panel["disabledFeatures"] = list(DISABLED_FEATURES)
    panel["analytics"] = dict(ANALYTICS_POLICY)

    return json.dumps(
        {
            "@jupyterlab-workshop/labextension:panel": panel,
            "@jupyterlab/apputils-extension:notification": {"fetchNews": "false"},
        },
        indent=2,
    )


def _variable(name: str) -> str:
    return name.replace("-", "_")


def pyproject(options: CourseOptions) -> str:
    """The uv project: JupyterLab and the pinned extension, and nothing taught."""

    extras = "mcp,test,lite" if options.lite else "mcp,test"

    return _fill(
        """# This repository is a course of workshops, not a Python package: uv
# manages the environment the workshops are written, checked and run in.
# The runtime dependencies are what a learner needs, JupyterLab and the
# extension, and are exported to binder/requirements.txt for mybinder.org;
# the dev group adds the MCP server and the self-test used while writing.
# jupyterlab-workshop is pinned once, here, and the dev group's extras
# resolve to the same release.
#
# Nothing the workshops teach is installed here. A workshop that needs a
# package declares an environment of its own, pinned in its own
# requirements.txt, which the extension builds when the workshop opens.
[project]
name = "§name"
version = "0.1.0"
description = "§description"
readme = "README.md"
requires-python = ">=§python"
dependencies = [
    "jupyterlab>=4.6,<5",
    "jupyterlab-workshop==§version",
]

[dependency-groups]
dev = [
    "jupyterlab-workshop[§extras]",
]

[tool.uv]
package = false
""",
        name=options.name,
        description=_toml_string(options.description or options.title),
        python=options.python,
        version=options.version,
        extras=extras,
    )


def _toml_string(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def gitignore(options: CourseOptions) -> str:
    """What a course repository never commits."""

    lite = (
        """
# The JupyterLite site, built by `just site`
dist/
.jupyterlite.doit.db
"""
        if options.lite
        else ""
    )

    return _fill(
        """# Python environment managed by uv
.venv/
__pycache__/
*.py[cod]
.ipynb_checkpoints/

# The authoring skill is a symlink into the installed package, made by
# `just install`, so it always matches the pinned release
.claude/skills/jupyterlab-workshop-authoring

# Claude Code's per-checkout permissions, written as they are granted.
# The repository's .mcp.json and AGENTS.md are committed; this is local.
.claude/settings.local.json

# Workshop Author's conversation about this course
.workshop/

# State and outputs left behind by opening, running or publishing a workshop
workshops/*/_workshop/
workshops/*/work/
workshops/*/dist/
workshops/*/scratch/
results-*.xml
test-results/
§lite
# Temporary working files for agents, never referenced from committed files
scratch/

# Editors and OS
.DS_Store
""",
        lite=lite,
    )


def mcp_config() -> str:
    """The workshop MCP server, run from the repository's own environment."""

    return (
        json.dumps(
            {
                "mcpServers": {
                    "workshop": {
                        "command": "uv",
                        "args": ["run", "jupyter", "workshop", "mcp"],
                    }
                }
            },
            indent=2,
        )
        + "\n"
    )


def requirements(options: CourseOptions) -> str:
    """The runtime requirements Binder and Codespaces install, until
    `just requirements` exports the locked set over them."""

    return _fill(
        """# The runtime dependencies, for mybinder.org and Codespaces. `just
# requirements` rewrites this file from uv.lock; do not edit it by hand.
jupyterlab>=4.6,<5
jupyterlab-workshop==§version
""",
        version=options.version,
    )


def lab_config(options: CourseOptions) -> str:
    """Start JupyterLab in the workshop browser with the course's
    collections added for the session."""

    links = "".join(
        f'\n    "&collection={path}"' for path in _collection_paths(options)
    )

    return _fill(
        """# Configuration for JupyterLab started from this checkout. Jupyter does
# not look in the current directory for config files, so this one is
# named explicitly: `just lab` passes `--config=jupyter_lab_config.py`,
# and `uv run jupyter lab --config=jupyter_lab_config.py` does the same.
#
# Open the workshop browser with the course's collections added for the
# session, in the order to take them, and the catalog. A collection
# lists its workshops in the order to take them, numbered, rather than
# the order the workshops directory gives, and the browser groups the
# installed workshops under each collection's heading in the order the
# link names them. A collection added to this course is added to the
# link here. They are added for the session only, kept in the
# workspace's saved state across reloads; the browser offers Subscribe
# to keep them for good.
c.LabApp.default_url = (
    "/lab?catalog=catalog.json"§links
)
""",
        links=links,
    )


def catalog(options: CourseOptions) -> str:
    """The catalog naming every collection, which `just index` rewrites."""

    entries = [
        {
            "url": f"collections/{collection.name}/collection.json",
            "id": options.collection_id(collection),
            "title": collection.title,
            "description": collection.description,
            **({"homepage": options.repository} if options.repository else {}),
        }
        for collection in options.collections
    ]
    document: dict[str, Any] = {
        "version": 1,
        "title": options.title,
        "description": options.description,
    }

    if options.repository:
        document["homepage"] = options.repository

    document["collections"] = entries

    return json.dumps(document, indent=2) + "\n"


def collection_stub(options: CourseOptions, collection: CollectionSpec) -> str:
    """A collection index with no workshops yet, for `just index` to fill."""

    document: dict[str, Any] = {
        "version": 1,
        "id": options.collection_id(collection),
        "title": collection.title,
        "description": collection.description,
    }

    if options.repository:
        document["homepage"] = options.repository

    document["ordered"] = True
    document["workshops"] = []

    return json.dumps(document, indent=2) + "\n"


def justfile(options: CourseOptions) -> str:
    """The common tasks, and the order of each collection."""

    repo = options.repository or f"https://github.com/OWNER/{options.name}"
    variables: list[str] = []
    index_recipes: list[str] = []
    index_names: list[str] = []

    for collection in options.collections:
        var = _variable(collection.name)
        index_names.append(f"index-{collection.name}")
        variables.append(
            _fill(
                """
§var_id := "§id"
§var_title := "§title"
§var_description := "§description"

# The §title collection, in the order to take it. OUTLINE.md is the
# design this list follows; `just index` writes the index in this order,
# skipping any not written yet, so the order lives here and nowhere else.
§var := ""
""",
                var=var,
                var_id=f"{var}_id",
                var_title=f"{var}_title",
                var_description=f"{var}_description",
                id=options.collection_id(collection),
                title=collection.title,
                description=collection.description.replace('"', '\\"'),
            )
        )
        index_recipes.append(
            _fill(
                """
# Write or refresh collections/§name/collection.json in the collection's order.
index-§name:
    #!/usr/bin/env bash
    set -euo pipefail
    dirs=()
    for name in {{§var}}; do
        if [ -d "workshops/$name" ]; then
            dirs+=("workshops/$name")
        fi
    done
    if [ ${#dirs[@]} -eq 0 ]; then
        echo "No §name workshops under workshops/ yet; collections/§name/collection.json is left as it is"
        exit 0
    fi
    uv run jupyter workshop index "${dirs[@]}" --root . --out collections/§name/collection.json --repo "{{repo}}" --id "{{§var_id}}" --title "{{§var_title}}" --description "{{§var_description}}" --homepage "{{repo}}" --ordered
""",
                name=collection.name,
                var=var,
                var_id=f"{var}_id",
                var_title=f"{var}_title",
                var_description=f"{var}_description",
            )
        )

    lite_lint = (
        """
        uv run jupyter workshop lint "$dir" --frontend jupyterlite"""
        if options.lite
        else ""
    )
    lite_recipes = (
        _fill(
            """
# The JupyterLite self-test builds a site, serves it and drives it in a
# browser; it needs the lite extra, which the dev group installs.
# Self-test one workshop on the Pyodide kernel; extra args go to `jupyter workshop test`.
[positional-arguments]
test-lite NAME *ARGS:
    shift; uv run jupyter workshop test workshops/{{NAME}} --frontend jupyterlite "$@"

# The site carries every workshop and the catalog, starts in the workshop
# browser, and builds in lite/settings.json and lite/welcome.md; no
# workshop here uses a terminal, so the site is built without one.
# Build the JupyterLite site into dist/, carrying every workshop.
site *ARGS:
    uv run jupyter workshop lite workshops/*/ --out dist --no-terminal --catalog catalog.json --settings lite/settings.json --welcome lite/welcome.md "$@"

# Build the JupyterLite site and serve it locally to try it out.
site-serve *ARGS:
    uv run jupyter workshop lite workshops/*/ --out dist --no-terminal --catalog catalog.json --settings lite/settings.json --welcome lite/welcome.md --serve "$@"
"""
        )
        if options.lite
        else ""
    )
    lite_clean = "\n    rm -rf dist .jupyterlite.doit.db" if options.lite else ""

    return _fill(
        """# §title. Run `just` to list targets.

repo := "§repo"

# The catalog names every collection in this course, so one URL offers
# them all; each collection has an index of its own under
# collections/<name>/, with an id that never changes.
catalog_title := "§title"
catalog_description := "§description"
§variables
# List available targets.
default:
    @just --list

# Set up the environment: sync uv, download the self-test browser, link the authoring skill.
install:
    uv sync
    uv run playwright install chromium
    just skill

# The skill ships inside the jupyterlab-workshop package. Linking it into
# .claude/skills lets Claude Code load it without a copy in this
# repository, and it tracks the pinned release; `just bump` relinks it.
# Link the authoring skill from the installed package into .claude/skills.
skill:
    uv run jupyter workshop skill --link

# JupyterLab must run from this directory: the extension lists workshops/
# as installed, and the MCP live tools open workshops by paths relative
# to this root, such as workshops/<name>.
# Start JupyterLab from the checkout, listing the workshops in each collection's order.
[positional-arguments]
lab *ARGS:
    uv run jupyter lab --config=jupyter_lab_config.py "$@"

# Scaffold a new workshop under workshops/; extra args go to `jupyter workshop init`.
[positional-arguments]
new NAME *ARGS:
    shift; uv run jupyter workshop init workshops/{{NAME}} "$@"

# Lint the catalog, every collection index and every workshop, or only the workshops named.
lint *NAMES:
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob
    names=({{NAMES}})
    if [ ${#names[@]} -eq 0 ]; then
        uv run jupyter workshop lint catalog.json
        for index in collections/*/collection.json; do
            uv run jupyter workshop lint "$index"
        done
        dirs=(workshops/*/)
    else
        dirs=("${names[@]/#/workshops/}")
    fi
    if [ ${#dirs[@]} -eq 0 ]; then
        echo "No workshops under workshops/ yet"
        exit 0
    fi
    for dir in "${dirs[@]}"; do
        echo "== $dir"
        uv run jupyter workshop lint "$dir"§lite_lint
    done

# Render one workshop as HTML to check what a page looks like; extra args go to `jupyter workshop render`.
[positional-arguments]
render NAME *ARGS:
    shift; uv run jupyter workshop render workshops/{{NAME}} "$@"

# The self-test runs the workshop's actions and checks for real, as you,
# on this machine; only the workshop directory is protected, by a
# temporary copy. Read the workshop first.
# Self-test one workshop in a JupyterLab of its own; extra args go to `jupyter workshop test`.
[positional-arguments]
test NAME *ARGS:
    shift; uv run jupyter workshop test workshops/{{NAME}} "$@"

# Self-test every workshop, writing a JUnit report for each.
test-all:
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob
    for dir in workshops/*/; do
        name=$(basename "$dir")
        echo "== $dir"
        uv run jupyter workshop test "$dir" --junit "results-$name.xml"
    done
§lite_recipes
# Write or refresh every collection index and the catalog.
index: §index_names catalog

# The workshop directories are named one by one, in the collection's
# order, which is how `jupyter workshop index` is told the order to
# write; naming only the directories that exist lets the index be
# refreshed while the collection is still being written. The repository
# URL is given explicitly so the index does not depend on a git remote
# being configured in the checkout.§index_recipes
# Write or refresh catalog.json from the collection indexes, recorded by relative path.
catalog:
    uv run jupyter workshop catalog catalog.json collections/*/collection.json --relative --title "{{catalog_title}}" --description "{{catalog_description}}" --homepage "{{repo}}"

# Binder installs from binder/requirements.txt, so it is the locked
# runtime set (no dev group) exported from uv.lock, and is regenerated
# whenever the lock changes.
# Relock and export the runtime dependencies to binder/requirements.txt.
requirements:
    uv lock
    uv export --no-dev --no-hashes --no-annotate -o binder/requirements.txt

# `course update` moves the pin in pyproject.toml and the requirements,
# writes again every generated file that is still as generated, and
# reports the ones edited here, which are left alone.
# Pin a new jupyterlab-workshop release, refresh the generated files, relock and relink the skill.
bump VERSION:
    uv run jupyter workshop course update . --version {{VERSION}}
    just requirements
    just skill

# A workshop's kernelspec is registered for the user, outside the
# checkout, so removing the environment directory leaves a kernel in
# the launcher that points at a Python that no longer exists. The prune
# unregisters only the workshop kernelspecs whose environment is gone.
# Remove what opening, running and publishing the workshops leaves behind, and the kernelspecs left pointing at removed environments.
clean:
    rm -rf workshops/*/_workshop workshops/*/work workshops/*/dist workshops/*/scratch
    rm -f results-*.xml§lite_clean
    find . -type d -name .ipynb_checkpoints -not -path "./.venv/*" -exec rm -rf {} +
    find . -type d -name __pycache__ -not -path "./.venv/*" -not -path "./scratch/*" -exec rm -rf {} +
    uv run jupyter workshop kernels --prune

# Also remove the environment and the skill link; run `just install` afterwards.
distclean: clean
    rm -rf .venv .claude/skills/jupyterlab-workshop-authoring
""",
        title=options.title,
        repo=repo,
        description=options.description.replace('"', '\\"'),
        variables="".join(variables),
        lite_lint=lite_lint,
        lite_recipes=lite_recipes,
        index_names=" ".join(index_names),
        index_recipes="".join(index_recipes),
        lite_clean=lite_clean,
    )


def binder_post_build(options: CourseOptions) -> str:
    """Configure the Binder image: a wheelhouse for the workshops'
    environments and the JupyterLab overrides."""

    return _fill(
        """#!/bin/bash
# Configure the Binder image so JupyterLab starts in the workshop browser
# with the course's workshops listed as installed and ready to open, and
# trusts them without asking, since the visitor is the one who chose the
# link. A launch link naming a workshop still opens that workshop
# directly. The disabled features keep visitors to the supplied
# workshops: no other directories or URLs, no subscribing to collections
# or catalogs, no removing and no editing; Restart puts a workshop back
# as it started. The welcome message in binder/welcome.md greets the
# visitor once the session starts.
#
# The analytics setting reports progress events to the sink a
# collection index declares in its analytics block, without asking,
# when one does; the stubs `course init` wrote declare none, so until
# an index does, nothing is reported. The welcome message tells the
# visitor that progress is reported once it is. The second block is
# JupyterLab's own: it turns off the question about fetching Jupyter
# news, which a fresh container would otherwise put in front of every
# visitor before the welcome message.
set -euo pipefail

# Workshops with an environment of their own install their requirements
# and ipykernel with pip on first open. Download every workshop's
# requirements, and ipykernel, into a wheelhouse in the image and tell
# pip to look there first, so the install takes its wheels from disk
# rather than PyPI. It is find-links only, never no-index: pip still
# reaches PyPI for anything the wheelhouse lacks.
shopt -s nullglob

wheels="${HOME}/.wheels"

mkdir -p "$wheels"

for requirements in workshops/*/requirements.txt; do
    python -m pip download --disable-pip-version-check -d "$wheels" -r "$requirements"
done

python -m pip download --disable-pip-version-check -d "$wheels" ipykernel

mkdir -p "${HOME}/.config/pip"

cat > "${HOME}/.config/pip/pip.conf" <<CONF
[global]
find-links = ${wheels}
CONF

settings="${NB_PYTHON_PREFIX}/share/jupyter/lab/settings"

mkdir -p "$settings"

cat > "$settings/overrides.json" <<'JSON'
§overrides
JSON

echo "Wrote the JupyterLab overrides to $settings/overrides.json"
""",
        overrides=_overrides(options, "binder/welcome.md", trusted=True),
    )


def devcontainer(options: CourseOptions) -> str:
    """The Codespaces container: the same JupyterLab as Binder, started
    in the background with its port forwarded."""

    return _fill(
        """// Dev container for GitHub Codespaces: the same JupyterLab and pinned
// extension as the Binder image (binder/requirements.txt), started in the
// background once the codespace is up. Codespaces opens VS Code in the
// browser first, and when JupyterLab's port is forwarded VS Code shows a
// notification with a button that opens it in a new tab. The welcome
// file is opened in VS Code to explain where to click.
{
  "name": "§title",
  "image": "mcr.microsoft.com/devcontainers/python:§python",
  "postCreateCommand": "bash .devcontainer/setup.sh",
  "postStartCommand": "bash .devcontainer/start.sh",
  "portsAttributes": {
    "8888": {
      "label": "JupyterLab",
      "onAutoForward": "notify"
    }
  },
  "customizations": {
    "codespaces": {
      "openFiles": [".devcontainer/welcome.md"]
    }
  }
}
""",
        title=options.title.replace('"', '\\"'),
        python=options.python,
    )


def devcontainer_setup(options: CourseOptions) -> str:
    """Run once when a codespace is created: install, wheelhouse, overrides."""

    return _fill(
        """#!/bin/bash
# Run once when the codespace is created. Does what the Binder postBuild
# does, in the codespace: installs JupyterLab and the extension from the
# same pinned requirements the Binder image uses, fills a wheelhouse for
# the workshops' environments, and writes the JupyterLab overrides, with
# two differences, both because a codespace belongs to the person who
# created it, tied to their GitHub account, and persists, where a Binder
# session is an anonymous, temporary container. The welcome message is
# the Codespaces one. And workshops are not forced to trusted, so the
# learner is shown what a workshop asks to do and decides before it runs
# anything in their codespace.
set -euo pipefail

cd "$(dirname "$0")/.."

python -m pip install --no-cache-dir -r binder/requirements.txt

shopt -s nullglob

wheels="${HOME}/.wheels"

mkdir -p "$wheels"

for requirements in workshops/*/requirements.txt; do
  python -m pip download --disable-pip-version-check -d "$wheels" -r "$requirements"
done

python -m pip download --disable-pip-version-check -d "$wheels" ipykernel

mkdir -p "${HOME}/.config/pip"

cat > "${HOME}/.config/pip/pip.conf" <<CONF
[global]
find-links = ${wheels}
CONF

# The overrides live in JupyterLab's application settings directory. Ask
# JupyterLab for it rather than assuming the Python prefix, and use sudo
# for a directory this user cannot write.
settings="$(python -c 'import os; from jupyterlab.commands import get_app_dir; print(os.path.join(get_app_dir(), "settings"))')"

overrides="$(mktemp)"

cat > "$overrides" <<'JSON'
§overrides
JSON

if mkdir -p "$settings" 2>/dev/null && [ -w "$settings" ]; then
  install -m 644 "$overrides" "$settings/overrides.json"
else
  sudo mkdir -p "$settings"
  sudo install -m 644 "$overrides" "$settings/overrides.json"
fi

rm -f "$overrides"

echo "Wrote the JupyterLab overrides to $settings/overrides.json"
""",
        overrides=_overrides(options, ".devcontainer/welcome.md", trusted=False),
    )


def devcontainer_start() -> str:
    """Run each time a codespace starts: JupyterLab in the background,
    without the codespace's GitHub credentials."""

    return """#!/bin/bash
# Run each time the codespace starts. Starts JupyterLab in the background,
# detached so it outlives this script, with the checkout as its root so the
# workshops, the indexes and the welcome file resolve as they do on
# Binder. Output goes to /tmp/jupyterlab.log.
#
# Token authentication is off so opening the forwarded port, from VS
# Code's notification or its Ports panel, goes straight into JupyterLab
# with no token to copy. That relies on the forwarded port staying
# private, the default, which only the codespace's owner, signed in to
# GitHub, can reach. The welcome file tells the learner not to make it
# public.
set -euo pipefail

cd "$(dirname "$0")/.."

log=/tmp/jupyterlab.log
status_url=http://127.0.0.1:8888/api/status

ready() {
  python -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)' \\
    "$status_url" 2>/dev/null
}

if ready; then
  echo "JupyterLab is already running on port 8888"
  exit 0
fi

# JupyterLab runs without the codespace's GitHub credentials: the token
# variables are dropped and git is given an empty credential helper, so
# nothing a workshop runs is handed a token for the learner's account.
# This narrows what workshop code can reach; it is not a sandbox.
setsid nohup env -u GITHUB_TOKEN -u GITHUB_CODESPACE_TOKEN \\
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \\
  python -m jupyterlab \\
  --no-browser \\
  --ServerApp.ip=0.0.0.0 \\
  --ServerApp.port=8888 \\
  --ServerApp.root_dir="$PWD" \\
  --IdentityProvider.token= \\
  --ServerApp.allow_remote_access=True \\
  --ServerApp.trust_xheaders=True \\
  > "$log" 2>&1 < /dev/null &

# Wait until JupyterLab answers before returning, so a failure shows in
# the creation log rather than being reported as success.
for _ in $(seq 120); do
  if ready; then
    echo "JupyterLab is running on port 8888; output is in $log"
    exit 0
  fi

  sleep 1
done

echo "JupyterLab did not answer within two minutes; the end of $log follows" >&2
tail -n 40 "$log" >&2 || true
exit 1
"""


def welcome(options: CourseOptions, host: str) -> str:
    """The message a learner is greeted with on a host: what the course
    is, how the host works, and that progress may be reported."""

    parts = "; ".join(f"**{collection.title}**" for collection in options.collections)
    about = (
        f"These are guided, hands-on workshops: {options.description}"
        if options.description
        else "These are guided, hands-on workshops."
    )
    collections = (
        f" The course has {len(options.collections)} parts: {parts}."
        if len(options.collections) > 1
        else ""
    )
    hosts = {
        "binder": """This session runs on [mybinder.org](https://mybinder.org), a free public
service, and it is temporary: anything you do here is gone when the
session ends, so finish a workshop in the session you started it in.
When you are done, whether you finished a workshop or not, shut the
session down rather than closing the browser tab, so the resources go
back to Binder for other users. The Finish dialog has a button for
this, and so does the File menu, under "Shut Down".""",
        "codespaces": """This session runs in a GitHub codespace, which opens in VS Code in the
browser. JupyterLab starts in the background, which takes a minute or
so the first time, and VS Code then shows a notification that the
application on port 8888 is available. Click its Open in Browser button
to open JupyterLab in a new tab. If the notification has gone, open the
Ports panel in VS Code and open the address of the port labelled
JupyterLab.

Leave the JupyterLab port's visibility as Private. JupyterLab here asks
for no password or token, because a private port can only be reached by
you, signed in to GitHub. Making the port public would let anyone who
has its address run code in your codespace.

When you open a workshop, JupyterLab shows what it will do in this
codespace and asks you how far to trust it. Choose Trust to let its
actions run as the workshop intends. The workshops are not trusted for
you, because the codespace is yours, tied to your GitHub account, and
JupyterLab runs without the GitHub token the codespace holds.

The codespace uses your monthly Codespaces allowance while it runs and
stops by itself after a period of inactivity; your work is kept. Resume
it from [github.com/codespaces](https://github.com/codespaces), and
delete it there when you have finished with the workshops.""",
        "lite": """This JupyterLab runs entirely in your browser. There is no server and
no account: the page is static, and the Python is built to WebAssembly
and runs in this tab. Your work is kept in this browser's own storage,
so it survives a reload and is still here on a later visit, but it
belongs to this browser, and clearing the site's data discards it.""",
    }

    return _fill(
        """# Welcome to §title

§about§collections Each
workshop takes a question you might have and has you answer it by
doing it, in this JupyterLab, with the workshop checking your work as
you go. The workshop browser lists the workshops in the order to take
them; open the first, and the Finish dialog at the end of each offers
the next.

§host

Where a workshop reports progress to an analytics service, what is
reported is which pages you visited, which actions you clicked and what
the checks found, and when, so it can be seen where the workshops are
clear and where they are not. The session is anonymous. Nothing you
type is sent, nor the notebooks you make, the output of cells, or the
answers you give to forms.
""",
        title=options.title,
        about=about,
        collections=collections,
        host=hosts[host],
    )


def test_workflow(options: CourseOptions) -> str:
    """Lint and self-test everything on each push."""

    lite_lint = (
        """
            uv run jupyter workshop lint "$workshop" --frontend jupyterlite"""
        if options.lite
        else ""
    )
    lite_test = (
        """
            uv run jupyter workshop test "$workshop" --frontend jupyterlite --junit "results-$name-lite.xml\""""
        if options.lite
        else ""
    )

    return _fill(
        """# Lint the catalog, every collection index and every workshop, and
# self-test every workshop, which is what `just lint` and `just test-all`
# do locally. The commands are spelled out rather than run through the
# Justfile so the job needs nothing but uv. A workshop with an
# environment of its own installs it during the self-test, so the job
# needs network access.
name: test

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: astral-sh/setup-uv@v6
        with:
          enable-cache: true

      - name: Install the locked environment and the self-test browser
        run: |
          uv sync
          uv run playwright install --with-deps chromium

      - name: Lint the catalog, every collection and every workshop
        run: |
          set -euo pipefail
          shopt -s nullglob
          uv run jupyter workshop lint catalog.json
          for index in collections/*/collection.json; do
            uv run jupyter workshop lint "$index"
          done
          for workshop in workshops/*/; do
            uv run jupyter workshop lint "$workshop"§lite_lint
          done

      - name: Self-test every workshop
        run: |
          set -euo pipefail
          shopt -s nullglob
          for workshop in workshops/*/; do
            name=$(basename "$workshop")
            uv run jupyter workshop test "$workshop" --junit "results-$name.xml"§lite_test
          done

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: results
          path: results-*.xml
          if-no-files-found: ignore
""",
        lite_lint=lite_lint,
        lite_test=lite_test,
    )


def pages_workflow() -> str:
    """Publish the JupyterLite site on GitHub Pages once the tests pass."""

    return """# Publish the course as a JupyterLite site on GitHub Pages, but only
# after the test workflow has passed on main, so nothing reaches the site
# that has not been linted and self-tested on both frontends. The build
# is `just site`. GitHub Pages must be enabled for the repository with
# GitHub Actions as its source before the first run deploys anything.
name: pages

on:
  workflow_run:
    workflows: [test]
    types: [completed]
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# One deployment at a time, and never cancel one part way: a half
# published site is worse than an old one.
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}

      - uses: astral-sh/setup-uv@v6
        with:
          enable-cache: true

      - uses: actions/configure-pages@v5

      - name: Install the locked environment
        run: uv sync

      - name: Build the JupyterLite site
        run: |
          set -euo pipefail
          uv run jupyter workshop lite workshops/*/ \\
            --out dist \\
            --no-terminal \\
            --catalog catalog.json \\
            --settings lite/settings.json \\
            --welcome lite/welcome.md

      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
"""


def lite_settings() -> str:
    """The settings built into the JupyterLite site."""

    return (
        json.dumps(
            {
                "@jupyterlab-workshop/labextension:panel": {
                    "disabledFeatures": list(DISABLED_FEATURES),
                    "analytics": dict(ANALYTICS_POLICY),
                }
            },
            indent=2,
        )
        + "\n"
    )


def agents(options: CourseOptions) -> str:
    """The guidance an agent working in the course follows."""

    collections = "\n".join(
        f"- `{collection.name}`: {collection.title}."
        + (f" {collection.description}" if collection.description else "")
        for collection in options.collections
    )
    frontend = (
        """## JupyterLite is a target

The workshops run in JupyterLab on a real CPython and as a JupyterLite
site in the browser, on the Pyodide kernel, so every workshop is
written for both. That rules out anything the browser cannot do: no
terminal, no threads or subprocesses, no sockets, no packages beyond
what Pyodide ships or can install from a pure Python wheel. Manifests
declare `frontends: [jupyterlab, jupyterlite]`, and lint and the
self-test run on both (`just lint`, `just test-lite`). Everything a
workshop writes stays inside its own workspace, the `work/` directory
the extension creates on first open and empties on Restart; files a
workshop ships for the learner go under `files/`."""
        if options.lite
        else """## JupyterLab only

The workshops run in JupyterLab on a real CPython, and manifests
declare no `frontends` list, which says JupyterLab alone. A workshop
that needs a package declares an `environment` with a
`requirements.txt` in its directory, pinned to the release it teaches,
so the extension builds an isolated environment under `_workshop/venv`
and registers its kernel; the welcome page carries the
`environment-create` action as its first step. Nothing taught goes in
`pyproject.toml`. Everything a workshop writes stays inside its own
workspace, the `work/` directory the extension creates on first open
and empties on Restart; files a workshop ships for the learner go under
`files/`. Nothing under the home directory, no global configuration, no
installs into the JupyterLab environment."""
    )

    return _fill(
        """# Agent guidance for §name

## Project

This repository is a course: guided JupyterLab workshops on §subject.
The workshops run on the jupyterlab-workshop extension: each is a
directory under `workshops/` holding a `workshop.yaml` manifest and
MyST Markdown pages whose fenced directives are clickable actions. See
README.md for how the workshops are run, on Binder, in Codespaces and
locally.

The course is organised as collections, each a part of it with an
index of its own under `collections/<name>/collection.json` and a
permanent id, and `catalog.json` at the root names them all, so one
URL offers the whole course:

§collections

Every workshop of every collection lives flat under `workshops/`,
because the extension lists only the directories directly under that
one directory; which collection a workshop belongs to is recorded in
the indexes alone, and `just index` writes them.

OUTLINE.md is the design of the course: what it is and is not, how the
workshops group into parts, one entry per workshop, the decisions that
apply to all of them, and a status table. Read it before adding or
changing a workshop, follow the name and scope it gives, and update it
when the work is done. It is written before the first workshop is.

The scratch/ directory is not part of the git repository. It holds
temporary working files and plans. Its contents come and go, so never
reference scratch/ files by name from code or documentation that will
be committed.

## Source material

What the workshops teach comes from the subject's own documentation
and source, never from memory. OUTLINE.md names the sources, and where
in them each collection's material is. Check behaviour against a real
interpreter rather than memory, and against the Python the learner
gets, which is the one JupyterLab runs on, §python on Binder and in a
codespace. Do not invent functions, arguments or behaviour.

§frontend

## Tooling: always use uv and the Justfile

All Python environment and package management for this repository is
done with [uv](https://docs.astral.sh/uv/). Never use the Python venv
module or bare pip here. Run commands in the project environment with
`uv run`, for example `uv run jupyter workshop lint workshops/<name>`.

The Justfile wraps the common tasks; run `just --list` to see them all
and prefer them over the underlying commands:

- `just install` syncs the environment, downloads the self-test
  browser and links the authoring skill into `.claude/skills`.

- `just lab` starts JupyterLab from this directory. It must run from
  here: the extension lists `workshops/` as installed, and the MCP live
  tools open workshops by paths relative to this root, so a workshop is
  `workshops/<name>` to `open_workshop`.

- `just new <name>` scaffolds a workshop; `just lint` lints the catalog,
  every collection index and every workshop; `just render <name>`
  renders one to HTML; `just test <name>` self-tests one; `just index`
  writes or refreshes every collection index and the catalog.

- `just requirements` relocks and rewrites `binder/requirements.txt`
  after a dependency change; `just bump <version>` moves the
  jupyterlab-workshop pin and refreshes the files the scaffold wrote.

The order of a collection lives in the Justfile, as the list of
workshop names the `index-<collection>` recipe passes to
`jupyter workshop index` one by one, which is how the tool is told the
order to write. Adding a workshop means adding its name to that list,
in its place, as well as to OUTLINE.md and the README.

## Writing workshops

Use the `jupyterlab-workshop-authoring` skill for the format, the
actions and checks, the rules that keep lint and the self-test green,
how to read test output, and how a course is designed and kept. `just
install` links it into `.claude/skills` from the installed package, so
it always matches the pinned release. If the skill is not loaded, read
the `workshop://skill` resource from the `workshop` MCP server before
writing anything; its reference files are
`workshop://skill/references/<name>`.

The skill is a summary. The full documentation of the format is
published at https://jupyterlab-workshop.readthedocs.io, for the
release pinned in `pyproject.toml`: checks, variables, environments,
layouts, platforms, trust, settings, collections, limitations and
troubleshooting. Read there before guessing.

The `workshop` MCP server configured in `.mcp.json` provides the file
tools (`init`, `lint`, `render`, `pages`, `test`, `index`) and, when
`just lab` is running with a workshop open in author mode, the live
tools (`open_workshop`, `session_status`, `run_action`, `run_page`,
`run_workshop`). Workshop directories passed to the file tools are
relative to this directory: `workshops/<name>`.

Conventions for the workshops here:

- Directory names are short kebab-case phrases naming the question a
  workshop answers, not the mechanism, with no numeric prefix. The
  collection index carries the order, so names stay stable as
  workshops are inserted, split or moved. Names must be unique across
  every collection in this repository, since all workshops share one
  directory. Titles are sentence case and read as what the learner
  will do.

- Workshops are numbered from 1 within each collection, in the outline,
  the README and the browser alike; the collections are the parts of
  the course and are numbered in catalog order with roman numerals.

- Each workshop is self-contained and does not depend on another having
  been completed, even though the collection orders them. A workshop
  that builds on an idea restates it in a sentence and ships whatever
  code it needs.

- Before any code goes into a cell, run it against a real interpreter
  on the Python learners get.

- After adding a workshop or editing a manifest, run `just index` to
  refresh the collection index and the catalog, and add or update the
  workshop's entry in the README's list, in the order the collection
  gives.

- Lint every change. Lint must be clean, warnings included, before a
  workshop is considered done, and a workshop is not done until
  `just test <name>` is green.

## Never run a workshop without checking what it does

`jupyter workshop test`, the MCP `test`, `run_action`, `run_page` and
`run_workshop` tools, and author mode's Run actions and Run checks all
run the workshop's code for real, as the user, on this machine, with
their home directory and Python environment. The self-test protects only
the workshop directory, by working on a temporary copy; the live tools
work on the directory itself and leave state behind.

Before running any of them, read every cell body and every check in the
workshop. Run them unasked only when everything stays inside the
workshop directory and installs nothing beyond its own environment,
which the conventions above require, so a workshop that follows them is
safe to test. If a workshop reaches outside its directory, say so and
wait to be told.

## Style

- Do not use emdashes in any file in this project. Rephrase with
  commas, parentheses, colons, or separate sentences instead.

- In bulleted lists where items run to multiple lines, put a blank line
  between the bullets, in Markdown files and any other prose. Be
  consistent within a list.

- Workshop prose follows the skill's style guide: short pages, one step
  per action, say why before how, and checks that tell the learner what
  is wrong rather than only that it is.

## Git

- The default branch is `main`, and there is no development branch:
  Binder and the raw index URLs point at `main`.

- Git commit messages must never include a co-authored-by agent message
  or any similar agent attribution trailer.

- An AI agent must never commit changes on its own initiative. Finish
  the piece of work, summarize it, and wait to be told to commit.
  Permission to commit applies only to the work it was given for; it
  does not carry forward to later steps of a multi-step plan.
""",
        name=options.name,
        subject=options.description or options.title,
        collections=collections,
        python=options.python,
        frontend=frontend,
    )


def outline(options: CourseOptions) -> str:
    """The design document, with its sections in place and nothing
    designed yet."""

    several = len(options.collections) > 1
    parts: list[str] = []

    for number, collection in enumerate(options.collections, start=1):
        label = (
            f"Part {_roman(number)}: {collection.title}"
            if several
            else collection.title
        )

        parts.append(
            _fill(
                """## §label

### Shape of the §title collection

How the workshops group into movements, each with a sentence on what
the learner can do after it. The length of each workshop and the
total. Whether each is self-contained.

### The §title workshops

One entry per workshop, in the order to take them, numbered from 1,
each detailed enough that a workshop can be written from it without
asking what it is for:

```markdown
### 1. `directory-name`: Title

One line on the question the workshop answers.

Two to four paragraphs: where it starts, what the learner does page by
page, what they see, the surprise it builds to, and how it closes or
hands on to the next workshop. Name the exact functions, values and
outputs, checked against a real interpreter.

- Format: notebook, notebook with a code pane, or terminal and files.

- Requires: packages beyond the extension, if any.

- Source: the documentation pages or specification sections it draws on.

- Length: 15 minutes.
```

### Topics the §title collection leaves out

What was considered and not taken, and why, so it is not proposed
again.
""",
                label=label,
                title=collection.title,
            )
        )

    repository_section = (
        """## Collections and the repository

Why the collections share one repository, where the order of each
lives (the Justfile), the ids and their form, how the browser presents
the collections, the differences between Binder, Codespaces and local
runs, and CI.

"""
        if several
        else ""
    )

    return _fill(
        """# §title: outline

The design of this course: how it is organised, what each workshop
covers, its name and format, and the decisions that cut across all of
them. It is a living document. Read it before adding a workshop, and
update it when one is added, changed or dropped: the status table at
the end records where each workshop stands, and the open questions
section shrinks as they are settled. The design is settled here, before
the first workshop of a collection is written.

## What this course is

§description

Each collection in a paragraph: how many workshops, what it teaches,
what it assumes, how it relates to the other collections, and what is
deliberately out of scope.

## Source material

The documentation, source and other material the workshops draw on,
collection by collection, and what each is used for. Everything the
workshops say about the subject comes from here, never from memory.

§parts
## Naming

Directory names are kebab-case phrases naming the question a workshop
answers, not the mechanism, with no numeric prefix. Titles are sentence
case. Names are unique across the course. Collection ids are
`§prefix/§name/<collection>`, chosen once and never changed, since a
collection's id is its identity to subscribers and to analytics.

## Later collections

Candidates for collections not yet designed.

## Decisions that cut across the workshops

A bold run-in heading and one paragraph each, giving the decision and
the reason for it: the frontend and Python version, the format, shipped
code, whether learners type code, prediction before execution, checks,
a running example, timing, platforms, and what "done" means.

§repository_section## Extension features the workshops use

The patterns settled from the extension's documentation so each
workshop does not rediscover them.

## Known blockers

Problems in the extension that stop a workshop, and the release that
fixed each.

## Open questions

None at present.

## Status

The writing order, which is usually the collection order, then a table
per collection:

| Workshop | Status |
| -------- | ------ |

Planned: designed in the outline, not yet written. Written: the pages
exist and lint is clean. Done: `just test <name>` is green, and the
workshop is in the index and the README.
""",
        title=options.title,
        description=options.description or "What the course teaches, and to whom.",
        parts="\n".join(parts),
        prefix=options.id_prefix,
        name=options.name,
        repository_section=repository_section,
    )


def readme(options: CourseOptions) -> str:
    """The README learners see on GitHub."""

    repo = options.repository
    owner_repo = _owner_repo(repo)
    badges: list[str] = []
    launch: list[str] = []

    if owner_repo:
        binder = f"https://mybinder.org/v2/gh/{owner_repo}/main?urlpath=lab"
        codespaces = f"https://codespaces.new/{owner_repo}?quickstart=1"

        badges.append(
            f"[![Launch on Binder](https://mybinder.org/badge_logo.svg)]({binder})"
        )
        badges.append(
            "[![Open in GitHub Codespaces](https://img.shields.io/badge/launch-codespaces"
            f"-579ACA?logo=github&logoColor=white)]({codespaces})"
        )
        badges.append(
            f"[![test]({repo}/actions/workflows/test.yml/badge.svg)]"
            f"({repo}/actions/workflows/test.yml)"
        )
        launch.append(
            f"Nothing to install: start the workshops on [mybinder.org]({binder}) with "
            f"no account, or in [GitHub Codespaces]({codespaces}) with a GitHub "
            "account."
        )

        if options.lite:
            owner, name = owner_repo.split("/", 1)
            site = f"https://{owner.lower()}.github.io/{name}/"

            badges.append(
                f"[![Launch in JupyterLite](https://jupyterlite.rtfd.io/en/latest/_static/badge.svg)]({site})"
            )
            launch.append(
                f"Or open them [as a JupyterLite site]({site}), which runs in the "
                "browser alone."
            )
    else:
        launch.append(
            "Nothing to install once the repository is on GitHub: the Binder and "
            "Codespaces files are in place, and the launch links go here."
        )

    sections = "\n".join(
        _fill(
            """### §title

§description No workshops are written yet; see [OUTLINE.md](OUTLINE.md)
for the design.
""",
            title=collection.title,
            description=collection.description or "",
        )
        for collection in options.collections
    )
    subscribe = (
        _fill(
            """## Subscribe from your own JupyterLab

In a JupyterLab with the extension installed, subscribe to the catalog
or to one collection from the workshop browser's Collections dialog:

```
https://raw.githubusercontent.com/§owner_repo/main/catalog.json
§indexes```
""",
            owner_repo=owner_repo,
            indexes="".join(
                f"https://raw.githubusercontent.com/{owner_repo}/main/{path}\n"
                for path in _collection_paths(options)
            ),
        )
        if owner_repo
        else ""
    )

    return _fill(
        """# §title

§badges

§launch

§description

The workshops run on
[jupyterlab-workshop](https://github.com/GrahamDumpleton/jupyterlab-workshop),
a JupyterLab extension that shows the instructions in a side panel with
clickable actions that drive the session, and checks what you have done
as you go. Each workshop is a directory of a `workshop.yaml` manifest
and Markdown pages. See [OUTLINE.md](OUTLINE.md) for the design of the
course.

## The collections

Each collection is a part of the course: its workshops are numbered in
the order to take them, and the Finish dialog of each offers the next.
A [catalog](catalog.json) names every collection, so one URL offers them
all.

§sections
## Run locally

With [uv](https://docs.astral.sh/uv/) installed, from a checkout:

```
uv sync --no-dev
uv run jupyter lab --config=jupyter_lab_config.py
```

or `just lab`. Without cloning, `uvx --from "jupyterlab-workshop[lab]"
jupyter-workshop launch --catalog <raw catalog URL>` runs the course in
a directory of its own.

§subscribe
## What is in the repository

```
AGENTS.md                guidance for agents writing workshops here
OUTLINE.md               the design of the course
Justfile                 every common task, and the order of each collection
pyproject.toml           the uv project: JupyterLab and the pinned extension
catalog.json             names every collection, written by `just index`
collections/<name>/      one collection index per part of the course
workshops/<name>/        one workshop each, every collection's side by side
binder/                  the Binder image: runtime, requirements, settings, welcome
.devcontainer/           the Codespaces container
.github/workflows/       lint and self-test on each push
course.json              what `jupyter workshop course init` wrote, for `course update`
```

## Writing and checking workshops

`just install` sets up the environment and links the authoring skill;
`just new <name>` scaffolds a workshop under `workshops/`; `just lint`
and `just test <name>` check it; `just index` writes the collection
indexes and the catalog in the order the Justfile gives. `just bump
<version>` moves to a new release of the extension and refreshes the
files the scaffold wrote.
""",
        title=options.title,
        badges="\n".join(badges),
        launch="\n".join(launch),
        description=options.description,
        sections=sections,
        subscribe=subscribe,
    )


def _owner_repo(repository: str) -> str:
    if not repository:
        return ""

    parts = urlsplit(repository)

    if parts.netloc.lower() != "github.com":
        return ""

    path = parts.path.strip("/")

    if path.endswith(".git"):
        path = path[:-4]

    return path if path.count("/") == 1 else ""


def _roman(number: int) -> str:
    numerals = (
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    )
    text = ""

    for value, numeral in numerals:
        while number >= value:
            text += numeral
            number -= value

    return text
