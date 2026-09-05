"""Detection of the operating system, shell and directories of the server.

The frontend uses this to choose platform-specific action variants and to
populate the built-in workshop variables. Detection is split into a pure
function, which takes every input explicitly so it can be tested without
patching, and a thin wrapper that gathers the inputs from the running
process.
"""

from __future__ import annotations

import getpass
import os
import platform as platform_module
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

KNOWN_SHELLS = {"bash", "zsh", "fish", "sh", "powershell", "cmd"}


@dataclass(frozen=True)
class PlatformInfo:
    """What the frontend needs to know about where the server runs."""

    os: str
    shell: str
    home: str
    user: str
    path_sep: str
    root_dir: str

    #: The JupyterHub user name, when running under a hub; else empty.
    hub_user: str = ""

    def to_dict(self) -> dict[str, str]:
        """Return the fields as a JSON-serialisable mapping."""

        return asdict(self)


def detect_platform(
    *,
    system: str,
    shell_command: Sequence[str] | None,
    environ: Mapping[str, str],
    home: str,
    user: str,
    root_dir: str,
) -> PlatformInfo:
    """Derive platform information from explicit inputs.

    ``system`` is the value of ``platform.system()``. ``shell_command`` is
    the command the terminal manager has been configured to run, if any;
    otherwise the ``SHELL`` environment variable is consulted, and failing
    that a platform default is assumed.
    """

    os_name = _os_name(system)
    shell = _shell_name(os_name, shell_command, environ)
    path_sep = "\\" if os_name == "windows" else "/"

    return PlatformInfo(
        os=os_name,
        shell=shell,
        home=home,
        user=user,
        path_sep=path_sep,
        root_dir=root_dir,
        hub_user=environ.get("JUPYTERHUB_USER", ""),
    )


def current_platform(
    *, shell_command: Sequence[str] | None, root_dir: str
) -> PlatformInfo:
    """Detect the platform of the running process."""

    return detect_platform(
        system=platform_module.system(),
        shell_command=shell_command,
        environ=os.environ,
        home=str(Path.home()),
        user=_current_user(),
        root_dir=root_dir,
    )


def _os_name(system: str) -> str:
    if system == "Darwin":
        return "macos"

    if system == "Windows":
        return "windows"

    return "linux"


def _shell_name(
    os_name: str, shell_command: Sequence[str] | None, environ: Mapping[str, str]
) -> str:
    # Prefer the shell the terminal manager has been told to run.
    candidate = ""

    if shell_command:
        candidate = shell_command[0]
    elif os_name != "windows":
        candidate = environ.get("SHELL", "")

    if candidate:
        # Windows shells may be configured with either separator style.
        pure_path = (
            PureWindowsPath(candidate)
            if os_name == "windows"
            else PurePosixPath(candidate)
        )
        name = pure_path.name.lower().removesuffix(".exe")

        if name == "pwsh":
            name = "powershell"

        if name in KNOWN_SHELLS:
            return name

    return "powershell" if os_name == "windows" else "sh"


def _current_user() -> str:
    try:
        return getpass.getuser()
    except (KeyError, OSError):
        return ""
