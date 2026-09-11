"""Behind ``jupyter workshop launch``: start JupyterLab on a launch link.

A launch link is a JupyterLab URL whose query parameters name a workshop,
collection or catalog to open once JupyterLab has started; see the
collections chapter of the documentation. Building one by hand and
handing it to ``jupyter lab`` is fiddly, so this module builds it from
command line options, starts the server on a free port with the options
it needs, waits until it answers, prints the link and opens it in the
browser. JupyterLab itself is left in charge of the terminal: its log
goes to the console as usual and Ctrl-C reaches it as usual.
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .catalog import is_http_url

PANEL_PLUGIN = "@jupyterlab-workshop/labextension:panel"

#: A workshop name as a launch link reads one alongside a collection.
WORKSHOP_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")

#: Seconds to allow the server to start answering.
START_TIMEOUT = 120.0


class LaunchError(Exception):
    """The launch could not be set up."""


@dataclass(frozen=True)
class LaunchOptions:
    """What ``jupyter workshop launch`` was asked to do."""

    #: A workshop directory, a URL, or a name in ``collection``; None
    #: starts in the workshop browser.
    target: str | None = None

    #: The JupyterLab root directory.
    root: Path = field(default_factory=Path.cwd)

    ref: str | None = None
    subdir: str | None = None
    sha256: str | None = None
    collection: str | None = None
    catalog: str | None = None
    variables: Mapping[str, str] = field(default_factory=dict)

    #: ``ask`` or ``force``, or None not to restart.
    restart: str | None = None

    welcome: str | None = None

    #: A trust level to force for the session, or None to leave the
    #: dialog to the learner.
    trust: str | None = None

    port: int | None = None
    open_browser: bool = True

    #: Give the server workspaces and user settings of its own.
    fresh: bool = False

    #: Further arguments for ``jupyter lab``.
    lab_args: Sequence[str] = ()


def launch_query(options: LaunchOptions) -> list[tuple[str, str | None]]:
    """The launch link's query parameters, in order, resolved against the
    root: a directory becomes its path relative to the root, a URL stays
    as it is, and a name stays a name when a collection is given. A
    parameter with a None value is a bare key, which is how ``restart``
    asks rather than forces.

    Raises LaunchError for a target that cannot be expressed as a launch
    link, such as a directory outside the root.
    """

    root = options.root.resolve()
    params: list[tuple[str, str | None]] = []

    if options.target is not None:
        params.append(("workshop", _workshop_parameter(options, root)))

        for key in ("ref", "subdir", "sha256"):
            value = getattr(options, key)

            if value:
                params.append((key, value))

    if options.collection:
        params.append(
            (
                "collection",
                _index_parameter(options.collection, root, "collection.json"),
            )
        )

    if options.catalog:
        params.append(
            ("catalog", _index_parameter(options.catalog, root, "catalog.json"))
        )

    for name, value in options.variables.items():
        params.append((f"var.{name}", value))

    if options.restart == "force":
        params.append(("restart", "force"))
    elif options.restart == "ask":
        params.append(("restart", None))

    if options.welcome:
        params.append(
            ("welcome", _relative_to_root(options.welcome, root, "welcome file"))
        )

    return params


def _workshop_parameter(options: LaunchOptions, root: Path) -> str:
    target = str(options.target)

    if is_http_url(target):
        return target

    # A bare name alongside a collection is one of the collection's
    # workshops, which is how the extension reads the link too; a
    # directory of that name under the root cannot be told apart, so it
    # is refused rather than silently installed over.
    if options.collection and WORKSHOP_NAME.match(target):
        if (root / target).is_dir():
            raise LaunchError(
                f"{target!r} is both a directory under the root and a name a "
                "collection could hold; with --collection the target is a "
                "workshop in the collection, so open the directory without "
                "--collection or name it by a longer path"
            )

        return target

    if options.ref or options.subdir or options.sha256:
        raise LaunchError("--ref, --subdir and --sha256 apply to a URL target only")

    directory = Path(target)

    if not directory.is_dir():
        raise LaunchError(f"{target} is not a directory or a URL")

    if not (directory / "workshop.yaml").is_file():
        raise LaunchError(f"{target} has no workshop.yaml")

    return _relative_to_root(target, root, "workshop directory")


def _index_parameter(location: str, root: Path, filename: str) -> str:
    if is_http_url(location):
        return location

    path = Path(location)

    # A directory laid out as a collection or catalog holds its index
    # under a fixed name, so naming the directory is enough.
    if path.is_dir() and (path / filename).is_file():
        path = path / filename

    if not path.is_file():
        raise LaunchError(f"{location} is not a URL or a {filename} file")

    return _relative_to_root(str(path), root, filename)


def _relative_to_root(location: str, root: Path, what: str) -> str:
    path = Path(location).resolve()

    if not path.exists():
        raise LaunchError(f"{what} {location} does not exist")

    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        raise LaunchError(
            f"{what} {location} is outside the JupyterLab root {root}; "
            "JupyterLab can only reach files under its root, so start it "
            "from a directory above the file or name one with --root"
        ) from None


def launch_url(base: str, token: str, params: Sequence[tuple[str, str | None]]) -> str:
    """The full launch link for a server at ``base``, with the token first
    so the link opens without a login page."""

    parts = [f"token={quote(token, safe='')}"]

    for key, value in params:
        if value is None:
            parts.append(key)
        else:
            parts.append(f"{key}={quote(value, safe='/:@')}")

    return f"{base.rstrip('/')}/lab?{'&'.join(parts)}"


def launch_overrides(
    existing: Mapping[str, Any], options: LaunchOptions, browse: bool
) -> dict[str, Any] | None:
    """Settings overrides for the session: the deployment's, with the
    trust level forced when asked and the workshop browser opened on
    start for a launch that names nothing. None when the launch needs
    no overrides of its own.
    """

    if options.trust is None and not browse:
        return None

    overrides: dict[str, Any] = {key: value for key, value in existing.items()}
    panel = dict(overrides.get(PANEL_PLUGIN) or {})

    if options.trust is not None:
        policy = dict(panel.get("trustPolicy") or {})
        policy["forcedLevel"] = options.trust
        panel["trustPolicy"] = policy

    if browse:
        panel["browseOnStart"] = True

    overrides[PANEL_PLUGIN] = panel

    return overrides


def run_launch(options: LaunchOptions) -> int:
    """Start JupyterLab as the options ask, open the launch link, and
    return JupyterLab's exit code once it has stopped."""

    root = options.root.resolve()

    if not root.is_dir():
        raise LaunchError(f"root {options.root} is not a directory")

    params = launch_query(options)
    browse = options.target is None and not options.collection and not options.catalog

    port = options.port if options.port is not None else free_port()
    token = secrets.token_hex(16)
    work = Path(tempfile.mkdtemp(prefix="workshop-launch-"))

    try:
        command = server_command(root, port, token, options, work, browse)
        server = subprocess.Popen(command, cwd=root)

        # From here on Ctrl-C is JupyterLab's to handle, with its own
        # confirmation, and this process only waits for it to finish.
        signal.signal(signal.SIGINT, signal.SIG_IGN)

        try:
            wait_for_server(port, token, server)
        except LaunchError as error:
            stop_server(server)

            raise error

        url = launch_url(f"http://127.0.0.1:{port}", token, params)

        print(f"\nWorkshop launch link:\n\n    {url}\n", flush=True)

        if options.open_browser:
            webbrowser.open(url)

        return server.wait()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def server_command(
    root: Path,
    port: int,
    token: str,
    options: LaunchOptions,
    work: Path,
    browse: bool,
) -> list[str]:
    """The ``jupyter lab`` command line for the launch, writing whatever
    settings it needs under ``work``.

    The port is pinned so the link printed is the one the server
    answers on, and the browser is opened here rather than by
    JupyterLab, whose own link would lack the launch parameters. The
    caller's extra arguments go last so they take precedence.
    """

    command = [
        sys.executable,
        "-m",
        "jupyterlab",
        "--no-browser",
        f"--port={port}",
        "--ServerApp.port_retries=0",
        f"--ServerApp.root_dir={root}",
        f"--IdentityProvider.token={token}",
    ]

    settings = write_settings(work, options, browse)

    if settings is not None:
        command.append(f"--LabApp.app_settings_dir={settings}")

    # Private workspaces and user settings, as the self-test uses, so a
    # demo is not shaped by the layout and settings of other sessions.
    if options.fresh:
        workspaces = work / "workspaces"
        user_settings = work / "user-settings"

        workspaces.mkdir(parents=True, exist_ok=True)
        user_settings.mkdir(parents=True, exist_ok=True)

        command.append(f"--LabApp.workspaces_dir={workspaces}")
        command.append(f"--LabApp.user_settings_dir={user_settings}")

    command.extend(options.lab_args)

    return command


def write_settings(work: Path, options: LaunchOptions, browse: bool) -> Path | None:
    """Write the session's application settings directory under ``work``
    and return it, or None when the installed one serves as it is.

    JupyterLab reads ``overrides.json`` and ``page_config.json`` from a
    single directory, so pointing it at a new one would drop the
    deployment's own overrides; both files are carried across, with the
    launch's changes merged into the overrides.
    """

    installed = installed_settings_dir()
    existing: dict[str, Any] = {}

    if installed is not None and (installed / "overrides.json").is_file():
        try:
            loaded = json.loads((installed / "overrides.json").read_text("utf-8"))
        except (OSError, ValueError) as error:
            raise LaunchError(
                f"unable to read {installed / 'overrides.json'}: {error}"
            ) from error

        if isinstance(loaded, dict):
            existing = loaded

    overrides = launch_overrides(existing, options, browse)

    if overrides is None:
        return None

    settings = work / "settings"
    settings.mkdir(parents=True, exist_ok=True)
    (settings / "overrides.json").write_text(json.dumps(overrides, indent=2), "utf-8")

    if installed is not None and (installed / "page_config.json").is_file():
        shutil.copy(installed / "page_config.json", settings / "page_config.json")

    return settings


def installed_settings_dir() -> Path | None:
    """The application settings directory of the installed JupyterLab,
    or None when JupyterLab cannot say."""

    try:
        from jupyterlab.commands import get_app_dir
    except ImportError:
        return None

    return Path(get_app_dir()) / "settings"


def free_port() -> int:
    """A TCP port nothing is listening on right now."""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))

        return int(sock.getsockname()[1])


def wait_for_server(
    port: int,
    token: str,
    server: subprocess.Popen[bytes],
    timeout: float = START_TIMEOUT,
    sleep: float = 0.5,
) -> None:
    """Wait until the server answers its status request, raising
    LaunchError when it exits first or the timeout passes."""

    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/api/status?token={token}"

    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise LaunchError(
                f"JupyterLab exited with status {server.returncode} before it was ready"
            )

        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except (urllib.error.URLError, OSError):
            time.sleep(sleep)

    raise LaunchError(f"JupyterLab did not start within {int(timeout)} seconds")


def stop_server(server: subprocess.Popen[bytes]) -> None:
    """Stop the server and everything it started."""

    if server.poll() is not None:
        return

    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(server.pid)],
            capture_output=True,
            check=False,
        )
    else:
        server.terminate()

    try:
        server.wait(timeout=15)
    except subprocess.TimeoutExpired:
        server.kill()


def parse_variable(text: str) -> tuple[str, str]:
    """Split a ``NAME=VALUE`` argument, raising LaunchError for anything
    else."""

    name, separator, value = text.partition("=")

    if not separator or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
        raise LaunchError(f"--var needs NAME=VALUE, not {text!r}")

    return name, value
