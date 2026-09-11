"""Isolated Python environments for workshops.

A manifest may declare ``environment.requirements``. The extension then
offers to create a virtual environment under ``_workshop/venv`` inside the
workshop directory, install the requirements and ``ipykernel`` into it,
and register a kernelspec for it so notebooks and the workshop kernel can
use it. Everything is tracked in ``_workshop/environment.json`` so it can
be reported and removed again.

Kernelspecs are registered for the user, so they are shared by every
JupyterLab the user runs and outlive any one server. The name registered
is the declared name with a short hash of the workshop's location, so
two copies of a workshop in different directories never share, and
clobber, one spec. Nothing here removes a spec unless its Python lives
inside a workshop's ``_workshop/venv`` directory: the server's own
kernel and any other kernel the user registered are never touched.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .checks import CheckError, _workshop_dir, venv_bin_dir
from .fetch import FetchError, _resolve_inside

STATE_DIR = "_workshop"

VENV_DIR = "venv"

RECORD_FILE = "environment.json"

LOG_FILE = "environment.log"

INSTALL_TIMEOUT = 1800.0


class EnvironmentSetupError(Exception):
    """An environment could not be created, inspected or removed."""


@dataclass(frozen=True)
class EnvironmentStatus:
    """What is known about a workshop's environment."""

    kernel: str
    ready: bool
    registered: bool
    python: str = ""

    #: The virtual environment's directory and the directory of its
    #: programs, for putting it on a terminal's PATH; empty until ready.
    venv: str = ""
    bin: str = ""
    requirements: str = ""

    #: Whether the requirements file changed since the environment was made.
    stale: bool = False
    created_at: str = ""
    log: str = ""

    def to_dict(self) -> dict[str, Any]:
        """A JSON friendly form."""

        data = asdict(self)
        data["createdAt"] = data.pop("created_at")

        return data


def environment_status(
    root_dir: Path, workshop_path: str, kernel: str
) -> EnvironmentStatus:
    """Report whether the environment exists and matches its requirements."""

    workshop = _workshop(root_dir, workshop_path)
    record = _read_record(workshop)
    python = _venv_python(workshop)
    ready = bool(record) and python.is_file()
    requirements = str(record.get("requirements") or "")
    stale = False

    if ready and requirements:
        try:
            current = _digest(_resolve_inside(workshop, requirements))
        except (FetchError, OSError):
            current = ""

        stale = current != str(record.get("sha256") or "")

    venv = workshop / STATE_DIR / VENV_DIR
    name = str(record.get("kernel") or registered_kernel_name(workshop, kernel))

    return EnvironmentStatus(
        kernel=name,
        ready=ready,
        registered=ready and _spec_owned_by(name, venv),
        python=str(python) if ready else "",
        venv=str(venv) if ready else "",
        bin=str(venv_bin_dir(venv)) if ready else "",
        requirements=requirements,
        stale=stale,
        created_at=str(record.get("createdAt") or ""),
        log=_tail(workshop / STATE_DIR / LOG_FILE),
    )


def registered_kernel_name(workshop: Path, base: str) -> str:
    """The kernelspec name registered for a workshop: the declared name
    followed by eight hex digits of a hash of the workshop's location.

    Kernelspecs are per user, so the same workshop installed in two
    directories would otherwise register one spec between them, each
    creation pointing it at its own venv and each removal deleting it
    for both.
    """

    digest = hashlib.sha256(str(workshop.resolve()).encode("utf-8")).hexdigest()

    return f"{base}-{digest[:8]}"


def create_environment(
    root_dir: Path,
    workshop_path: str,
    requirements: str,
    kernel: str,
    display_name: str = "",
    register: bool = True,
    python: str = sys.executable,
    timeout: float = INSTALL_TIMEOUT,
    force: bool = False,
) -> EnvironmentStatus:
    """Create the venv, install the requirements and register the kernel.

    An environment that was built from the current requirements file and
    still has its kernel registered is kept as it is, so the action can
    sit on a page and be clicked more than once; ``force`` replaces it
    regardless, as the banner's Recreate button does. ``register`` can be
    turned off to build the venv without ``ipykernel`` and a kernelspec,
    which the tests use to stay offline.
    """

    workshop = _workshop(root_dir, workshop_path)

    try:
        requirements_path = _resolve_inside(workshop, requirements)
    except FetchError as error:
        raise EnvironmentSetupError(str(error)) from error

    if not requirements_path.is_file():
        raise EnvironmentSetupError(
            f"There is no requirements file {requirements} in the workshop"
        )

    if not kernel:
        raise EnvironmentSetupError("The environment needs a kernel name")

    state_dir = workshop / STATE_DIR
    venv = state_dir / VENV_DIR
    log = state_dir / LOG_FILE
    name = registered_kernel_name(workshop, kernel)

    # Nothing to do when the environment already matches: same
    # requirements, a venv with its python, and the kernel registered
    # when registration is wanted. A venv whose spec has gone, or been
    # pointed elsewhere by another copy of the workshop, only needs its
    # spec back, not a rebuild.
    if not force:
        existing = environment_status(root_dir, workshop_path, kernel)

        if existing.ready and not existing.stale:
            if existing.registered or not register:
                return existing

            # Under the per-copy name, whatever the record held: a record
            # from a release that shared names between copies would
            # otherwise take the shared spec back from the other copy.
            _register_kernel(
                workshop, _venv_python(workshop), name, display_name, log, timeout
            )
            _update_record(workshop, {"registered": True, "kernel": name})

            return environment_status(root_dir, workshop_path, kernel)

    # A rebuild under a new name leaves the old name's spec behind,
    # pointing at the venv about to be replaced; drop it when it is ours.
    previous = str(_read_record(workshop).get("kernel") or "")

    if previous and previous != name and _spec_owned_by(previous, venv):
        _remove_kernelspec(previous)

    state_dir.mkdir(parents=True, exist_ok=True)

    if venv.exists():
        shutil.rmtree(venv)

    with log.open("w", encoding="utf-8") as handle:
        handle.write(f"# Creating {venv}\n")

    # Each step appends to the log so a failure can be diagnosed from the
    # panel, and so a long install shows progress in the file.
    _run([python, "-m", "venv", str(venv)], workshop, log, timeout)

    venv_python = _venv_python(workshop)

    if not venv_python.is_file():
        raise EnvironmentSetupError(
            f"The virtual environment has no python at {venv_python}"
        )

    packages = ["-r", str(requirements_path)]

    if register:
        packages.append("ipykernel")

    _run(
        [
            str(venv_python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            *packages,
        ],
        workshop,
        log,
        timeout,
    )

    if register:
        _register_kernel(workshop, venv_python, name, display_name, log, timeout)

    record = {
        "kernel": name,
        "python": str(venv_python),
        "requirements": requirements,
        "sha256": _digest(requirements_path),
        "registered": register,
        "createdAt": datetime.now(UTC).isoformat(timespec="seconds"),
    }

    (state_dir / RECORD_FILE).write_text(
        json.dumps(record, indent=2) + "\n", encoding="utf-8"
    )

    return environment_status(root_dir, workshop_path, kernel)


def remove_environment(
    root_dir: Path, workshop_path: str, kernel: str
) -> EnvironmentStatus:
    """Unregister the kernel and delete the venv and its record."""

    workshop = _workshop(root_dir, workshop_path)
    record = _read_record(workshop)
    venv = workshop / STATE_DIR / VENV_DIR
    name = str(record.get("kernel") or registered_kernel_name(workshop, kernel))

    # A spec of that name that points at another venv belongs to another
    # copy of the workshop, or to something else entirely, and stays.
    if name and _spec_owned_by(name, venv):
        _remove_kernelspec(name)

    if venv.exists():
        shutil.rmtree(venv)

    for file in (RECORD_FILE, LOG_FILE):
        path = workshop / STATE_DIR / file

        if path.exists():
            path.unlink()

    return environment_status(root_dir, workshop_path, kernel)


def _workshop(root_dir: Path, workshop_path: str) -> Path:
    try:
        return _workshop_dir(root_dir, workshop_path)
    except CheckError as error:
        raise EnvironmentSetupError(str(error)) from error


def _venv_python(workshop: Path) -> Path:
    bin_dir = venv_bin_dir(workshop / STATE_DIR / VENV_DIR)

    return bin_dir / ("python.exe" if sys.platform == "win32" else "python")


def kernel_env(venv: Path) -> dict[str, str]:
    """Environment variables for the environment's kernelspec.

    Every kernel started from it, a notebook's or the hidden workshop
    kernel, then has the environment's programs first on its PATH and
    ``VIRTUAL_ENV`` set, as an activated venv would, so ``!pip`` in a
    notebook and a ``subprocess`` in a check reach the environment rather
    than the server's Python. ``${PATH}`` is filled in by jupyter_client
    when the kernel starts.
    """

    return {
        "VIRTUAL_ENV": str(venv),
        "PATH": f"{venv_bin_dir(venv)}{os.pathsep}${{PATH}}",
    }


def _register_kernel(
    workshop: Path,
    venv_python: Path,
    name: str,
    display_name: str,
    log: Path,
    timeout: float,
) -> None:
    """Register the venv's kernelspec under ``name`` for the user, with
    the environment on its PATH."""

    _run(
        [
            str(venv_python),
            "-m",
            "ipykernel",
            "install",
            "--user",
            "--name",
            name,
            "--display-name",
            display_name or name,
        ],
        workshop,
        log,
        timeout,
    )
    _write_kernel_env(name, kernel_env(workshop / STATE_DIR / VENV_DIR))


def _update_record(workshop: Path, changes: dict[str, Any]) -> None:
    path = workshop / STATE_DIR / RECORD_FILE
    record = {**_read_record(workshop), **changes}

    path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


@dataclass(frozen=True)
class WorkshopKernel:
    """A registered kernelspec whose Python is a workshop environment's."""

    name: str
    display_name: str
    python: str

    #: Whether that Python still exists; a stale spec is one whose venv
    #: has gone, with the workshop removed or moved.
    exists: bool


def list_workshop_kernels() -> list[WorkshopKernel]:
    """Every registered kernelspec that belongs to a workshop environment,
    told by its Python living under a ``_workshop/venv`` directory."""

    from jupyter_client.kernelspec import KernelSpecManager

    kernels: list[WorkshopKernel] = []

    for name, entry in sorted(KernelSpecManager().get_all_specs().items()):
        spec: dict[str, Any] = (
            entry.get("spec") if isinstance(entry, dict) else None
        ) or {}
        argv = spec.get("argv")
        python = str(argv[0]) if isinstance(argv, list) and argv else ""

        if not _is_workshop_venv_python(python):
            continue

        kernels.append(
            WorkshopKernel(
                name=name,
                display_name=str(spec.get("display_name") or name),
                python=python,
                exists=Path(python).exists(),
            )
        )

    return kernels


def prune_workshop_kernels() -> list[WorkshopKernel]:
    """Unregister the workshop kernelspecs whose environment no longer
    exists, and return them. Specs of any other kind are never touched."""

    stale = [kernel for kernel in list_workshop_kernels() if not kernel.exists]

    for kernel in stale:
        _remove_kernelspec(kernel.name)

    return stale


def _is_workshop_venv_python(python: str) -> bool:
    parts = Path(python).parts

    return any(
        parts[index] == STATE_DIR and parts[index + 1] == VENV_DIR
        for index in range(len(parts) - 1)
    )


def _spec_python(name: str) -> Path | None:
    """The Python a registered kernelspec starts, or None when there is
    no such spec or it names none."""

    from jupyter_client.kernelspec import KernelSpecManager

    try:
        spec = KernelSpecManager().get_kernel_spec(name)
    except Exception:
        return None

    argv = list(spec.argv or [])

    return Path(argv[0]) if argv else None


def _spec_owned_by(name: str, venv: Path) -> bool:
    """Whether the kernelspec ``name`` starts a Python inside ``venv``."""

    python = _spec_python(name)

    if python is None:
        return False

    # The venv's python is usually a symlink to the interpreter it was
    # made from, so the file itself is not resolved, only its directory.
    try:
        located = python.parent.resolve() / python.name

        located.relative_to(venv.resolve())
    except (ValueError, OSError):
        return False

    return True


def _write_kernel_env(name: str, env: dict[str, str]) -> None:
    """Add ``env`` to a registered kernelspec's kernel.json."""

    from jupyter_client.kernelspec import KernelSpecManager

    try:
        spec = KernelSpecManager().get_kernel_spec(name)
    except Exception as error:
        raise EnvironmentSetupError(
            f"The kernel {name} was not registered: {error}"
        ) from error

    path = Path(spec.resource_dir) / "kernel.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["env"] = {**data.get("env", {}), **env}

    path.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")


def _run(command: list[str], cwd: Path, log: Path, timeout: float) -> None:
    with log.open("a", encoding="utf-8") as handle:
        handle.write(f"\n$ {' '.join(command)}\n")
        handle.flush()

        try:
            completed = subprocess.run(
                command,
                cwd=cwd,
                stdout=handle,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise EnvironmentSetupError(
                f"{command[0]} did not finish within {timeout:g}s"
            ) from error
        except OSError as error:
            raise EnvironmentSetupError(
                f"Unable to run {command[0]}: {error}"
            ) from error

    if completed.returncode != 0:
        raise EnvironmentSetupError(
            f"{' '.join(command[1:4])} failed with exit code {completed.returncode}; "
            f"see {log.name}:\n{_tail(log)}"
        )


def _read_record(workshop: Path) -> dict[str, Any]:
    path = workshop / STATE_DIR / RECORD_FILE

    if not path.is_file():
        return {}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}

    return data if isinstance(data, dict) else {}


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _tail(path: Path, limit: int = 4000) -> str:
    if not path.is_file():
        return ""

    return path.read_text(encoding="utf-8", errors="replace")[-limit:]


def _remove_kernelspec(name: str) -> None:
    from jupyter_client.kernelspec import KernelSpecManager

    try:
        KernelSpecManager().remove_kernel_spec(name)
    except Exception as error:
        raise EnvironmentSetupError(
            f"Unable to remove the kernel {name}: {error}"
        ) from error
