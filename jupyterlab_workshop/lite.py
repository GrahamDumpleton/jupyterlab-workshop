"""Building static JupyterLite sites that carry workshops.

A JupyterLite site is a directory of static files: the JupyterLab
frontend, the extensions installed in the current environment (including
this one), the Pyodide kernel, the terminal, and the contents the site
starts with. ``build_lite_site`` stages the workshops as those contents,
writes the site configuration that makes the extension open a workshop on
start, and runs ``jupyter lite build``. The result can be served by any
static web server, such as GitHub Pages, or by ``serve_directory`` for a
local look or a self-test.
"""

from __future__ import annotations

import functools
import http.server
import importlib.util
import json
import shutil
import subprocess
import sys
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

MANIFEST_FILE = "workshop.yaml"

PANEL_PLUGIN = "@jupyterlab-workshop/labextension:panel"

#: Entries of a workshop directory that never belong in a site.
IGNORED = ("_workshop", ".git", "node_modules", "__pycache__", ".ipynb_checkpoints")

#: The build addon of the terminal extension, disabled when it cannot run.
TERMINAL_ADDON = "jupyterlite-terminal"

#: Tools the terminal extension's build step needs on the path.
TERMINAL_TOOLS = ("node", "npm", "micromamba")

#: Runs a command in a directory and returns its exit code.
Runner = Callable[[Sequence[str], Path], int]


class LiteError(Exception):
    """A site could not be built."""


@dataclass(frozen=True)
class LiteBuildOptions:
    """What ``build_lite_site`` needs."""

    workshops: tuple[Path, ...]
    output: Path

    #: Where JupyterLite keeps its build state and caches; reused across
    #: builds so the terminal's WebAssembly packages download once.
    lite_dir: Path | None = None

    #: Name of the workshop to open on start; empty picks the only one.
    default_workshop: str = ""

    #: Trust level applied without asking, or empty to show the dialog.
    trust: str = ""

    #: Whether to include the terminal extension.
    terminal: bool = True

    #: Collection index locations the workshop browser lists.
    collections: tuple[str, ...] = ()

    #: Catalog locations the workshop browser offers collections from.
    catalogs: tuple[str, ...] = ()

    #: Rebuild everything rather than what changed.
    force: bool = True


@dataclass
class LiteBuildResult:
    """What a build produced."""

    output: Path
    workshops: list[str] = field(default_factory=list)
    terminal: bool = True
    command: list[str] = field(default_factory=list)


def default_lite_dir() -> Path:
    """The build cache directory, under the Jupyter data directory."""

    from jupyter_core.paths import jupyter_data_dir

    return Path(jupyter_data_dir()) / "jupyterlab-workshop" / "lite"


def missing_requirements(terminal: bool) -> list[str]:
    """Describe what is missing for a build, or return an empty list."""

    problems: list[str] = []

    if importlib.util.find_spec("jupyterlite_core") is None:
        problems.append(
            'jupyterlite-core is not installed: pip install "jupyterlab-workshop[lite]"'
        )

    if importlib.util.find_spec("jupyterlite_pyodide_kernel") is None:
        problems.append("jupyterlite-pyodide-kernel is not installed")

    if terminal:
        if importlib.util.find_spec("jupyterlite_terminal") is None:
            problems.append("jupyterlite-terminal is not installed")

        for tool in TERMINAL_TOOLS:
            if shutil.which(tool) is None:
                problems.append(
                    f"{tool} is not on the path; the terminal's build step needs "
                    "node, npm and micromamba (or pass --no-terminal)"
                )

    return problems


def _declared_workspace(directory: Path) -> list[str]:
    """The workspace directory the manifest declares, if any, which is
    generated on first open and so not shipped."""

    try:
        manifest = yaml.safe_load((directory / "workshop.yaml").read_text("utf-8"))
    except (OSError, yaml.YAMLError):
        return []

    workspace = manifest.get("workspace") if isinstance(manifest, dict) else None

    return [str(workspace).strip("/")] if workspace else []


def workshop_name(directory: Path) -> str:
    """The name of a workshop from its manifest, or its directory name."""

    manifest = directory / MANIFEST_FILE

    if not manifest.is_file():
        raise LiteError(f"{directory} has no {MANIFEST_FILE}")

    try:
        data = yaml.safe_load(manifest.read_text("utf-8"))
    except yaml.YAMLError as error:
        raise LiteError(f"{manifest} is not valid YAML: {error}") from error

    if isinstance(data, dict) and isinstance(data.get("name"), str):
        return str(data["name"])

    return directory.name


def stage_contents(workshops: Sequence[Path], staging: Path) -> list[str]:
    """Copy each workshop into ``staging/<name>`` and return the names.

    Progress and other generated files are left behind, so the site starts
    every learner from the beginning.
    """

    names: list[str] = []

    for directory in workshops:
        name = workshop_name(directory)

        if name in names:
            raise LiteError(f"Two workshops are named {name}")

        shutil.copytree(
            directory,
            staging / name,
            ignore=shutil.ignore_patterns(*IGNORED, *_declared_workspace(directory)),
            dirs_exist_ok=False,
        )
        names.append(name)

    return names


def site_config(terminal: bool = True) -> dict[str, Any]:
    """The ``jupyter-lite.json`` settings a workshop site needs.

    With ``terminal`` the site declares that terminals are available,
    which JupyterLab's own terminal plugin checks before offering File,
    New, Terminal and the launcher card; without it only the workshop's
    actions, which start sessions directly, could open one.
    """

    data: dict[str, Any] = {
        # The self-test drives the site through window.jupyterapp.
        "exposeAppInBrowser": True,
    }

    if terminal:
        data["terminalsAvailable"] = True

    return {"jupyter-lite-schema-version": 0, "jupyter-config-data": data}


def settings_overrides(
    options: LiteBuildOptions, names: Sequence[str]
) -> dict[str, Any]:
    """The extension settings baked into the site.

    The workshops live at the root of the site's contents, so the browser
    lists them from there, and the chosen workshop opens on start.
    """

    default = options.default_workshop or (names[0] if len(names) == 1 else "")

    if default and default not in names:
        raise LiteError(f"There is no workshop named {default} to open by default")

    settings: dict[str, Any] = {
        "defaultWorkshop": default,
        "workshopsDirectory": "",
        "collections": list(options.collections),
        "catalogs": list(options.catalogs),
    }

    if options.trust:
        settings["trustPolicy"] = {"forcedLevel": options.trust}

    return {PANEL_PLUGIN: settings}


def build_command(
    options: LiteBuildOptions, lite_dir: Path, staging: Path, overrides: Path
) -> list[str]:
    """The ``jupyter lite build`` invocation for the options."""

    command = [
        sys.executable,
        "-m",
        "jupyterlite_core",
        "build",
        f"--lite-dir={lite_dir}",
        f"--output-dir={options.output.resolve()}",
        f"--contents={staging}",
        f"--settings-overrides={overrides}",
        "--apps=lab",
        "--no-sourcemaps",
    ]

    if not options.terminal:
        command.append(f"--disable-addons={TERMINAL_ADDON}")

    if options.force:
        command.append("--force")

    return command


def build_lite_site(
    options: LiteBuildOptions, runner: Runner | None = None
) -> LiteBuildResult:
    """Build a site for the workshops and return what was built.

    ``runner`` runs the build command; the default runs it as a subprocess
    with its output shown.
    """

    problems = missing_requirements(options.terminal)

    if problems:
        raise LiteError("; ".join(problems))

    lite_dir = (options.lite_dir or default_lite_dir()).resolve()
    staging = lite_dir / "contents"
    overrides = lite_dir / "overrides.json"

    # The staging area is rebuilt from scratch so removed workshops go.
    lite_dir.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()

    names = stage_contents(options.workshops, staging)

    (lite_dir / "jupyter-lite.json").write_text(
        json.dumps(site_config(options.terminal), indent=2) + "\n", encoding="utf-8"
    )
    overrides.write_text(
        json.dumps(settings_overrides(options, names), indent=2) + "\n",
        encoding="utf-8",
    )

    if options.output.exists():
        shutil.rmtree(options.output)

    options.output.parent.mkdir(parents=True, exist_ok=True)

    command = build_command(options, lite_dir, staging, overrides)
    code = (runner or _run)(command, lite_dir)

    if code != 0:
        raise LiteError(f"jupyter lite build failed with exit code {code}")

    patch_site_config(options.output, terminal=options.terminal)

    return LiteBuildResult(
        output=options.output,
        workshops=names,
        terminal=options.terminal,
        command=command,
    )


def patch_site_config(output: Path, terminal: bool = True) -> None:
    """Apply ``site_config`` to the built site's configuration files.

    The build merges the settings from the build directory into the site,
    but the merge is skipped when the build considers the file up to date,
    so the settings are applied to the result as well.
    """

    wanted = site_config(terminal)["jupyter-config-data"]

    for path in [output / "jupyter-lite.json", output / "lab" / "jupyter-lite.json"]:
        if not path.is_file():
            continue

        config = json.loads(path.read_text("utf-8"))
        data = config.setdefault("jupyter-config-data", {})

        data.update(wanted)
        path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def _run(command: Sequence[str], cwd: Path) -> int:
    return subprocess.run(list(command), cwd=cwd, check=False).returncode


def serve_directory(
    root: Path, port: int = 0
) -> tuple[http.server.ThreadingHTTPServer, int]:
    """Serve a directory over HTTP on a background thread.

    Returns the server and the port it listens on; call ``shutdown`` on
    the server to stop it. Nothing is logged.
    """

    handler = functools.partial(_QuietHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)

    thread.start()

    return server, int(server.server_address[1])


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return None
