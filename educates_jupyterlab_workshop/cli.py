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

from . import __version__ as VERSION
from .lite import LiteBuildOptions, LiteError, build_lite_site, serve_directory
from .publish import PublishError, publish_workshop
from .registry import RegistryError, build_registry, parse_registry
from .scaffold import GATING, TEMPLATES, slug, write_scaffold

PACKAGE_DIR = Path(__file__).resolve().parent

NODE_BUNDLE = PACKAGE_DIR / "nodejs" / "workshop-cli.cjs"

SCHEMA_FILE = PACKAGE_DIR / "schema" / "workshop.schema.json"

REGISTRY_SCHEMA_FILE = PACKAGE_DIR / "schema" / "registry.schema.json"

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
    args = parser.parse_args(argv)

    try:
        result: int = args.func(args)
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)

        return 2
    except KeyboardInterrupt:
        return 130

    return result


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

    lint = commands.add_parser("lint", help="report problems in a workshop")
    lint.add_argument("directory", type=Path)
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
    schema.add_argument(
        "--registry",
        action="store_true",
        help="print the registry index schema instead",
    )
    schema.set_defaults(func=command_schema)

    registry = commands.add_parser(
        "registry", help="add published entries to a registry index file"
    )
    registry.add_argument("index", type=Path, help="index file to create or update")
    registry.add_argument(
        "entries",
        nargs="+",
        type=Path,
        help="entry files written by publish (*.registry.json)",
    )
    registry.add_argument("--title", help="title of the registry")
    registry.set_defaults(func=command_registry)

    publish = commands.add_parser(
        "publish", help="build an archive, its sha256 and a registry entry"
    )
    publish.add_argument("directory", type=Path)
    publish.add_argument(
        "--out", type=Path, default=Path("dist"), help="output directory"
    )
    publish.add_argument(
        "--url",
        default="",
        help="URL the archive will be published at, for the registry entry",
    )
    publish.set_defaults(func=command_publish)

    test = commands.add_parser(
        "test", help="run every action of a workshop in a real JupyterLab"
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
        "--registry",
        action="append",
        default=[],
        help="registry index URL to list in the workshop browser",
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
    """Lint a workshop through the Node bundle."""

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


def command_schema(args: argparse.Namespace) -> int:
    """Print the manifest or registry schema."""

    schema = REGISTRY_SCHEMA_FILE if args.registry else SCHEMA_FILE

    if not schema.is_file():
        raise CliError(
            f"The schema {schema.name} is missing from this installation; "
            "build the package first"
        )

    sys.stdout.write(schema.read_text(encoding="utf-8"))

    return 0


def command_registry(args: argparse.Namespace) -> int:
    """Merge entry files into a registry index."""

    index_path: Path = args.index
    existing = None

    if index_path.is_file():
        try:
            existing = parse_registry(
                index_path.read_text(encoding="utf-8"), str(index_path)
            )
        except RegistryError as error:
            raise CliError(str(error)) from error

    entries = []

    for entry_path in args.entries:
        try:
            entry = json.loads(entry_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise CliError(f"Unable to read {entry_path}: {error}") from error

        if not isinstance(entry, dict):
            raise CliError(f"{entry_path} does not contain a registry entry")

        entries.append(entry)

    try:
        index = build_registry(existing, entries, title=args.title)
    except RegistryError as error:
        raise CliError(str(error)) from error

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {index_path} with {len(index['workshops'])} workshop(s)")

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
        trust=args.trust,
        junit=args.junit,
        json_out=args.json_out,
        lite=args.lite,
        lite_dir=args.lite_dir,
    )

    return run_self_test(options)


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
        registries=tuple(args.registry),
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
            "The MCP server needs the mcp extra: pip install "
            '"educates-jupyterlab-workshop[mcp]"'
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
