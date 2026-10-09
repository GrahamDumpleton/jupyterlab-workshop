"""The ``jupyter workshop`` command line tool.

Registered as the ``jupyter-workshop`` console script, which the
``jupyter`` launcher picks up as ``jupyter workshop``. Lint and render run
the core package's Node bundle shipped inside this package, so they need
``node`` on the path; the other commands are pure Python.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import __version__ as VERSION
from .catalog import (
    CatalogError,
    CatalogMetadata,
    build_catalog,
    is_http_url,
    parse_catalog,
    refresh_entries,
    resolve_location,
)
from .collection import (
    CollectionError,
    CollectionMetadata,
    build_collection,
    checkout_root,
    guess_repository,
    index_repository,
    list_courses,
    list_installed,
    parse_collection,
)
from .collection import (
    load_collection as _load_collection_index,
)
from .course import (
    CollectionSpec,
    CourseError,
    CourseOptions,
    id_prefix_for,
    update_course,
    write_course,
)
from .fetch import FetchError
from .gist import (
    BINDER_LAUNCHER,
    LAUNCHER_PYTHONS,
    RECORD_FILE,
    GistError,
    flatten_workshop,
    read_record,
    resolve_token,
    send_gist,
    write_flat,
)
from .github import GitHubError, publish_repository
from .install import (
    DEFAULT_DIRECTORY,
    apply_update,
    find_updates,
    install_collection,
    remove_installed,
    select_installed,
    subscribe,
    unsubscribe,
)
from .library import (
    COURSES_DIRECTORY,
    DEFAULT_LIBRARY_NAME,
    LIBRARY_VARIABLE,
    LibraryError,
    default_library,
    empty_library,
    is_library,
    library_directory,
    link_course,
    needs_upgrade,
    plan_upgrade,
    read_library,
    repair_links,
    unlink_course,
    upgrade_library,
    write_library,
)
from .lite import LiteBuildOptions, LiteError, build_lite_site, serve_directory
from .promotion import PromotionError, promote_workshop
from .publish import PublishError, publish_workshop
from .scaffold import (
    GATING,
    TEMPLATES,
    initialize_repository,
    slug,
    write_scaffold,
)
from .skill import SKILL_NAME, skill_directory
from .tree import STATE_DIR, TreeError, restore_tree

PACKAGE_DIR = Path(__file__).resolve().parent

NODE_BUNDLE = PACKAGE_DIR / "nodejs" / "workshop-cli.cjs"

SCHEMA_FILE = PACKAGE_DIR / "schema" / "workshop.schema.json"

COLLECTION_SCHEMA_FILE = PACKAGE_DIR / "schema" / "collection.schema.json"

CATALOG_SCHEMA_FILE = PACKAGE_DIR / "schema" / "catalog.schema.json"

EVENTS_SCHEMA_FILE = PACKAGE_DIR / "schema" / "events.schema.json"

LIBRARY_SCHEMA_FILE = PACKAGE_DIR / "schema" / "library.schema.json"

PLATFORMS = ["linux", "macos", "windows"]

FRONTENDS = ["jupyterlab", "jupyterlite"]

CAPABILITIES = [
    "terminal",
    "write-files",
    "install-packages",
    "kernel-exec",
    "auto-run",
    "ui-settings",
    "web-proxy",
]


class CliError(Exception):
    """A command could not be completed."""


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command line tool and return its exit code."""

    parser = build_parser()
    arguments, passthrough = split_passthrough(
        list(sys.argv[1:] if argv is None else argv)
    )
    args = parser.parse_args(arguments)
    args.passthrough = passthrough

    try:
        result: int = args.func(args)
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)

        return 2
    except KeyboardInterrupt:
        return 130

    return result


def split_passthrough(argv: list[str]) -> tuple[list[str], list[str]]:
    """Split a command line at its first ``--``: what follows is handed
    on untouched to the program a command runs, ``jupyter lab`` for
    ``launch``, rather than parsed here."""

    if "--" not in argv:
        return argv, []

    index = argv.index("--")

    return argv[:index], argv[index + 1 :]


def build_parser() -> argparse.ArgumentParser:
    """The argument parser with every subcommand."""

    parser = argparse.ArgumentParser(
        prog="jupyter workshop",
        description="Create, check, render, self-test and publish workshops.",
    )
    parser.add_argument("--version", action="version", version=VERSION)

    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="scaffold a new workshop directory")
    init.add_argument("directory", type=Path)
    init.add_argument("--name", help="workshop name (default: from the directory)")
    init.add_argument("--title", help="workshop title (default: from the name)")
    init.add_argument(
        "--ci", action="store_true", help="also write a GitHub Actions workflow"
    )
    init.add_argument(
        "--template",
        choices=TEMPLATES,
        default="starter",
        help="starter (terminal, file and quiz), blank, or notebook",
    )
    init.add_argument(
        "--platform",
        action="append",
        dest="platforms",
        choices=PLATFORMS,
        help="platform the workshop supports; repeat for several "
        "(default linux, macos)",
    )
    init.add_argument(
        "--frontend",
        action="append",
        dest="frontends",
        choices=FRONTENDS,
        help="frontend the workshop supports; repeat for several "
        "(default: jupyterlab only, which needs no list)",
    )
    init.add_argument(
        "--capability",
        action="append",
        dest="capabilities",
        choices=CAPABILITIES,
        help="capability to declare; repeat for several (default: the template's)",
    )
    init.add_argument(
        "--gating", choices=GATING, default="soft", help="page gating (default soft)"
    )
    init.add_argument(
        "--no-git",
        action="store_true",
        help="do not make the new directory a git repository (one inside a "
        "repository already, such as a course's workshops/, never is)",
    )
    init.set_defaults(func=command_init)

    lint = commands.add_parser(
        "lint", help="report problems in a workshop, or check a collection or catalog"
    )
    lint.add_argument(
        "directory",
        type=Path,
        help="workshop directory, or a collection.json or catalog.json file",
    )
    lint.add_argument("--json", action="store_true", help="print the report as JSON")
    lint.add_argument(
        "--platform",
        choices=PLATFORMS,
        help="platform to select body variants for (default linux)",
    )
    lint.add_argument(
        "--frontend",
        choices=FRONTENDS,
        help="frontend to select body variants for (default jupyterlab); "
        "jupyterlite implies the emscripten platform",
    )
    lint.set_defaults(func=command_lint)

    render = commands.add_parser("render", help="render pages to standalone HTML")
    render.add_argument("directory", type=Path)
    render.add_argument("page", nargs="?", help="page id or path; default all pages")
    render.add_argument("--out", type=Path, help="write to a file instead of stdout")
    render.add_argument(
        "--platform",
        choices=PLATFORMS,
        help="platform to select body variants for (default linux)",
    )
    render.add_argument(
        "--frontend",
        choices=FRONTENDS,
        help="frontend to select body variants for (default jupyterlab)",
    )
    render.set_defaults(func=command_render)

    pages = commands.add_parser("pages", help="list the pages of a workshop")
    pages.add_argument("directory", type=Path)
    pages.set_defaults(func=command_pages)

    schema = commands.add_parser("schema", help="print the manifest JSON schema")
    kind = schema.add_mutually_exclusive_group()
    kind.add_argument(
        "--collection",
        action="store_true",
        help="print the collection index schema instead",
    )
    kind.add_argument(
        "--catalog", action="store_true", help="print the catalog schema instead"
    )
    kind.add_argument(
        "--events",
        action="store_true",
        help="print the progress events schema instead",
    )
    kind.add_argument(
        "--library",
        action="store_true",
        help="print the workshop library registry schema instead",
    )
    schema.set_defaults(func=command_schema)

    collection = commands.add_parser(
        "collection", help="add published entries to a collection index file"
    )
    collection.add_argument(
        "index", type=Path, help="collection.json file to create or update"
    )
    collection.add_argument(
        "entries",
        nargs="+",
        type=Path,
        help="entry files written by publish (*.collection.json)",
    )
    _add_metadata_arguments(collection, "collection", tags=True)
    collection.set_defaults(func=command_collection)

    index = commands.add_parser(
        "index", help="build a collection index for the workshops in a repository"
    )
    index.add_argument(
        "directories",
        type=Path,
        nargs="*",
        default=[Path(".")],
        help="directories searched for workshops (default: .)",
    )
    index.add_argument(
        "--root",
        type=Path,
        help="checkout the sources are relative to (default: the git checkout)",
    )
    index.add_argument(
        "--out",
        type=Path,
        help="index file to create or update (default: collection.json under the root)",
    )
    index.add_argument(
        "--repo", help="repository URL learners fetch from (default: the git origin)"
    )
    index.add_argument(
        "--ref", help="branch or tag learners fetch (default: the checked-out branch)"
    )
    _add_metadata_arguments(index, "collection", tags=True)
    index.set_defaults(func=command_index)

    catalog = commands.add_parser(
        "catalog", help="build or refresh a catalog from collection indexes"
    )
    catalog.add_argument(
        "catalog", type=Path, help="catalog.json file to create or update"
    )
    catalog.add_argument(
        "collections",
        nargs="*",
        help="collection index URLs or files to add or refresh "
        "(default: refresh every entry already listed)",
    )
    catalog.add_argument(
        "--relative",
        action="store_true",
        help="record collection files by their path relative to the catalog file",
    )
    _add_metadata_arguments(catalog, "catalog", tags=False)
    catalog.set_defaults(func=command_catalog)

    install = commands.add_parser(
        "install",
        help="install every workshop of a collection into a workshops directory",
    )
    install.add_argument("collection", help="collection index: a URL or a file")
    install.add_argument(
        "--root",
        type=Path,
        default=Path.cwd(),
        help="the JupyterLab root the workshops directory sits under "
        "(default: the current directory)",
    )
    install.add_argument(
        "--directory",
        default=DEFAULT_DIRECTORY,
        help=f"directory under the root to install into (default: {DEFAULT_DIRECTORY})",
    )
    install.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="NAME",
        help="install only this workshop of the collection; repeat for several",
    )
    install.add_argument(
        "--platform",
        choices=PLATFORMS,
        default="",
        help="skip workshops that list platforms without this one "
        "(default: install every workshop)",
    )
    install.add_argument(
        "--frontend",
        choices=FRONTENDS,
        default="",
        help="skip workshops that do not support this frontend; a workshop "
        "listing none supports jupyterlab only (default: install every workshop)",
    )
    install.set_defaults(func=command_install)

    library = commands.add_parser(
        "library",
        help="start JupyterLab on your workshop library",
        description=(
            "Start JupyterLab with a workshop library as its root: a directory "
            "holding library.json, with what you make yourself under personal/, "
            "single workshops in personal/workshops/ and courses in "
            "personal/courses/, and what you install under installed/. The "
            "library is created on first use, and one made by an earlier "
            "release is offered an upgrade to this layout. DIR defaults to "
            f"${LIBRARY_VARIABLE} when set, else ~/{DEFAULT_LIBRARY_NAME}. "
            "Arguments after -- are passed to jupyter lab."
        ),
    )
    library.add_argument(
        "directory",
        nargs="?",
        type=Path,
        help=f"the library directory (default: ${LIBRARY_VARIABLE} or "
        f"~/{DEFAULT_LIBRARY_NAME})",
    )
    library.add_argument(
        "--init-only",
        action="store_true",
        help="create the library if needed and stop, without starting JupyterLab",
    )
    library.add_argument(
        "--yes",
        action="store_true",
        help="upgrade a library in the previous layout without asking",
    )
    library.add_argument(
        "--collection",
        action="append",
        default=[],
        help="collection URL or collection.json to add for the session "
        "(repeatable); subscribe to keep it",
    )
    library.add_argument(
        "--trust",
        choices=["trusted", "restricted", "ask"],
        help="force the trust level for the session instead of asking",
    )
    library.add_argument(
        "--port", type=int, help="port to serve on (default: a free one)"
    )
    library.add_argument(
        "--no-browser", action="store_true", help="print the link without opening it"
    )
    library.add_argument(
        "--fresh",
        action="store_true",
        help="use private JupyterLab workspaces and user settings, as test does",
    )
    library.add_argument("--token", help="token to serve with (default: a random one)")
    library.set_defaults(func=command_library)

    for verb, kind_help in (
        ("subscribe", "subscribe a workshop library to a collection or catalog"),
        ("unsubscribe", "unsubscribe a workshop library from a collection or catalog"),
    ):
        command = commands.add_parser(verb, help=kind_help)
        command.add_argument(
            "location",
            help="collection or catalog index: a URL, or a path "
            "relative to the JupyterLab root",
        )
        command.add_argument(
            "--catalog",
            action="store_true",
            help="the location is a catalog rather than a collection",
        )
        _add_library_target_arguments(command)
        command.set_defaults(
            func=command_subscribe if verb == "subscribe" else command_unsubscribe
        )

    listing = commands.add_parser(
        "list", help="list the installed workshops and the subscriptions"
    )
    listing.add_argument(
        "--json", action="store_true", help="print the listing as JSON"
    )
    _add_library_target_arguments(listing)
    listing.set_defaults(func=command_list)

    update = commands.add_parser(
        "update",
        help="install newer versions of workshops their collections offer",
        description=(
            "Install the newest version a collection lists of each workshop "
            "installed from it, where it differs from the installed one. The "
            "workshop is replaced, so its progress is reset, as in the browser."
        ),
    )
    update.add_argument(
        "names",
        nargs="*",
        metavar="NAME",
        help="workshop names or paths (default: all)",
    )
    update.add_argument(
        "--yes", action="store_true", help="do not ask before resetting progress"
    )
    _add_library_target_arguments(update)
    update.set_defaults(func=command_update)

    remove = commands.add_parser(
        "remove",
        help="remove installed workshops",
        description=(
            "Remove installed workshops as the browser does: a downloaded one "
            "is deleted, and any other, such as your own or a course's, loses "
            "only its recorded progress unless --delete asks for its directory "
            "to go as well."
        ),
    )
    remove.add_argument(
        "names", nargs="+", metavar="NAME", help="workshop names or paths"
    )
    remove.add_argument(
        "--delete",
        action="store_true",
        help="delete the directory of a workshop that was not downloaded too",
    )
    remove.add_argument("--yes", action="store_true", help="do not ask before removing")
    _add_library_target_arguments(remove)
    remove.set_defaults(func=command_remove)

    course = commands.add_parser(
        "course",
        help="make a course repository, keep it current, and manage a "
        "library's courses",
        description=(
            "A course is a repository of workshops, with the indexes that "
            "publish them and everything a repository needs to be written in "
            "with an agent, checked and hosted. init writes one and update "
            "brings its generated files up to a release. In a workshop "
            f"library, a course kept under {COURSES_DIRECTORY}/ needs nothing "
            "more; one kept elsewhere is linked in. The library commands use "
            "the default library unless --root or --directory name another."
        ),
    )
    course_commands = course.add_subparsers(dest="course_command", required=True)
    course_init = course_commands.add_parser(
        "init",
        help="write a course repository",
        description=(
            "Write a course repository: a uv project pinning this release of "
            "jupyterlab-workshop, agent guidance, OUTLINE.md, a Justfile, the "
            "Binder and Codespaces files, a test workflow, and a collection "
            "index for each part of the course with a catalog over them, all "
            "recorded in course.json for course update. The directory becomes "
            "a git repository, with nothing committed."
        ),
    )
    course_init.add_argument(
        "path", type=Path, metavar="DIRECTORY", help="the repository to write"
    )
    course_init.add_argument(
        "--name", help="the course's name, kebab-case (default: the directory's)"
    )
    course_init.add_argument("--title", help="the course's title (default: the name)")
    course_init.add_argument(
        "--description", default="", help="a sentence on what the course teaches"
    )
    course_init.add_argument(
        "--collection",
        action="append",
        default=[],
        metavar="NAME[=TITLE]",
        help="a collection, a part of the course with an index of its own; "
        "repeat for several (default: one named after the course)",
    )
    course_init.add_argument(
        "--id-prefix",
        help="the prefix of every collection id, <prefix>/<course>/<collection> "
        "(default: the repository's forge and owner, else the course's name)",
    )
    course_init.add_argument(
        "--repo", default="", help="the repository's URL on GitHub, once it has one"
    )
    course_init.add_argument(
        "--lite",
        action="store_true",
        help="write the course for JupyterLite as well: the site files, the "
        "Pages workflow, and lint and tests on both frontends",
    )
    course_init.add_argument(
        "--python",
        default="3.14",
        metavar="X.Y",
        help="the Python version the course runs on (default 3.14)",
    )
    course_init.add_argument(
        "--no-git", action="store_true", help="do not make the directory a repository"
    )
    course_init.add_argument(
        "--link",
        action="store_true",
        help="also link the new course into a workshop library, the default "
        "library unless --root or --directory name another",
    )
    _add_course_target_arguments(course_init)
    course_init.set_defaults(func=command_course_init)
    course_update = course_commands.add_parser(
        "update",
        help="bring a course's generated files up to a release",
        description=(
            "Move the jupyterlab-workshop pin in pyproject.toml and "
            "binder/requirements.txt, write again every file course init wrote "
            "that is still as generated, add any the scaffold now writes, and "
            "leave alone, and report, the files edited since."
        ),
    )
    course_update.add_argument(
        "directory", nargs="?", type=Path, default=Path("."), help="the course"
    )
    course_update.add_argument(
        "--version", help="the release to pin (default: this installation's)"
    )
    course_update.set_defaults(func=command_course_update)
    promote = course_commands.add_parser(
        "promote",
        help="move a workshop of its own into a course",
        description=(
            "Move a workshop into a course's workshops/ directory, whole, with "
            "its progress and gist record; write its entry into OUTLINE.md "
            "under the collection it joins, rebuild that collection's index "
            "with it last, add its name to the Justfile's order, and commit "
            "the move in the course. The workshop's own git repository ends, "
            "since its files join the course's."
        ),
    )
    promote.add_argument("workshop", type=Path, help="the workshop to move")
    promote.add_argument("course", type=Path, help="the course it joins")
    promote.add_argument(
        "--collection",
        help="the part of the course it joins, by its directory name under "
        "collections/ (needed when the course has several)",
    )
    promote.set_defaults(func=command_course_promote)
    link = course_commands.add_parser(
        "link", help="link in a repository kept outside the library"
    )
    link.add_argument("path", type=Path, help="the repository to link in")
    link.add_argument(
        "--name",
        help=f"the course's name under {COURSES_DIRECTORY}/ (default: its directory's)",
    )
    link.add_argument(
        "--workshops",
        help="its workshops directory, relative to it (default: workshops)",
    )
    _add_course_target_arguments(link)
    link.set_defaults(func=command_course_link)
    unlink = course_commands.add_parser(
        "unlink", help="remove a linked course's link, leaving its files"
    )
    unlink.add_argument("name", help=f"the course's name under {COURSES_DIRECTORY}/")
    _add_course_target_arguments(unlink)
    unlink.set_defaults(func=command_course_unlink)
    courses = course_commands.add_parser("list", help="list the courses")
    courses.add_argument(
        "--json", action="store_true", help="print the listing as JSON"
    )
    _add_course_target_arguments(courses)
    courses.set_defaults(func=command_course_list)

    kernels = commands.add_parser(
        "kernels",
        help="list the kernels registered for workshop environments",
        description=(
            "List the kernelspecs registered for workshop environments, "
            "which are the ones whose Python lives under a workshop's "
            "_workshop/venv directory; every other kernel is left alone. "
            "A stale one is a kernel whose environment no longer exists."
        ),
    )
    kernels.add_argument(
        "--prune", action="store_true", help="unregister the stale ones"
    )
    kernels.set_defaults(func=command_kernels)

    publish = commands.add_parser(
        "publish", help="build an archive, its sha256 and a collection entry"
    )
    publish.add_argument("directory", type=Path)
    publish.add_argument(
        "--out", type=Path, default=Path("dist"), help="output directory"
    )
    publish.add_argument(
        "--url",
        default="",
        help="URL the archive will be published at, for the collection entry",
    )
    publish.set_defaults(func=command_publish)

    gist = commands.add_parser(
        "gist", help="lay a workshop out flat and publish it as a GitHub gist"
    )
    gist.add_argument("directory", type=Path)
    gist.add_argument(
        "--out",
        type=Path,
        default=Path("dist/gist"),
        help="directory the flat copy is written under (default dist/gist)",
    )
    gist_target = gist.add_mutually_exclusive_group()
    gist_target.add_argument(
        "--create", action="store_true", help="create a gist from the flat copy"
    )
    gist_target.add_argument(
        "--update",
        metavar="GIST",
        nargs="?",
        const="",
        help="replace the files of an existing gist, given by URL or id "
        "(default the gist recorded in _workshop/gist.json)",
    )
    gist.add_argument(
        "--public",
        action="store_true",
        help="with --create, make the gist public (default secret)",
    )
    gist.add_argument(
        "--token",
        default="",
        help="GitHub token with the gist scope "
        "(default GH_TOKEN, GITHUB_TOKEN, then gh auth token)",
    )
    gist.add_argument(
        "--site",
        default="",
        help="JupyterLite site the README's launch button opens (default: the "
        "published launcher for the Python the manifest requires, else the "
        "newest)",
    )
    gist.add_argument(
        "--python",
        default="",
        metavar="X.Y",
        help="Python version of the published launcher the button opens, "
        f"one of {', '.join(LAUNCHER_PYTHONS)}",
    )
    gist_binder = gist.add_mutually_exclusive_group()
    gist_binder.add_argument(
        "--binder",
        default=BINDER_LAUNCHER,
        metavar="URL",
        help="Binder launcher repository the README's Binder button opens, as "
        "its mybinder.org/v2/... URL (default the project's launcher)",
    )
    gist_binder.add_argument(
        "--no-binder",
        dest="binder",
        action="store_const",
        const="",
        help="leave the Binder button out of the README",
    )
    gist.add_argument(
        "--append-readme",
        action="store_true",
        help="append the workshop's own README.md below the generated one",
    )
    gist.add_argument(
        "--frontend",
        choices=FRONTENDS,
        help="frontend to lint for (default jupyterlab)",
    )
    gist.set_defaults(func=command_gist)

    github = commands.add_parser(
        "github",
        help="publish a workshop or course repository to GitHub, or push to it",
    )
    github.add_argument(
        "directory",
        type=Path,
        nargs="?",
        default=Path("."),
        help="the top of the repository (default the current directory)",
    )
    github.add_argument(
        "--name",
        default="",
        help="the repository to create, OWNER/NAME or NAME under your account "
        "(default the directory's name)",
    )
    github.add_argument(
        "--public",
        action="store_true",
        help="create the repository public, or make an existing one public "
        "(default private)",
    )
    github.add_argument(
        "--description", default="", help="the new repository's description"
    )
    github.set_defaults(func=command_github)

    test = commands.add_parser(
        "test",
        help="run every action of a workshop in a real JupyterLab",
        description=(
            "Run every action of a workshop in a real JupyterLab. Only the "
            "workshop directory is protected, by a temporary copy: the "
            "workshop's commands and checks run as you, on this machine, "
            "with your home directory and Python environment, so read them "
            "first and test a workshop that reaches outside its own "
            "directory in CI or a container instead."
        ),
    )
    test.add_argument("directory", type=Path)
    test.add_argument("--junit", type=Path, help="write a JUnit XML report")
    test.add_argument(
        "--json", dest="json_out", type=Path, help="write the full report as JSON"
    )
    test.add_argument(
        "--in-place",
        action="store_true",
        help="run against the directory itself instead of a temporary copy",
    )
    test.add_argument(
        "--headed", action="store_true", help="show the browser while testing"
    )
    test.add_argument(
        "--timeout",
        type=float,
        help="seconds to allow for the whole run (default 1200, more for a paced run)",
    )
    test.add_argument(
        "--action-timeout",
        type=float,
        default=300.0,
        help="seconds one action may take before the run stops (default 300)",
    )
    test.add_argument(
        "--pace",
        choices=["fast", "demo", "presentation"],
        default="fast",
        help="pauses between the steps: fast (none, the default), demo "
        "(short, for a recording) or presentation (long, for an audience); "
        "any but fast shows the browser and allows longer for the run",
    )
    test.add_argument(
        "--start-delay",
        type=float,
        help="seconds to pause before the first action (overrides --pace)",
    )
    test.add_argument(
        "--step-delay",
        type=float,
        help="seconds to pause before each action (overrides --pace)",
    )
    test.add_argument(
        "--page-delay",
        type=float,
        help="seconds to pause on each new page (overrides --pace)",
    )
    test.add_argument(
        "--trust",
        choices=["trusted", "restricted", "ask"],
        default="trusted",
        help="trust level to run under (default trusted)",
    )
    test.add_argument(
        "--lite",
        action="store_true",
        help="run in a static JupyterLite build instead of a JupyterLab server",
    )
    test.add_argument(
        "--frontend",
        choices=FRONTENDS,
        help="frontend to run in: jupyterlab (the default) or jupyterlite, "
        "the same as --lite",
    )
    test.add_argument(
        "--lite-dir",
        type=Path,
        help="JupyterLite build cache directory (default: under the Jupyter "
        "data directory)",
    )
    test.set_defaults(func=command_test)

    launch = commands.add_parser(
        "launch",
        help="start JupyterLab with a workshop, collection or catalog open",
        description=(
            "Start JupyterLab on a launch link built from the options: a "
            "workshop directory, a workshop URL, or a name in a collection, "
            "or with nothing named, the workshop browser. Inside a container "
            "the server is set up to be reached from outside; see --container. "
            "Arguments after -- are passed to jupyter lab."
        ),
    )
    launch.add_argument(
        "target",
        nargs="?",
        help="workshop directory, repository, forge tree or archive URL, or "
        "a workshop name when --collection is given",
    )
    launch.add_argument("--ref", help="git ref to fetch, for a repository URL")
    launch.add_argument(
        "--subdir", help="directory holding the workshop, for a repository URL"
    )
    launch.add_argument("--sha256", help="expected hash, for an archive URL")
    launch.add_argument(
        "--collection",
        action="append",
        default=[],
        help="collection URL or collection.json to add for the session, in "
        "the order the browser lists them (repeatable)",
    )
    launch.add_argument(
        "--catalog", help="catalog URL or catalog.json to add for the session"
    )
    launch.add_argument(
        "--install",
        action="store_true",
        help="install every workshop of the collections named with --collection "
        "before starting, skipping those installed already",
    )
    launch.add_argument(
        "--var",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="set a workshop variable (repeatable)",
    )
    launch.add_argument(
        "--restart",
        nargs="?",
        const="ask",
        choices=["force"],
        help="start the workshop over first, asking when it has progress; "
        "--restart=force never asks",
    )
    launch.add_argument(
        "--welcome", help="Markdown file to show in a dialog once started"
    )
    launch.add_argument(
        "--trust",
        choices=["trusted", "restricted", "ask"],
        help="force the trust level for the session instead of asking",
    )
    launch.add_argument(
        "--analytics",
        choices=["always", "never", "ask"],
        help="report progress to the sink a collection or workshop declares "
        "without asking, never, or with the learner's opt-in (default: the "
        "installed setting, which asks unless changed)",
    )
    launch.add_argument(
        "--root",
        type=Path,
        default=Path.cwd(),
        help="JupyterLab root directory (default: the current directory)",
    )
    launch.add_argument(
        "--port",
        type=int,
        help="port to serve on (default: a free one, or 8888 in a container)",
    )
    launch.add_argument(
        "--no-browser", action="store_true", help="print the link without opening it"
    )
    launch.add_argument(
        "--fresh",
        action="store_true",
        help="use private JupyterLab workspaces and user settings, as test does",
    )
    launch.add_argument(
        "--container",
        dest="container",
        action="store_true",
        default=None,
        help="serve for a container: listen on every interface on port 8888, "
        "keep the token in JUPYTER_TOKEN, trust the workshops and open no "
        "browser (default: on when running inside a container)",
    )
    launch.add_argument(
        "--no-container",
        dest="container",
        action="store_false",
        help="serve as on a desktop even inside a container",
    )
    launch.add_argument(
        "--token",
        help="serve with this token instead of a generated one",
    )
    launch.add_argument(
        "--url",
        help="base URL to print the link against, for a container reached at "
        "an address other than the one it listens on",
    )
    launch.set_defaults(func=command_launch)

    lite = commands.add_parser(
        "lite", help="build a static JupyterLite site carrying workshops"
    )
    lite.add_argument(
        "workshops",
        nargs="*",
        type=Path,
        help="workshop directories; none builds a launcher that opens "
        "workshops named by launch links",
    )
    lite.add_argument(
        "--python",
        default="",
        metavar="X.Y",
        help="Python version the site must provide; the build fails when the "
        "installed Pyodide kernel carries another",
    )
    lite.add_argument(
        "--out",
        type=Path,
        default=Path("lite-site"),
        help="directory to build the site into (default lite-site)",
    )
    lite.add_argument(
        "--lite-dir",
        type=Path,
        help="JupyterLite build cache directory (default: under the Jupyter "
        "data directory)",
    )
    lite.add_argument(
        "--default",
        dest="default_workshop",
        default="",
        help="name of the workshop to open on start (default: the only one)",
    )
    lite.add_argument(
        "--trust",
        choices=["trusted", "restricted", "ask"],
        default="",
        help="apply a trust level without asking (default: show the dialog)",
    )
    lite.add_argument(
        "--collection",
        action="append",
        default=[],
        help="collection to subscribe to in the workshop browser: the URL of "
        "its index, or a local collection.json (or the directory holding "
        "one), which is carried in the site",
    )
    lite.add_argument(
        "--catalog",
        action="append",
        default=[],
        help="catalog to subscribe to in the workshop browser: its URL, or a "
        "local catalog.json (or the directory holding one), which is carried "
        "in the site with the collections it names by relative path",
    )
    lite.add_argument(
        "--settings",
        type=Path,
        help="settings file in the form of overrides.json to build into the "
        "site, such as an analytics block; the other options are laid over it",
    )
    lite.add_argument(
        "--welcome",
        type=Path,
        help="Markdown file to carry in the site and show as its welcome message",
    )
    lite.add_argument(
        "--no-terminal",
        dest="terminal",
        action="store_false",
        help="leave the terminal out, so node, npm and micromamba are not needed",
    )
    lite.add_argument(
        "--serve",
        action="store_true",
        help="serve the site on a local port after building",
    )
    lite.add_argument(
        "--port", type=int, default=8000, help="port for --serve (default 8000)"
    )
    lite.set_defaults(func=command_lite)

    record = commands.add_parser(
        "record", help="write draft pages from a recording saved in JupyterLab"
    )
    record.add_argument("recording", type=Path, help="recording JSON file")
    record.add_argument(
        "directory",
        type=Path,
        help="workshop to add pages to, or a new directory to create",
    )
    record.add_argument("--name", help="name for a new workshop")
    record.add_argument("--title", help="title for a new workshop")
    record.set_defaults(func=command_record)

    skill = commands.add_parser(
        "skill",
        help="where the authoring skill is, or link it into a repository",
        description=(
            "Print where this installation keeps the jupyterlab-workshop "
            "authoring skill, or with --link make .claude/skills/"
            f"{SKILL_NAME} in a repository a link to it, so an agent working "
            "there has the skill that matches the installed release."
        ),
    )
    skill.add_argument(
        "--link",
        nargs="?",
        const=Path("."),
        type=Path,
        metavar="DIR",
        help="link the skill into DIR's .claude/skills (default: the current "
        "directory)",
    )
    skill.set_defaults(func=command_skill)

    mcp = commands.add_parser(
        "mcp", help="serve the workshop tools to AI agents over MCP (stdio)"
    )
    mcp.add_argument(
        "--url", default="", help="URL of the JupyterLab server for live tools"
    )
    mcp.add_argument("--token", default="", help="token of that server")
    mcp.set_defaults(func=command_mcp)

    return parser


def command_init(args: argparse.Namespace) -> int:
    """Scaffold a workshop."""

    directory: Path = args.directory
    name = args.name or slug(directory.resolve().name)
    title = args.title or name.replace("-", " ").capitalize()

    try:
        written = write_scaffold(
            directory,
            name,
            title,
            ci=args.ci,
            template=args.template,
            platforms=args.platforms,
            frontends=args.frontends,
            capabilities=args.capabilities,
            gating=args.gating,
        )
    except (FileExistsError, ValueError) as error:
        raise CliError(str(error)) from error

    for path in written:
        print(f"wrote {path}")

    # A workshop of one's own starts as a repository, unless it is being
    # added to one, so its history begins with it.
    if not args.no_git and initialize_repository(directory):
        print(f"initialized a git repository in {directory}")

    print(f"\nNext: jupyter workshop lint {directory}")

    return 0


def command_lint(args: argparse.Namespace) -> int:
    """Lint a workshop through the Node bundle, or check an index file."""

    if args.directory.is_file() and args.directory.suffix == ".json":
        return _check_index_file(args.directory, args.json)

    extra = ["--json"] if args.json else []

    if args.platform:
        extra += ["--platform", args.platform]

    if args.frontend:
        extra += ["--frontend", args.frontend]

    completed = run_node(["lint", str(_workshop_dir(args.directory)), *extra])

    sys.stdout.write(completed.stdout)
    sys.stderr.write(completed.stderr)

    return completed.returncode


def command_render(args: argparse.Namespace) -> int:
    """Render a workshop to HTML."""

    command = ["render", str(_workshop_dir(args.directory))]

    if args.page:
        command.append(args.page)

    if args.out:
        command += ["--out", str(args.out)]

    if args.platform:
        command += ["--platform", args.platform]

    if args.frontend:
        command += ["--frontend", args.frontend]

    completed = run_node(command)

    sys.stdout.write(completed.stdout)
    sys.stderr.write(completed.stderr)

    if completed.returncode == 0 and args.out:
        print(f"wrote {args.out}")

    return completed.returncode


def command_pages(args: argparse.Namespace) -> int:
    """List pages."""

    completed = run_node(["pages", str(_workshop_dir(args.directory))])

    if completed.returncode != 0:
        sys.stderr.write(completed.stderr)

        return completed.returncode

    for page in json.loads(completed.stdout):
        requires = (
            f"  (requires {', '.join(page['requires'])})" if page["requires"] else ""
        )

        print(f"{page['id']}\t{page['title']}\t{page['path']}{requires}")

    return 0


def _check_index_file(file: Path, as_json: bool) -> int:
    """Check a collection or catalog file, and a catalog's collections."""

    completed = run_node(["check", str(file)])

    if completed.returncode != 0:
        sys.stderr.write(completed.stderr or completed.stdout)

        return completed.returncode

    report = json.loads(completed.stdout)
    problems: list[str] = []

    # A catalog names collections; each must be readable from where the
    # catalog says it is, relative to the catalog file when not a URL.
    if report["kind"] == "catalog":
        base = file.resolve().as_posix()

        for location in report["locations"]:
            resolved = resolve_location(base, location)

            try:
                if is_http_url(resolved):
                    _load_collection_index(resolved, Path.cwd())
                else:
                    resolved_path = Path(resolved)

                    _load_collection_index(resolved_path.name, resolved_path.parent)
            except CollectionError as error:
                problems.append(f"{location}: {error}")

    report["problems"] = problems

    if as_json:
        print(json.dumps(report, indent=2))
    else:
        what = "workshop" if report["kind"] == "collection" else "collection"
        count = report["entries"]

        print(
            f'{file}: {report["kind"]} "{report["title"]}" with '
            f"{count} {what}{'' if count == 1 else 's'}"
        )

        for warning in report.get("warnings", []):
            print(f"warning: {warning}")

        for problem in problems:
            print(f"error: {problem}")

        print(f"{len(problems)} error(s)")

    return 1 if problems else 0


def command_schema(args: argparse.Namespace) -> int:
    """Print the manifest, collection, catalog, events or library schema."""

    schema = (
        COLLECTION_SCHEMA_FILE
        if args.collection
        else CATALOG_SCHEMA_FILE
        if args.catalog
        else EVENTS_SCHEMA_FILE
        if args.events
        else LIBRARY_SCHEMA_FILE
        if args.library
        else SCHEMA_FILE
    )

    if not schema.is_file():
        raise CliError(
            f"The schema {schema.name} is missing from this installation; "
            "build the package first"
        )

    sys.stdout.write(schema.read_text(encoding="utf-8"))

    return 0


def _add_metadata_arguments(
    parser: argparse.ArgumentParser, what: str, tags: bool
) -> None:
    """Add the options that set a collection's or catalog's own fields."""

    if what == "collection":
        parser.add_argument(
            "--id",
            help="the collection's identity, the same wherever it runs, "
            "such as example.org/python-basics; analytics know it by this",
        )

    parser.add_argument("--title", help=f"title of the {what}")
    parser.add_argument("--description", help=f"a sentence or two about the {what}")
    parser.add_argument("--publisher", help="who publishes it")
    parser.add_argument("--publisher-url", help="web page of the publisher")
    parser.add_argument("--homepage", help=f"web page about the {what}")
    parser.add_argument(
        "--icon",
        help="icon shown beside the title: a URL, a path relative to the file, "
        "or a data: URI",
    )

    if tags:
        parser.add_argument(
            "--tag", action="append", dest="tags", help="a tag; may be repeated"
        )

        order = parser.add_mutually_exclusive_group()

        order.add_argument(
            "--ordered",
            action="store_true",
            help="the workshops form a sequence to take in the order listed",
        )
        order.add_argument(
            "--unordered",
            action="store_true",
            help="the workshops are a set with no order (the default for a new index)",
        )


def _collection_metadata(args: argparse.Namespace) -> CollectionMetadata:
    return CollectionMetadata(
        id=args.id or "",
        title=args.title or "",
        description=args.description or "",
        publisher=args.publisher or "",
        publisher_url=args.publisher_url or "",
        homepage=args.homepage or "",
        icon=args.icon or "",
        tags=tuple(args.tags) if args.tags else None,
        ordered=True if args.ordered else False if args.unordered else None,
    )


def _read_collection_file(index_path: Path) -> dict[str, Any] | None:
    if not index_path.is_file():
        return None

    try:
        return parse_collection(index_path.read_text(encoding="utf-8"), str(index_path))
    except CollectionError as error:
        raise CliError(str(error)) from error


def command_collection(args: argparse.Namespace) -> int:
    """Merge entry files into a collection index."""

    index_path: Path = args.index
    existing = _read_collection_file(index_path)
    entries = []

    for entry_path in args.entries:
        try:
            entry = json.loads(entry_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise CliError(f"Unable to read {entry_path}: {error}") from error

        if not isinstance(entry, dict):
            raise CliError(f"{entry_path} does not contain a collection entry")

        entries.append(entry)

    try:
        index = build_collection(existing, entries, _collection_metadata(args))
    except CollectionError as error:
        raise CliError(str(error)) from error

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {index_path} with {len(index['workshops'])} workshop(s)")

    return 0


def command_index(args: argparse.Namespace) -> int:
    """Index every workshop in a repository checkout."""

    directories: list[Path] = args.directories
    first: Path = directories[0]

    if not first.is_dir():
        raise CliError(f"{first} is not a directory")

    # Sources are relative to the checkout, whose origin and branch are
    # the default repository and ref.
    root: Path = (args.root or checkout_root(first) or first).resolve()
    guessed_repo, guessed_ref = guess_repository(root)
    repo = args.repo or guessed_repo
    ref = args.ref or guessed_ref or "main"

    if not repo:
        raise CliError(f"{root} has no git origin; give the repository URL with --repo")

    index_path: Path = args.out or root / "collection.json"
    existing = _read_collection_file(index_path)

    try:
        index = index_repository(
            root, directories, repo, ref, existing, _collection_metadata(args)
        )
    except CollectionError as error:
        raise CliError(str(error)) from error

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")

    count = len(index["workshops"])

    print(f"wrote {index_path} with {count} workshop(s) from {repo} at {ref}")

    return 0


def command_catalog(args: argparse.Namespace) -> int:
    """Build or refresh a catalog from collection indexes."""

    catalog_path: Path = args.catalog
    existing = None

    if catalog_path.is_file():
        try:
            existing = parse_catalog(
                catalog_path.read_text(encoding="utf-8"), str(catalog_path)
            )
        except CatalogError as error:
            raise CliError(str(error)) from error

    # Without collections named, every entry already listed is re-read
    # from where the catalog says it is, relative to the catalog file.
    locations: list[str] = list(args.collections)
    relative = bool(args.relative)

    if not locations and existing:
        for item in existing.get("collections", []):
            url = str(item.get("url") or "")

            if is_http_url(url):
                locations.append(url)
            else:
                locations.append(str(catalog_path.parent / url))
                relative = True

    metadata = CatalogMetadata(
        title=args.title or "",
        description=args.description or "",
        publisher=args.publisher or "",
        publisher_url=args.publisher_url or "",
        homepage=args.homepage or "",
        icon=args.icon or "",
    )

    try:
        entries = refresh_entries(catalog_path, locations, relative=relative)
        catalog = build_catalog(existing, entries, metadata)
    except CatalogError as error:
        raise CliError(str(error)) from error

    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")

    count = len(catalog["collections"])

    print(f"wrote {catalog_path} with {count} collection(s)")

    return 0


def command_install(args: argparse.Namespace) -> int:
    """Install the workshops of a collection that are not installed yet."""

    try:
        outcomes = install_collection(
            args.collection,
            args.root,
            args.directory,
            only=list(args.only),
            platform=args.platform,
            frontend=args.frontend,
            report=print,
        )
    except FetchError as error:
        raise CliError(str(error)) from error

    counts = {
        status: len([item for item in outcomes if item.status == status])
        for status in ("installed", "skipped", "failed")
    }

    print(
        f"{counts['installed']} installed, {counts['skipped']} skipped, "
        f"{counts['failed']} failed"
    )

    return 1 if counts["failed"] else 0


def _add_library_target_arguments(parser: argparse.ArgumentParser) -> None:
    """Add the options that say which workshops directory a command acts on."""

    parser.add_argument(
        "--root",
        type=Path,
        help="the JupyterLab root the workshops directory sits under "
        "(default: the current directory)",
    )
    parser.add_argument(
        "--directory",
        help=f"the workshops directory under the root (default: {DEFAULT_DIRECTORY})",
    )
    parser.add_argument(
        "--library",
        action="store_true",
        help=f"act on the default workshop library, ${LIBRARY_VARIABLE} or "
        f"~/{DEFAULT_LIBRARY_NAME}, instead of --root and --directory",
    )


def _add_course_target_arguments(parser: argparse.ArgumentParser) -> None:
    """Add the options that say which library a course command acts on."""

    parser.add_argument(
        "--root",
        type=Path,
        help="the JupyterLab root the library sits under "
        "(default: the default library itself)",
    )
    parser.add_argument(
        "--directory",
        help="the library under the root (default: the root itself, or "
        f"{DEFAULT_DIRECTORY} when --root is given)",
    )


def _library_target(args: argparse.Namespace) -> tuple[Path, str]:
    """The root and workshops directory a subscription command acts on:
    the default library with --library, else --root and --directory."""

    if args.library:
        if args.root is not None or args.directory is not None:
            raise CliError("--library cannot be combined with --root or --directory")

        return default_library(), "."

    return (
        args.root if args.root is not None else Path.cwd(),
        args.directory if args.directory is not None else DEFAULT_DIRECTORY,
    )


def _course_library(args: argparse.Namespace) -> Path:
    """The library a course command acts on: the default library unless
    --root or --directory name another."""

    if args.root is None and args.directory is None:
        return default_library()

    root = args.root if args.root is not None else Path.cwd()
    directory = args.directory if args.directory is not None else DEFAULT_DIRECTORY

    return library_directory(root, directory)


def _confirm(question: str, yes: bool) -> bool:
    """Whether to go ahead: --yes, or the person answering yes."""

    if yes:
        return True

    if not sys.stdin.isatty():
        raise CliError(f"{question} Pass --yes to go ahead without asking.")

    return input(f"{question} [y/N] ").strip().lower() in {"y", "yes"}


def command_library(args: argparse.Namespace) -> int:
    """Start JupyterLab on a workshop library, creating it on first use."""

    from .launch import LaunchError, LaunchOptions, run_launch

    directory = (args.directory or default_library()).expanduser()

    try:
        if not is_library(directory, "."):
            directory.mkdir(parents=True, exist_ok=True)
            write_library(directory, ".", empty_library())
            print(f"created a workshop library at {directory}")

        _offer_upgrade(directory, args.yes)

        for name in repair_links(directory):
            print(f"relinked the course {name}")
    except (OSError, LibraryError) as error:
        raise CliError(str(error)) from error

    if args.init_only:
        return 0

    options = LaunchOptions(
        root=directory,
        workshops_directory=".",
        collections=args.collection,
        trust=args.trust,
        port=args.port,
        open_browser=not args.no_browser,
        fresh=args.fresh,
        token=args.token,
        lab_args=tuple(args.passthrough),
    )

    try:
        return run_launch(options)
    except LaunchError as error:
        raise CliError(str(error)) from error


def _offer_upgrade(directory: Path, yes: bool) -> None:
    """Upgrade a library in the previous layout, asking first unless told
    not to. Left as it is when declined, or when there is no terminal to
    ask at; the workshop browser offers the upgrade again."""

    plan = plan_upgrade(directory, ".")

    if plan is None:
        return

    print(
        f"the workshop library at {directory} was made by an earlier release "
        "and keeps its workshops in the previous layout; upgrading moves:"
    )

    for move in plan.moves:
        print(f"  {move.source}/ to {move.target}/ ({move.contents})")

    if plan.environments:
        print(
            "and removes the isolated environments of these workshops, which "
            "hold the paths they were made at and are made again on opening:"
        )

        for path in plan.environments:
            print(f"  {path}")

    if not yes and not (
        sys.stdin.isatty()
        and input("Upgrade the library now? [Y/n] ").strip().lower() in {"", "y", "yes"}
    ):
        print("left as it is; the workshop browser offers the upgrade")

        return

    upgrade_library(directory, ".")

    print("upgraded the workshop library")


def command_subscribe(args: argparse.Namespace) -> int:
    """Add a collection or catalog to a workshop library's subscriptions."""

    root, directory = _library_target(args)
    kind = "catalogs" if args.catalog else "collections"

    try:
        added = subscribe(root, directory, args.location, kind)
    except LibraryError as error:
        raise CliError(_not_a_library_hint(str(error))) from error

    what = "catalog" if args.catalog else "collection"

    print(
        f"subscribed to the {what} {args.location}"
        if added
        else f"already subscribed to the {what} {args.location}"
    )

    return 0


def command_unsubscribe(args: argparse.Namespace) -> int:
    """Remove a collection or catalog from a workshop library's subscriptions."""

    root, directory = _library_target(args)
    kind = "catalogs" if args.catalog else "collections"

    try:
        removed = unsubscribe(root, directory, args.location, kind)
    except LibraryError as error:
        raise CliError(_not_a_library_hint(str(error))) from error

    what = "catalog" if args.catalog else "collection"

    if not removed:
        raise CliError(f"not subscribed to the {what} {args.location}")

    print(f"unsubscribed from the {what} {args.location}")

    return 0


def _not_a_library_hint(message: str) -> str:
    # Subscriptions outside a library live in the browser's settings,
    # which the command line cannot change.
    if "not a workshop library" not in message:
        return message

    return (
        f"{message}; subscriptions outside a workshop library are kept in the "
        "JupyterLab settings, so change them in the workshop browser, or make "
        "the directory a library there or with "
        "jupyter workshop library DIR --init-only"
    )


def command_list(args: argparse.Namespace) -> int:
    """List the installed workshops and, in a library, its subscriptions."""

    root, directory = _library_target(args)

    try:
        registry = read_library(root, directory)
        records = list_installed(root, directory, library=True)
    except (LibraryError, CollectionError) as error:
        raise CliError(str(error)) from error

    location = library_directory(root, directory)

    if args.json:
        print(
            json.dumps(
                {
                    "directory": location.as_posix(),
                    "library": registry is not None,
                    "collections": (registry or {}).get("collections"),
                    "catalogs": (registry or {}).get("catalogs"),
                    "workshops": records,
                },
                indent=2,
            )
        )

        return 0

    if registry is None:
        print(f"workshops directory {location} (not a workshop library)")
    else:
        print(f"workshop library {location}")

        if needs_upgrade(registry):
            print(
                "made by an earlier release, in the previous layout: its "
                "workshops are listed once it is upgraded, which jupyter "
                "workshop library offers"
            )

        for key in ("collections", "catalogs"):
            listed = registry.get(key)

            if listed is None:
                print(f"{key}: as the JupyterLab settings say")
            else:
                print(f"{key}: {', '.join(listed) if listed else 'none'}")

    if not records:
        print("no workshops installed")

    for record in records:
        kind = record.get("kind") or ("installed" if record["source"] else "local")
        progress = f"{record['done']}/{record['pages']} pages"

        print(
            f"{kind:<9} {record['title']} {record['version'] or '-'} "
            f"{record['path']} ({progress})"
        )

    return 0


def command_update(args: argparse.Namespace) -> int:
    """Install newer versions of workshops their collections offer."""

    root, directory = _library_target(args)

    try:
        records = select_installed(
            list_installed(root, directory, library=True), args.names
        )
        updates = find_updates(root, records)
    except (CollectionError, FetchError, LibraryError) as error:
        raise CliError(str(error)) from error

    if not updates:
        print("everything is up to date")

        return 0

    for update in updates:
        print(
            f"{update.record['title']} {update.record['version'] or '-'} -> "
            f"{update.version} ({update.record['path']})"
        )

    if not _confirm(
        "Updating replaces each workshop and resets its progress. Update?",
        args.yes,
    ):
        return 1

    failed = 0

    for update in updates:
        try:
            print(f"updated {apply_update(root, update)}")
        except FetchError as error:
            failed += 1
            print(f"failed {update.record['path']}: {error}")

    return 1 if failed else 0


def command_remove(args: argparse.Namespace) -> int:
    """Remove installed workshops as the browser does."""

    root, directory = _library_target(args)

    try:
        records = select_installed(
            list_installed(root, directory, library=True), args.names
        )
    except (CollectionError, FetchError, LibraryError) as error:
        raise CliError(str(error)) from error

    for record in records:
        downloaded = isinstance(record["source"], dict) and record["source"].get(
            "kind"
        ) not in {None, "local"}
        what = (
            "the directory and its progress"
            if downloaded or args.delete
            else "its progress; the files stay"
        )

        print(f"{record['title']} ({record['path']}): {what}")

    if not _confirm("Remove these?", args.yes):
        return 1

    for record in records:
        try:
            print(f"removed {remove_installed(root, record, args.delete)}")
        except FetchError as error:
            raise CliError(str(error)) from error

    return 0


def command_course_init(args: argparse.Namespace) -> int:
    """Write a course repository."""

    directory: Path = args.path
    name = args.name or slug(directory.resolve().name)
    title = args.title or name.replace("-", " ").capitalize()
    collections = tuple(_collection_spec(item) for item in args.collection) or (
        CollectionSpec(name=name, title=title, description=args.description),
    )
    options = CourseOptions(
        name=name,
        title=title,
        description=args.description,
        collections=collections,
        id_prefix=args.id_prefix or id_prefix_for(args.repo, name),
        repository=args.repo.rstrip("/"),
        lite=args.lite,
        python=args.python,
    )

    try:
        written = write_course(directory, options)
    except (CourseError, OSError) as error:
        raise CliError(str(error)) from error

    for path in written:
        print(f"wrote {path}")

    if not args.no_git and initialize_repository(directory):
        print(f"initialized a git repository in {directory}")

    if args.link:
        library = _course_library(args)

        try:
            entry = link_course(library, directory, name)
        except LibraryError as error:
            raise CliError(_not_a_library_hint(str(error))) from error

        print(f"linked {library / COURSES_DIRECTORY / entry['name']} to {directory}")

    print(
        f"\nNext: write the design in {directory / 'OUTLINE.md'}, then "
        f"`just install` and `just new <name>` there"
    )

    return 0


def _collection_spec(item: str) -> CollectionSpec:
    # NAME, or NAME=TITLE, as given on the command line.
    name, separator, title = item.partition("=")
    name = name.strip()

    return CollectionSpec(
        name=name,
        title=title.strip() if separator else name.replace("-", " ").capitalize(),
    )


def command_course_promote(args: argparse.Namespace) -> int:
    """Move a workshop into a course."""

    try:
        report = promote_workshop(args.workshop, args.course, args.collection)
    except PromotionError as error:
        raise CliError(str(error)) from error

    print(f"moved {args.workshop} to {report.target}")

    if report.collection:
        joined = f"joined the collection {report.collection}"
        parts = [
            name
            for name, done in (
                ("index", report.indexed),
                ("OUTLINE.md", report.outlined),
                ("Justfile", report.ordered),
            )
            if done
        ]

        print(f"{joined}: {', '.join(parts) if parts else 'nothing to update'}")

    if report.committed:
        print("committed in the course")
    else:
        print(f"not committed: {report.commit_note}; commit the move yourself")

    return 0


def command_course_update(args: argparse.Namespace) -> int:
    """Bring a course's generated files up to a release."""

    try:
        report = update_course(args.directory, args.version)
    except (CourseError, OSError) as error:
        raise CliError(str(error)) from error

    if report.previous and report.previous != report.version:
        print(f"pinned jupyterlab-workshop {report.version} (was {report.previous})")
    else:
        print(f"pinned jupyterlab-workshop {report.version}")

    for label, paths in (
        ("refreshed", report.refreshed),
        ("added", report.added),
        ("kept, edited since it was generated", report.kept),
    ):
        for path in paths:
            print(f"{label}: {path}")

    if (args.directory / "uv.lock").exists():
        print("\nNext: just requirements, to relock and export binder/requirements.txt")

    return 0


def command_skill(args: argparse.Namespace) -> int:
    """Print where the authoring skill is, or link it into a repository."""

    source = skill_directory()

    if source is None:
        raise CliError("This installation has no authoring skill")

    if args.link is None:
        print(source)

        return 0

    link = args.link / ".claude" / "skills" / SKILL_NAME

    try:
        link.parent.mkdir(parents=True, exist_ok=True)

        if link.is_symlink() or link.exists():
            if link.is_symlink() and link.resolve() == source.resolve():
                print(f"{link} already links to {source}")

                return 0

            raise CliError(f"{link} exists already and is not a link to the skill")

        link.symlink_to(source, target_is_directory=True)
    except OSError as error:
        raise CliError(f"Unable to link {link} to {source}: {error}") from error

    print(f"linked {link} to {source}")

    return 0


def command_course_link(args: argparse.Namespace) -> int:
    """Link a repository kept outside a library in as a course."""

    library = _course_library(args)

    try:
        entry = link_course(library, args.path, args.name, args.workshops)
    except LibraryError as error:
        raise CliError(_not_a_library_hint(str(error))) from error

    target = Path(entry["target"])
    ignore = target / ".gitignore"

    print(f"linked {library / COURSES_DIRECTORY / entry['name']} to {target}")

    # A workshop records its progress in _workshop/ beside its pages,
    # which a repository should not commit.
    if (target / ".git").exists() and (
        not ignore.is_file() or "_workshop" not in ignore.read_text("utf-8")
    ):
        print(
            "note: the repository's .gitignore does not ignore _workshop/, "
            "where workshops record progress"
        )

    return 0


def command_course_unlink(args: argparse.Namespace) -> int:
    """Remove a linked course's link and registry entry."""

    library = _course_library(args)

    try:
        entry = unlink_course(library, args.name)
    except LibraryError as error:
        raise CliError(str(error)) from error

    print(f"unlinked {args.name}; nothing at {entry.get('target')} was touched")

    return 0


def command_course_list(args: argparse.Namespace) -> int:
    """List a workshop library's courses."""

    library = _course_library(args)

    try:
        courses = list_courses(library, ".")
    except CollectionError as error:
        raise CliError(str(error)) from error

    if args.json:
        print(json.dumps({"courses": courses}, indent=2))

        return 0

    if not courses:
        print("no courses")

    for course in courses:
        state = (
            "missing"
            if course["missing"]
            else ("linked" if course["linked"] else "kept")
        )
        target = f" -> {course['target']}" if course["target"] else ""

        print(f"{course['name']} ({state}){target}")

    return 0


def command_kernels(args: argparse.Namespace) -> int:
    """List the workshop kernels, pruning the stale ones when asked."""

    from .environment import (
        EnvironmentSetupError,
        list_workshop_kernels,
        prune_workshop_kernels,
    )

    try:
        kernels = list_workshop_kernels()
    except EnvironmentSetupError as error:
        raise CliError(str(error)) from error

    if not kernels:
        print("No workshop kernels are registered.")

        return 0

    width = max(len(kernel.name) for kernel in kernels)

    for kernel in kernels:
        state = "ok" if kernel.exists else "stale"

        print(f"{kernel.name:<{width}}  {state:<5}  {kernel.python}")

    if not args.prune:
        stale = sum(1 for kernel in kernels if not kernel.exists)

        if stale:
            print(f"\n{stale} stale; run with --prune to unregister them")

        return 0

    try:
        pruned = prune_workshop_kernels()
    except EnvironmentSetupError as error:
        raise CliError(str(error)) from error

    for kernel in pruned:
        print(f"unregistered {kernel.name}")

    if not pruned:
        print("\nNothing to prune.")

    return 0


def command_publish(args: argparse.Namespace) -> int:
    """Archive a workshop for distribution."""

    try:
        result = publish_workshop(_workshop_dir(args.directory), args.out, args.url)
    except PublishError as error:
        raise CliError(str(error)) from error

    print(f"wrote {result.archive}")
    print(f"sha256 {result.sha256}")
    print(f"wrote {result.entry_path}")

    return 0


def command_gist(args: argparse.Namespace) -> int:
    """Lay a workshop out flat for a gist and, when asked, send it to GitHub."""

    directory = _workshop_dir(args.directory)
    lint_options = ["--frontend", args.frontend] if args.frontend else []

    # A bare --update means the gist the workshop was published to before.
    if args.update == "" and read_record(directory) is None:
        raise CliError(
            f"No gist is recorded for {directory}: name one with --update GIST, "
            "or make one with --create"
        )

    # The source is linted first, so what goes out has been checked.
    if (status := _lint(directory, lint_options)) != 0:
        return status

    try:
        flat = flatten_workshop(
            directory,
            site=args.site,
            append_readme=args.append_readme,
            python=args.python,
            binder=args.binder.rstrip("/"),
        )
        target = write_flat(flat, args.out)
    except GistError as error:
        raise CliError(str(error)) from error

    for path, name in flat.renames.items():
        print(f"stored {path} as {name}")

    for path in flat.left_out:
        print(f"left out {path}")

    if "jupyterlite" in (flat.manifest.get("frontends") or []):
        python = f" (Python {flat.python})" if flat.python else ""

        print(f"launcher {flat.site}{python}")

    print(f"wrote {target}")

    # The flat copy is put back together the way a download of the gist
    # would be, and that is linted, so what learners get has been checked.
    with tempfile.TemporaryDirectory(prefix="workshop-gist-") as tmp:
        restored = Path(tmp) / flat.name

        try:
            restore_tree(target, restored)
        except TreeError as error:
            raise CliError(f"The flat copy does not restore: {error}") from error

        if (status := _lint(restored, lint_options)) != 0:
            raise CliError("The restored flat copy does not lint clean; see above")

    if not args.create and args.update is None:
        return 0

    try:
        token = resolve_token(args.token)
        result = send_gist(
            directory,
            flat,
            token,
            gist=args.update or "",
            create=args.create,
            public=args.public,
        )
    except GistError as error:
        raise CliError(str(error)) from error

    print(f"{'created' if result.created else 'updated'} {result.url}")
    print(f"recorded in {directory / STATE_DIR / RECORD_FILE}")

    return 0


def command_github(args: argparse.Namespace) -> int:
    """Publish a repository to GitHub through gh, or push to the one it has."""

    try:
        result = publish_repository(
            args.directory,
            name=args.name,
            public=args.public,
            description=args.description,
        )
    except GitHubError as error:
        raise CliError(str(error)) from error

    visibility = "public" if result.public else "private"

    if result.created:
        print(f"created {result.url} ({visibility}) and pushed")
    elif result.made_public:
        print(f"pushed to {result.url}, now public")
    else:
        print(f"pushed to {result.url} ({visibility})")

    for path in result.refreshed:
        print(f"refreshed {path}")

    for note in result.notes:
        print(f"\n{note}")

    return 0


def _lint(directory: Path, options: list[str]) -> int:
    """Lint a directory through the Node bundle, showing its report."""

    completed = run_node(["lint", str(directory), *options])

    sys.stdout.write(completed.stdout)
    sys.stderr.write(completed.stderr)

    return completed.returncode


def command_test(args: argparse.Namespace) -> int:
    """Self-test a workshop in a real JupyterLab."""

    from .harness import SelfTestOptions, resolve_pace, run_self_test

    directory = _workshop_dir(args.directory)

    # A paced run is for someone to watch, so it shows the browser and
    # takes the longer limit the pace carries unless one was given.
    pace = resolve_pace(
        args.pace,
        start_delay=args.start_delay,
        step_delay=args.step_delay,
        page_delay=args.page_delay,
        timeout=args.timeout,
    )
    paced = pace.start_delay > 0 or pace.step_delay > 0 or pace.page_delay > 0

    options = SelfTestOptions(
        directory=directory,
        in_place=args.in_place,
        headed=args.headed or paced,
        timeout=pace.timeout,
        action_timeout=args.action_timeout,
        pace=pace,
        trust=args.trust,
        junit=args.junit,
        json_out=args.json_out,
        lite=args.lite or args.frontend == "jupyterlite",
        lite_dir=args.lite_dir,
    )

    return run_self_test(options)


def command_launch(args: argparse.Namespace) -> int:
    """Start JupyterLab on a launch link."""

    from .launch import LaunchError, LaunchOptions, parse_variable, run_launch

    try:
        variables = dict(parse_variable(text) for text in args.var)
        options = LaunchOptions(
            target=args.target,
            root=args.root,
            ref=args.ref,
            subdir=args.subdir,
            sha256=args.sha256,
            collections=args.collection,
            catalog=args.catalog,
            variables=variables,
            restart=args.restart,
            welcome=args.welcome,
            trust=args.trust,
            analytics=args.analytics,
            port=args.port,
            open_browser=not args.no_browser,
            fresh=args.fresh,
            container=args.container,
            url=args.url,
            token=args.token,
            install=args.install,
            lab_args=tuple(args.passthrough),
        )

        return run_launch(options)
    except LaunchError as error:
        raise CliError(str(error)) from error


def command_lite(args: argparse.Namespace) -> int:
    """Build a JupyterLite site carrying workshops, optionally serving it."""

    workshops = tuple(_workshop_dir(directory) for directory in args.workshops)
    options = LiteBuildOptions(
        workshops=workshops,
        output=args.out,
        lite_dir=args.lite_dir,
        default_workshop=args.default_workshop,
        trust=args.trust,
        terminal=args.terminal,
        collections=tuple(args.collection),
        catalogs=tuple(args.catalog),
        settings=args.settings,
        welcome=args.welcome,
        python=args.python,
    )

    try:
        result = build_lite_site(options)
    except LiteError as error:
        raise CliError(str(error)) from error

    carried = ", ".join(result.workshops) or "no workshops, as a launcher"
    python = f" and Python {result.python}" if result.python else ""

    print(f"built {result.output} with {carried}{python}")

    if not result.terminal:
        print("the terminal was left out, so terminal actions will not run")

    if not args.serve:
        return 0

    # The site is served under a sub-path, as GitHub Pages serves project
    # sites, so anything that assumed the root would show up here.
    root = result.output.resolve().parent
    server, port = serve_directory(root, args.port)
    url = f"http://127.0.0.1:{port}/{result.output.resolve().name}/lab/index.html"

    print(f"serving at {url} (press Ctrl-C to stop)")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()

    return 0


def command_record(args: argparse.Namespace) -> int:
    """Draft pages from a recording through the Node bundle."""

    recording: Path = args.recording

    if not recording.is_file():
        raise CliError(f"{recording} does not exist")

    command = ["draft", str(recording), str(args.directory)]

    if args.name:
        command += ["--name", args.name]

    if args.title:
        command += ["--title", args.title]

    completed = run_node(command)

    sys.stdout.write(completed.stdout)
    sys.stderr.write(completed.stderr)

    if completed.returncode == 0:
        print(f"\nNext: jupyter workshop lint {args.directory}")

    return completed.returncode


def command_mcp(args: argparse.Namespace) -> int:
    """Serve the tools over MCP."""

    try:
        from .mcp import serve
    except ImportError as error:
        raise CliError(
            'The MCP server needs the mcp extra: pip install "jupyterlab-workshop[mcp]"'
        ) from error

    return serve(url=args.url, token=args.token)


def run_node(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    """Run the core Node bundle with arguments."""

    node = shutil.which("node")

    if not node:
        raise CliError(
            "Node.js is needed for this command but no `node` was found on the path"
        )

    if not NODE_BUNDLE.is_file():
        raise CliError(
            f"The Node bundle {NODE_BUNDLE} is missing; run `jlpm build` "
            "in a development checkout or reinstall the package"
        )

    return subprocess.run(
        [node, str(NODE_BUNDLE), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )


def _workshop_dir(directory: Path) -> Path:
    resolved = directory.resolve()

    if not (resolved / "workshop.yaml").is_file():
        raise CliError(f"{directory} has no workshop.yaml")

    return resolved


if __name__ == "__main__":
    sys.exit(main())
