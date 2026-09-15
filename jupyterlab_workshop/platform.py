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
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

KNOWN_SHELLS = {"bash", "zsh", "fish", "sh", "powershell", "cmd"}

#: Environment variables BinderHub sets in every container it launches.
BINDER_VARIABLES = ("BINDER_REPO_URL", "BINDER_LAUNCH_HOST", "BINDER_REF_URL")

#: Environment variables JupyterHub sets in every single-user server.
JUPYTERHUB_VARIABLES = ("JUPYTERHUB_USER", "JUPYTERHUB_API_URL")

#: The variable GitHub Codespaces sets to "true" in every codespace, and
#: the one naming the codespace, both of which must be present.
CODESPACES_VARIABLES = ("CODESPACES", "CODESPACE_NAME")

#: The frontend this server extension serves.
FRONTEND = "jupyterlab"

try:
    from ._version import __version__ as FRONTEND_VERSION
except ImportError:
    # The version file is generated when the package is built or installed.
    FRONTEND_VERSION = ""

#: Files whose presence marks a container runtime.
CONTAINER_FILES = (".dockerenv", "run/.containerenv")

#: Words in the cgroup of process 1 that name a container runtime.
CONTAINER_CGROUP_WORDS = ("docker", "kubepods", "containerd", "podman", "lxc")


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

    #: The service hosting the session: binder, codespaces, jupyterhub or
    #: local. A JupyterLite site reports static, from the browser.
    host: str = "local"

    #: Whether the server runs inside a container.
    container: bool = False

    #: The frontend served: jupyterlab here; JupyterLite reports its own.
    frontend: str = FRONTEND

    #: The version of this package, which built the extension the
    #: frontend runs, so events say which code produced them.
    frontend_version: str = FRONTEND_VERSION

    #: Id of this run of the server, the same for every workshop opened
    #: under it, so progress events of one JupyterLab can be grouped.
    instance_id: str = ""

    def to_dict(self) -> dict[str, object]:
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
    container: bool = False,
    instance_id: str = "",
) -> PlatformInfo:
    """Derive platform information from explicit inputs.

    ``system`` is the value of ``platform.system()``. ``shell_command`` is
    the command the terminal manager has been configured to run, if any;
    otherwise the ``SHELL`` environment variable is consulted, and failing
    that a platform default is assumed. ``container`` is the result of
    :func:`detect_container`. The hosting service is read from the
    environment variables Binder, Codespaces and JupyterHub set.
    ``instance_id`` identifies the running server; see :func:`instance_id`.
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
        host=_host_name(environ),
        container=container,
        instance_id=instance_id,
    )


def detect_container(environ: Mapping[str, str], fs_root: Path) -> bool:
    """Whether the process appears to run inside a container.

    Looks for the marker files Docker and Podman leave at the root of the
    filesystem, the service variable Kubernetes injects into every pod,
    and container runtime names in the cgroup of process 1. Sandboxed
    runtimes that hide all of these are reported as not containerised.
    """

    if "KUBERNETES_SERVICE_HOST" in environ:
        return True

    if any((fs_root / name).exists() for name in CONTAINER_FILES):
        return True

    # The cgroup listing names the runtime that created the cgroup.
    cgroup = fs_root / "proc" / "1" / "cgroup"

    try:
        content = cgroup.read_text(errors="replace")
    except OSError:
        return False

    return any(word in content for word in CONTAINER_CGROUP_WORDS)


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
        container=detect_container(os.environ, Path("/")),
        instance_id=instance_id(),
    )


_INSTANCE_ID = ""


def instance_id() -> str:
    """The id of this run of the server, minted once per process.

    Every workshop opened under the server carries it on its progress
    events, so a learner working through a collection on one JupyterLab
    appears as one instance rather than unrelated sessions. A restarted
    server is a new instance, which is what tells the frontend that the
    terminals and kernels a workshop was using are gone.
    """

    global _INSTANCE_ID

    if not _INSTANCE_ID:
        _INSTANCE_ID = uuid.uuid4().hex

    return _INSTANCE_ID


def _host_name(environ: Mapping[str, str]) -> str:
    # A Binder container also carries the JupyterHub variables, so Binder
    # is checked first; a codespace carries neither.
    if any(name in environ for name in BINDER_VARIABLES):
        return "binder"

    if environ.get("CODESPACES") == "true" and all(
        name in environ for name in CODESPACES_VARIABLES
    ):
        return "codespaces"

    if any(name in environ for name in JUPYTERHUB_VARIABLES):
        return "jupyterhub"

    return "local"


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
