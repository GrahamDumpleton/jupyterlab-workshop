"""Isolated Python environments for workshops.

A manifest may declare ``environment.requirements``. The extension then
offers to create a virtual environment under ``_workshop/venv`` inside the
workshop directory, install the requirements and ``ipykernel`` into it,
and register a kernelspec for it so notebooks and the workshop kernel can
use it. Everything is tracked in ``_workshop/environment.json`` so it can
be reported and removed again.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .checks import CheckError, _workshop_dir
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

    return EnvironmentStatus(
        kernel=str(record.get("kernel") or kernel),
        ready=ready,
        registered=ready and _kernelspec_exists(str(record.get("kernel") or kernel)),
        python=str(python) if ready else "",
        requirements=requirements,
        stale=stale,
        created_at=str(record.get("createdAt") or ""),
        log=_tail(workshop / STATE_DIR / LOG_FILE),
    )


def create_environment(
    root_dir: Path,
    workshop_path: str,
    requirements: str,
    kernel: str,
    display_name: str = "",
    register: bool = True,
    python: str = sys.executable,
    timeout: float = INSTALL_TIMEOUT,
) -> EnvironmentStatus:
    """Create the venv, install the requirements and register the kernel.

    An existing environment is replaced. ``register`` can be turned off to
    build the venv without ``ipykernel`` and a kernelspec, which the tests
    use to stay offline.
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
        _run(
            [
                str(venv_python),
                "-m",
                "ipykernel",
                "install",
                "--user",
                "--name",
                kernel,
                "--display-name",
                display_name or kernel,
            ],
            workshop,
            log,
            timeout,
        )

    record = {
        "kernel": kernel,
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
    name = str(record.get("kernel") or kernel)

    if name and _kernelspec_exists(name):
        _remove_kernelspec(name)

    venv = workshop / STATE_DIR / VENV_DIR

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
    venv = workshop / STATE_DIR / VENV_DIR

    if sys.platform == "win32":
        return venv / "Scripts" / "python.exe"

    return venv / "bin" / "python"


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


def _kernelspec_exists(name: str) -> bool:
    from jupyter_client.kernelspec import KernelSpecManager, NoSuchKernel

    try:
        KernelSpecManager().get_kernel_spec(name)
    except NoSuchKernel:
        return False
    except Exception:
        return False

    return True


def _remove_kernelspec(name: str) -> None:
    from jupyter_client.kernelspec import KernelSpecManager

    try:
        KernelSpecManager().remove_kernel_spec(name)
    except Exception as error:
        raise EnvironmentSetupError(
            f"Unable to remove the kernel {name}: {error}"
        ) from error
