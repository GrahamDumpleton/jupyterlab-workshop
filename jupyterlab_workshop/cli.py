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
    parse_collection,
)
from .collection import (
    load_collection as _load_collection_index,
)
from .fetch import FetchError
from .install import DEFAULT_DIRECTORY, install_collection
from .lite import LiteBuildOptions, LiteError, build_lite_site, serve_directory
from .publish import PublishError, publish_workshop
from .scaffold import GATING, TEMPLATES, slug, write_scaffold

PACKAGE_DIR = Path(__file__).resolve().parent

NODE_BUNDLE = PACKAGE_DIR / "nodejs" / "workshop-cli.cjs"

SCHEMA_FILE = PACKAGE_DIR / "schema" / "workshop.schema.json"

COLLECTION_SCHEMA_FILE = PACKAGE_DIR / "schema" / "collection.schema.json"

CATALOG_SCHEMA_FILE = PACKAGE_DIR / "schema" / "catalog.schema.json"

PLATFORMS = ["linux", "macos", "windows", "lite"]

CAPABILITIES = [
    "terminal",
    "write-files:workspace",
    "write-files:home",
    "write-files:any",
    "network",
    "install-packages",
    "kernel-exec",
    "auto-run",
    "ui-settings",
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
        "--capability",
        action="append",
        dest="capabilities",
        choices=CAPABILITIES,
        help="capability to declare; repeat for several (default: the template's)",
    )
    init.add_argument(
        "--gating", choices=GATING, default="soft", help="page gating (default soft)"
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
    install.set_defaults(func=command_install)

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
        default=1200.0,
        help="seconds to allow for the whole run (default 1200)",
    )
    test.add_argument(
        "--action-timeout",
        type=float,
        default=300.0,
        help="seconds one action may take before the run stops (default 300)",
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
            "or with nothing named, the workshop browser. Arguments after "
            "-- are passed to jupyter lab."
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
        "--collection", help="collection URL or collection.json to add for the session"
    )
    launch.add_argument(
        "--catalog", help="catalog URL or catalog.json to add for the session"
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
        "--root",
        type=Path,
        default=Path.cwd(),
        help="JupyterLab root directory (default: the current directory)",
    )
    launch.add_argument(
        "--port", type=int, help="port to serve on (default: a free one)"
    )
    launch.add_argument(
        "--no-browser", action="store_true", help="print the link without opening it"
    )
    launch.add_argument(
        "--fresh",
        action="store_true",
        help="use private JupyterLab workspaces and user settings, as test does",
    )
    launch.set_defaults(func=command_launch)

    lite = commands.add_parser(
        "lite", help="build a static JupyterLite site carrying workshops"
    )
    lite.add_argument("workshops", nargs="+", type=Path, help="workshop directories")
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
        help="collection index URL to subscribe to in the workshop browser",
    )
    lite.add_argument(
        "--catalog",
        action="append",
        default=[],
        help="catalog URL to subscribe to in the workshop browser",
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
            capabilities=args.capabilities,
            gating=args.gating,
        )
    except (FileExistsError, ValueError) as error:
        raise CliError(str(error)) from error

    for path in written:
        print(f"wrote {path}")

    print(f"\nNext: jupyter workshop lint {directory}")

    return 0


def command_lint(args: argparse.Namespace) -> int:
    """Lint a workshop through the Node bundle, or check an index file."""

    if args.directory.is_file() and args.directory.suffix == ".json":
        return _check_index_file(args.directory, args.json)

    extra = ["--json"] if args.json else []

    if args.platform:
        extra += ["--platform", args.platform]

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

        for problem in problems:
            print(f"error: {problem}")

        print(f"{len(problems)} error(s)")

    return 1 if problems else 0


def command_schema(args: argparse.Namespace) -> int:
    """Print the manifest, collection or catalog schema."""

    schema = (
        COLLECTION_SCHEMA_FILE
        if args.collection
        else CATALOG_SCHEMA_FILE
        if args.catalog
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


def command_test(args: argparse.Namespace) -> int:
    """Self-test a workshop in a real JupyterLab."""

    from .harness import SelfTestOptions, run_self_test

    directory = _workshop_dir(args.directory)
    options = SelfTestOptions(
        directory=directory,
        in_place=args.in_place,
        headed=args.headed,
        timeout=args.timeout,
        action_timeout=args.action_timeout,
        trust=args.trust,
        junit=args.junit,
        json_out=args.json_out,
        lite=args.lite,
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
            collection=args.collection,
            catalog=args.catalog,
            variables=variables,
            restart=args.restart,
            welcome=args.welcome,
            trust=args.trust,
            port=args.port,
            open_browser=not args.no_browser,
            fresh=args.fresh,
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
    )

    try:
        result = build_lite_site(options)
    except LiteError as error:
        raise CliError(str(error)) from error

    print(f"built {result.output} with {', '.join(result.workshops)}")

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
