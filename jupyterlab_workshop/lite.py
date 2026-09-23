"""Building static JupyterLite sites that carry workshops.

A JupyterLite site is a directory of static files: the JupyterLab
frontend, the extensions installed in the current environment (including
this one), the Pyodide kernel, the terminal, and the contents the site
starts with. ``build_lite_site`` stages the workshops as those contents,
along with any collection index and welcome message the site carries,
writes the site configuration that makes the extension open a workshop or
the workshop browser on start, and runs ``jupyter lite build``. The result
can be served by any static web server, such as GitHub Pages, or by
``serve_directory`` for a local look or a self-test.
"""

from __future__ import annotations

import functools
import http.server
import importlib.util
import json
import posixpath
import re
import shutil
import subprocess
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeGuard

import yaml

from .catalog import CATALOG_FILE, is_http_url
from .overrides import quiet_news
from .publish import WORKSPACE_DIR

MANIFEST_FILE = "workshop.yaml"

#: Name of the index file in a directory laid out as a collection.
COLLECTION_FILE = "collection.json"

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

    #: Collections the workshop browser lists: URLs of their index files,
    #: or local index files (or directories holding a ``collection.json``)
    #: that are carried in the site.
    collections: tuple[str, ...] = ()

    #: Catalogs the workshop browser offers collections from: URLs, or
    #: local catalog files (or directories holding a ``catalog.json``)
    #: that are carried in the site with what they name by relative path.
    catalogs: tuple[str, ...] = ()

    #: Settings file in the form of ``overrides.json``, which the settings
    #: the build works out are laid over.
    settings: Path | None = None

    #: Markdown file carried in the site and shown as its welcome message.
    welcome: Path | None = None

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
                    "node, npm and micromamba (jupyter workshop lite takes "
                    "--no-terminal to build without it)"
                )

    return problems


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


#: Page text that needs the terminal extension's shell without a terminal
#: being shown: a captured command, and a check on the ``shell`` substrate.
_HEADLESS_SHELL = re.compile(
    r"^`{3,}\{execute-capture\}|^:substrate:\s*shell\s*$", re.MULTILINE
)


def uses_terminal(directory: Path) -> bool:
    """Whether a workshop needs the terminal extension in a site.

    It does when its manifest declares the ``terminal`` capability, and
    when a page captures a command or checks with a shell command, both
    of which run in the extension's headless shell. A manifest that
    cannot be read counts as needing it, so that a doubt never leaves a
    workshop without something it uses.
    """

    try:
        data = yaml.safe_load((directory / MANIFEST_FILE).read_text("utf-8"))
    except (OSError, yaml.YAMLError):
        return True

    if not isinstance(data, dict):
        return True

    capabilities = data.get("capabilities") or []

    if not isinstance(capabilities, list) or "terminal" in capabilities:
        return True

    for page in sorted(directory.rglob("*.md")):
        relative = page.relative_to(directory).parts

        if any(part in IGNORED or part == WORKSPACE_DIR for part in relative):
            continue

        if _HEADLESS_SHELL.search(page.read_text("utf-8")):
            return True

    return False


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
            ignore=shutil.ignore_patterns(*IGNORED, WORKSPACE_DIR),
            dirs_exist_ok=False,
        )
        names.append(name)

    return names


def stage_collections(
    collections: Sequence[str], staging: Path, carried: dict[Path, str] | None = None
) -> list[str]:
    """Carry the local collection indexes in the site, and return where
    the workshop browser finds every collection.

    A URL is returned as it is. A local index file, or a directory holding
    a ``collection.json``, is copied to the root of the site's contents
    under its own name, along with an icon it names by a relative path,
    and returned as that path. A site built this way subscribes to its
    collection without knowing the address it will be served from.

    ``carried`` records what is already in the contents, by source file.
    An index a carried catalog names is subscribed to where the catalog
    put it, so the browser sees the catalog's entry as the subscribed one.
    """

    carried = {} if carried is None else carried
    locations: list[str] = []

    for location in collections:
        if is_http_url(location):
            locations.append(location)
            continue

        source = _index_file(location, COLLECTION_FILE)

        locations.append(_stage_index(source, staging, source.name, carried))

    return locations


def stage_catalogs(
    catalogs: Sequence[str], staging: Path, carried: dict[Path, str] | None = None
) -> list[str]:
    """Carry the local catalogs in the site, and return where the workshop
    browser finds every catalog.

    A URL is returned as it is. A local catalog file, or a directory
    holding a ``catalog.json``, is copied to the root of the site's
    contents under its own name and returned as that path. The browser
    resolves what a catalog names by a relative path against the catalog,
    so each collection index and icon named that way is carried at the
    same place beside it, a collection's own icon included. Collections
    named by URL stay where they are.
    """

    carried = {} if carried is None else carried
    locations: list[str] = []

    for location in catalogs:
        if is_http_url(location):
            locations.append(location)
            continue

        source = _index_file(location, CATALOG_FILE)
        staged = _stage_index(source, staging, source.name, carried)
        entries = _read_index(source).get("collections")

        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue

            url, icon = entry.get("url"), entry.get("icon")

            if _is_relative(url):
                _stage_index(
                    source.parent / url, staging, _beside(staged, url), carried
                )

            if _is_relative(icon):
                _stage_file(
                    source.parent / icon, staging, _beside(staged, icon), carried
                )

        locations.append(staged)

    return locations


def stage_welcome(welcome: Path | None, staging: Path) -> str:
    """Carry the welcome message in the site, at the root of its contents,
    and return its path there; empty when there is none."""

    if welcome is None:
        return ""

    return _stage_file(welcome, staging, welcome.name, {})


def _index_file(location: str, filename: str) -> Path:
    source = Path(location)

    # A directory laid out as a collection or catalog holds its index
    # under a fixed name, so naming the directory is enough.
    if source.is_dir():
        source = source / filename

    if not source.is_file():
        raise LiteError(f"{location} is not a URL or a {filename} file")

    return source


def _read_index(index: Path) -> dict[str, Any]:
    try:
        data = json.loads(index.read_text("utf-8"))
    except (OSError, ValueError) as error:
        raise LiteError(f"{index} cannot be read as JSON: {error}") from error

    return data if isinstance(data, dict) else {}


def _is_relative(location: Any) -> TypeGuard[str]:
    if not isinstance(location, str) or not location:
        return False

    return not is_http_url(location) and not location.lower().startswith("data:")


def _beside(staged: str, relative: str) -> str:
    return posixpath.join(posixpath.dirname(staged), relative)


def _stage_index(
    source: Path, staging: Path, relative: str, carried: dict[Path, str]
) -> str:
    """Carry a collection or catalog file at a path in the contents, and
    beside it the icon it names by a relative path."""

    known = carried.get(source.resolve())

    if known is not None:
        return known

    staged = _stage_file(source, staging, relative, carried)
    icon = _read_index(source).get("icon")

    if _is_relative(icon):
        _stage_file(source.parent / icon, staging, _beside(staged, icon), carried)

    return staged


def _stage_file(
    source: Path, staging: Path, relative: str, carried: dict[Path, str]
) -> str:
    root = staging.resolve()
    target = (root / relative).resolve()

    if not target.is_relative_to(root):
        raise LiteError(f"{relative} would land outside the site's contents")

    staged = target.relative_to(root).as_posix()

    # A file named twice at the same place, such as an icon a catalog and
    # its collection share, is carried once.
    if carried.get(source.resolve()) == staged:
        return staged

    if not source.is_file():
        raise LiteError(f"{source} does not exist")

    # Everything staged shares the root of the contents with the
    # workshops, so a name can only be used once, and nothing is put
    # inside a workshop, where it would become part of it.
    if target.exists():
        raise LiteError(
            f"{source} would overwrite {relative} in the site's contents; "
            "rename one of the two"
        )

    for parent in target.relative_to(root).parents:
        if parent != Path(".") and (root / parent / MANIFEST_FILE).is_file():
            raise LiteError(
                f"{source} would land inside the workshop {parent} as "
                f"{relative}; rename one of the two"
            )

    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    carried.setdefault(source.resolve(), staged)

    return staged


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
        # The extension reads this back as the frontend version on its
        # progress events, since a site has no server to ask.
        "jupyterlabWorkshopVersion": _package_version(),
    }

    if terminal:
        data["terminalsAvailable"] = True

    return {"jupyter-lite-schema-version": 0, "jupyter-config-data": data}


def _package_version() -> str:
    try:
        from ._version import __version__
    except ImportError:
        return ""

    return str(__version__)


def load_settings(path: Path | None) -> dict[str, Any]:
    """Read a settings file in the form of ``overrides.json``: an object
    holding the settings of each plugin under the plugin's id. Without a
    file there are no settings."""

    if path is None:
        return {}

    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as error:
        raise LiteError(f"{path} cannot be read as JSON: {error}") from error

    # Settings written without the plugin's id around them are the likely
    # mistake, and would otherwise be carried into the site and ignored.
    if not isinstance(data, dict) or not all(
        ":" in key and isinstance(value, dict) for key, value in data.items()
    ):
        raise LiteError(
            f"{path} must hold the settings of each plugin under its id, as "
            f'overrides.json does: {{"{PANEL_PLUGIN}": {{...}}}}'
        )

    return data


def settings_schema() -> dict[str, Any] | None:
    """The extension's settings schema, from where JupyterLab finds the
    installed extension, or None when it is not there to be read."""

    from jupyter_core.paths import jupyter_path

    package, _, plugin = PANEL_PLUGIN.partition(":")

    for directory in jupyter_path("labextensions"):
        path = Path(directory) / package / "schemas" / package / f"{plugin}.json"

        if path.is_file():
            schema: dict[str, Any] = json.loads(path.read_text("utf-8"))

            return schema

    return None


def check_settings(settings: Mapping[str, Any], source: Path) -> None:
    """Hold the extension's settings from a file to the settings schema.

    A static site has nobody to report a misspelt setting to, so the
    build refuses one. Nothing is checked when the schema cannot be found.
    """

    import jsonschema

    schema = settings_schema()

    if schema is None:
        return

    validator = jsonschema.Draft7Validator(schema)
    errors = sorted(validator.iter_errors(settings), key=lambda item: list(item.path))

    if errors:
        where = "/".join(str(part) for part in errors[0].path)
        prefix = f"{where}: " if where else ""

        raise LiteError(f"{source}: {prefix}{errors[0].message}")


def settings_overrides(
    options: LiteBuildOptions,
    names: Sequence[str],
    collections: Sequence[str] | None = None,
    welcome: str = "",
    catalogs: Sequence[str] | None = None,
) -> dict[str, Any]:
    """The settings baked into the site.

    The settings file, when there is one, is the base, and what the build
    works out is laid over it. The workshops live at the root of the
    site's contents, so the browser lists them from there, and the chosen
    workshop opens on start. A site with no workshop to open starts in
    the workshop browser rather than at the launcher, unless the settings
    file says otherwise. The Jupyter news prompt is off unless the file
    settles it.

    ``collections``, ``catalogs`` and ``welcome`` are where staging put
    them in the contents; left out, the collections and catalogs are used
    as the options give them.
    """

    overrides = load_settings(options.settings)
    panel = dict(overrides.get(PANEL_PLUGIN) or {})

    if options.settings is not None:
        check_settings(panel, options.settings)

    if options.default_workshop:
        default = options.default_workshop
    elif isinstance(panel.get("defaultWorkshop"), str):
        default = str(panel["defaultWorkshop"])
    else:
        default = names[0] if len(names) == 1 else ""

    if default and default not in names:
        raise LiteError(f"There is no workshop named {default} to open by default")

    if collections is None:
        collections = options.collections

    if catalogs is None:
        catalogs = options.catalogs

    panel["defaultWorkshop"] = default
    panel["workshopsDirectory"] = ""
    panel["collections"] = _merged(panel.get("collections"), collections)
    panel["catalogs"] = _merged(panel.get("catalogs"), catalogs)

    if not default:
        panel.setdefault("browseOnStart", True)

    if options.trust:
        policy = dict(panel.get("trustPolicy") or {})
        policy["forcedLevel"] = options.trust
        panel["trustPolicy"] = policy

    if welcome:
        panel["welcome"] = welcome

    overrides[PANEL_PLUGIN] = panel

    return quiet_news(overrides)


def _merged(existing: Any, added: Sequence[str]) -> list[str]:
    merged: list[str] = list(existing) if isinstance(existing, list) else []

    for item in added:
        if item not in merged:
            merged.append(item)

    return merged


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

    # Catalogs go first: a collection given on its own as well is then
    # subscribed to where its catalog put it, not carried a second time.
    carried: dict[Path, str] = {}
    catalogs = stage_catalogs(options.catalogs, staging, carried)
    collections = stage_collections(options.collections, staging, carried)
    welcome = stage_welcome(options.welcome, staging)

    (lite_dir / "jupyter-lite.json").write_text(
        json.dumps(site_config(options.terminal), indent=2) + "\n", encoding="utf-8"
    )
    overrides.write_text(
        json.dumps(
            settings_overrides(options, names, collections, welcome, catalogs),
            indent=2,
        )
        + "\n",
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
