"""The ``jupyter workshop`` command line tool.

Registered as the ``jupyter-workshop`` console script, which the
``jupyter`` launcher picks up as ``jupyter workshop``. Lint and render run
the core package's Node bundle shipped inside this package, so they need
``node`` on the path; the other commands are pure Python.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
from collections.abc import Sequence
from pathlib import Path

import yaml

from . import __version__ as VERSION
from .scaffold import slug, write_scaffold

PACKAGE_DIR = Path(__file__).resolve().parent

NODE_BUNDLE = PACKAGE_DIR / "nodejs" / "workshop-cli.cjs"

SCHEMA_FILE = PACKAGE_DIR / "schema" / "workshop.schema.json"

PUBLISH_EXCLUDES = {"_workshop", ".git", ".github", "scratch", "dist", "node_modules"}


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
    init.set_defaults(func=command_init)

    lint = commands.add_parser("lint", help="report problems in a workshop")
    lint.add_argument("directory", type=Path)
    lint.add_argument("--json", action="store_true", help="print the report as JSON")
    lint.set_defaults(func=command_lint)

    render = commands.add_parser("render", help="render pages to standalone HTML")
    render.add_argument("directory", type=Path)
    render.add_argument("page", nargs="?", help="page id or path; default all pages")
    render.add_argument("--out", type=Path, help="write to a file instead of stdout")
    render.set_defaults(func=command_render)

    pages = commands.add_parser("pages", help="list the pages of a workshop")
    pages.add_argument("directory", type=Path)
    pages.set_defaults(func=command_pages)

    schema = commands.add_parser("schema", help="print the manifest JSON schema")
    schema.set_defaults(func=command_schema)

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
    test.set_defaults(func=command_test)

    return parser


def command_init(args: argparse.Namespace) -> int:
    """Scaffold a workshop."""

    directory: Path = args.directory
    name = args.name or slug(directory.resolve().name)
    title = args.title or name.replace("-", " ").capitalize()

    try:
        written = write_scaffold(directory, name, title, ci=args.ci)
    except FileExistsError as error:
        raise CliError(str(error)) from error

    for path in written:
        print(f"wrote {path}")

    print(f"\nNext: jupyter workshop lint {directory}")

    return 0


def command_lint(args: argparse.Namespace) -> int:
    """Lint a workshop through the Node bundle."""

    extra = ["--json"] if args.json else []
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
    """Print the manifest schema."""

    if not SCHEMA_FILE.is_file():
        raise CliError(
            "The manifest schema is missing from this installation; "
            "build the package first"
        )

    sys.stdout.write(SCHEMA_FILE.read_text(encoding="utf-8"))

    return 0


def command_publish(args: argparse.Namespace) -> int:
    """Archive a workshop for distribution."""

    directory = _workshop_dir(args.directory)
    manifest = _read_manifest(directory)
    name = str(manifest.get("name") or "")
    version = str(manifest.get("version") or "0.0.0")

    if not name:
        raise CliError("The manifest has no name")

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    archive = out / f"{name}-{version}.tar.gz"

    with tarfile.open(archive, "w:gz") as tar:
        for entry in sorted(directory.iterdir()):
            if entry.name in PUBLISH_EXCLUDES:
                continue

            tar.add(entry, arcname=f"{name}-{version}/{entry.name}", filter=_clean_tar)

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()

    (out / f"{archive.name}.sha256").write_text(f"{digest}  {archive.name}\n")

    registry_entry = {
        "name": name,
        "title": manifest.get("title", name),
        "description": manifest.get("description", ""),
        "tags": manifest.get("tags", []),
        "platforms": manifest.get("platforms", []),
        "capabilities": manifest.get("capabilities", []),
        "versions": [
            {
                "version": version,
                "source": {"archive": args.url or f"<url of {archive.name}>"},
                "sha256": digest,
            }
        ],
    }

    (out / f"{name}-{version}.registry.json").write_text(
        json.dumps(registry_entry, indent=2) + "\n"
    )

    print(f"wrote {archive}")
    print(f"sha256 {digest}")
    print(f"wrote {out / f'{name}-{version}.registry.json'}")

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
    )

    return run_self_test(options)


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


def _read_manifest(directory: Path) -> dict[str, object]:
    try:
        data = yaml.safe_load((directory / "workshop.yaml").read_text(encoding="utf-8"))
    except yaml.YAMLError as error:
        raise CliError(f"workshop.yaml is not valid YAML: {error}") from error

    if not isinstance(data, dict):
        raise CliError("workshop.yaml must be a mapping")

    return data


def _clean_tar(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    # Leave out editor and OS droppings and normalise ownership so the
    # archive hash is stable across machines.
    base = Path(info.name).name

    if base in {".DS_Store", "Thumbs.db"} or base.endswith("~"):
        return None

    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0

    return info


if __name__ == "__main__":
    sys.exit(main())
