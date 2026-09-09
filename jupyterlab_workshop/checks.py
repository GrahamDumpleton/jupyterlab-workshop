"""Server-side support for checks and checkpoints.

Verify scripts run as subprocesses with the workshop directory as their
working directory. Checkpoints are tar archives of the workshop directory,
minus its ``_workshop`` state directory, kept under
``_workshop/checkpoints`` so a learner can return to a known state.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .fetch import FetchError, _resolve_inside, remove_tree

STATE_DIR = "_workshop"

# Not "checkpoints": that name at the end of a contents API path is the
# server's own checkpoints route, which would hide the directory.
CHECKPOINTS_DIR = "snapshots"

MANIFEST_FILE = "workshop.yaml"

MAX_OUTPUT = 20000


class CheckError(Exception):
    """A check or checkpoint request could not be carried out."""


@dataclass(frozen=True)
class ScriptResult:
    """What a verify script produced."""

    code: int
    stdout: str
    stderr: str

    def to_dict(self) -> dict[str, Any]:
        """A JSON friendly form."""

        return asdict(self)


def venv_bin_dir(venv: Path) -> Path:
    """The directory of a virtual environment that holds its programs:
    ``Scripts`` on Windows, ``bin`` elsewhere."""

    return venv / ("Scripts" if sys.platform == "win32" else "bin")


def run_script(
    root_dir: Path,
    workshop_path: str,
    script: str,
    timeout: float = 60.0,
    environment: dict[str, str] | None = None,
) -> ScriptResult:
    """Run a script shipped with the workshop and capture its output.

    The script must live inside the workshop directory. Python files run
    with the server's interpreter; anything else runs directly and so
    needs to be executable, or on Windows have a registered handler.
    """

    workshop = _workshop_dir(root_dir, workshop_path)

    try:
        target = _resolve_inside(workshop, script)
    except FetchError as error:
        raise CheckError(str(error)) from error

    if not target.is_file():
        raise CheckError(f"There is no script {script} in the workshop")

    command = [sys.executable, str(target)] if target.suffix == ".py" else [str(target)]

    env = dict(os.environ)

    if environment:
        env.update(environment)

    # A workshop environment is named by VIRTUAL_ENV, as an activated venv
    # would be; its programs then come first, so a script's `python` or
    # `pytest` is the environment's.
    venv = env.get("VIRTUAL_ENV")

    if venv:
        env["PATH"] = os.pathsep.join(
            [str(venv_bin_dir(Path(venv))), env.get("PATH", "")]
        )

    try:
        completed = subprocess.run(
            command,
            cwd=workshop,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise CheckError(f"{script} did not finish within {timeout:g}s") from error
    except OSError as error:
        raise CheckError(f"Unable to run {script}: {error}") from error

    return ScriptResult(
        code=completed.returncode,
        stdout=completed.stdout[-MAX_OUTPUT:],
        stderr=completed.stderr[-MAX_OUTPUT:],
    )


#: How often, and how long apart, a refused rename is tried again.
REPLACE_ATTEMPTS = 10
REPLACE_DELAY = 0.05


def _replace_with_retries(source: Path, target: Path) -> None:
    """Rename ``source`` over ``target``, trying again when refused.

    On Windows a rename over a file that another writer is replacing at
    the same moment, or that a virus scanner has just opened, fails with
    a permission error that clears within milliseconds, where other
    platforms take the last rename. Two writers of one checkpoint, a
    check's cascade and the click on the same block, are that case, so
    the rename is tried again a few times before the error stands.
    """

    for attempt in range(REPLACE_ATTEMPTS):
        try:
            source.replace(target)
            return
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise

            time.sleep(REPLACE_DELAY * (attempt + 1))


def create_checkpoint(
    root_dir: Path,
    workshop_path: str,
    name: str,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Archive the workshop directory under ``_workshop/snapshots/<name>``.

    The state directory is left out so restoring never clobbers progress.
    Variables passed in are stored next to the archive for the frontend to
    put back on restore.
    """

    workshop = _workshop_dir(root_dir, workshop_path)
    checkpoint_name = _check_name(name)
    directory = workshop / STATE_DIR / CHECKPOINTS_DIR

    directory.mkdir(parents=True, exist_ok=True)

    # The archive is built under a name of its own and renamed into place,
    # so a reader never sees a half-written file, and two writers at once
    # (a check's cascade and a click on the same block) each finish their
    # own file rather than tripping over a shared one.
    archive = directory / f"{checkpoint_name}.tar"
    partial = directory / f"{checkpoint_name}.{uuid.uuid4().hex}.partial"

    try:
        with tarfile.open(partial, "w") as tar:
            for entry in sorted(workshop.iterdir()):
                if entry.name == STATE_DIR:
                    continue

                tar.add(entry, arcname=entry.name)

        _replace_with_retries(partial, archive)
    finally:
        partial.unlink(missing_ok=True)

    record = {
        "name": checkpoint_name,
        "createdAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "variables": variables or {},
    }

    (directory / f"{checkpoint_name}.json").write_text(
        json.dumps(record, indent=2) + "\n", encoding="utf-8"
    )

    return record


def list_checkpoints(root_dir: Path, workshop_path: str) -> list[dict[str, Any]]:
    """The checkpoints a workshop has, oldest first."""

    workshop = _workshop_dir(root_dir, workshop_path)
    directory = workshop / STATE_DIR / CHECKPOINTS_DIR

    if not directory.is_dir():
        return []

    records: list[dict[str, Any]] = []

    for archive in sorted(directory.glob("*.tar")):
        records.append(_read_record(directory, archive.stem))

    records.sort(key=lambda record: str(record.get("createdAt", "")))

    return records


def restore_checkpoint(root_dir: Path, workshop_path: str, name: str) -> dict[str, Any]:
    """Replace the workshop files with those of a checkpoint.

    Everything except the state directory is removed first, so files the
    learner created after the checkpoint disappear too. Returns the
    checkpoint record, including its variables.
    """

    workshop = _workshop_dir(root_dir, workshop_path)
    checkpoint_name = _check_name(name)
    directory = workshop / STATE_DIR / CHECKPOINTS_DIR
    archive = directory / f"{checkpoint_name}.tar"

    if not archive.is_file():
        raise CheckError(f"There is no checkpoint named {name}")

    with tarfile.open(archive) as tar:
        members = tar.getmembers()

        for member in members:
            if not _safe_member(member):
                raise CheckError(
                    f"The checkpoint contains an unsafe path {member.name}"
                )

        for entry in workshop.iterdir():
            if entry.name == STATE_DIR:
                continue

            if entry.is_dir() and not entry.is_symlink():
                remove_tree(entry)
            else:
                entry.unlink()

        tar.extractall(workshop, members=members, filter="data")

    return _read_record(directory, checkpoint_name)


def _workshop_dir(root_dir: Path, workshop_path: str) -> Path:
    try:
        workshop = _resolve_inside(root_dir, workshop_path)
    except FetchError as error:
        raise CheckError(str(error)) from error

    if not (workshop / MANIFEST_FILE).is_file():
        raise CheckError(f"{workshop_path or '.'} is not a workshop directory")

    return workshop


def _check_name(name: str) -> str:
    cleaned = name.strip()

    if not cleaned or any(part in {".", ".."} for part in cleaned.split("/")):
        raise CheckError("A checkpoint needs a name")

    if "/" in cleaned or "\\" in cleaned:
        raise CheckError("A checkpoint name must not contain path separators")

    return cleaned


def _safe_member(member: tarfile.TarInfo) -> bool:
    parts = member.name.replace("\\", "/").split("/")

    if member.name.startswith("/") or any(
        part in {"", "..", "."} for part in parts if part != parts[-1]
    ):
        return False

    if parts[0] == STATE_DIR:
        return False

    return not (member.issym() or member.islnk())


def _read_record(directory: Path, name: str) -> dict[str, Any]:
    record_path = directory / f"{name}.json"

    if record_path.is_file():
        try:
            data = json.loads(record_path.read_text(encoding="utf-8"))

            if isinstance(data, dict):
                data.setdefault("name", name)

                return data
        except ValueError:
            pass

    return {"name": name, "createdAt": "", "variables": {}}


_TOOL_NAME = re.compile(r"^[A-Za-z0-9_.+-]+$")

_VERSION = re.compile(r"(\d+(?:\.\d+)+)")


@dataclass(frozen=True)
class ToolResult:
    """What the preflight found about one required tool."""

    name: str
    found: bool
    satisfied: bool
    optional: bool
    path: str = ""
    version: str = ""
    requirement: str = ""

    def to_dict(self) -> dict[str, Any]:
        """A JSON friendly form."""

        return asdict(self)


def preflight(
    tools: list[dict[str, Any]], check_versions: bool = True
) -> list[ToolResult]:
    """Look for each required tool on the server's path.

    With ``check_versions`` the tool is run with ``--version`` and the first
    dotted number in its output is compared with the requirement, which
    may be ``>=2.30``, ``>2``, ``==3.12`` or a bare minimum version.
    """

    results: list[ToolResult] = []

    for tool in tools:
        name = str(tool.get("name") or "")
        requirement = str(tool.get("version") or "")
        optional = bool(tool.get("optional", False))

        if not _TOOL_NAME.match(name):
            results.append(
                ToolResult(name=name, found=False, satisfied=False, optional=optional)
            )

            continue

        path = shutil.which(name) or ""
        version = _tool_version(path) if path and check_versions else ""
        satisfied = bool(path) and (
            not requirement or not check_versions or _satisfies(version, requirement)
        )

        results.append(
            ToolResult(
                name=name,
                found=bool(path),
                satisfied=satisfied,
                optional=optional,
                path=path,
                version=version,
                requirement=requirement,
            )
        )

    return results


def _tool_version(path: str) -> str:
    try:
        completed = subprocess.run(
            [path, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""

    match = _VERSION.search(completed.stdout) or _VERSION.search(completed.stderr)

    return match.group(1) if match else ""


def _satisfies(version: str, requirement: str) -> bool:
    match = re.match(r"^\s*(>=|<=|==|>|<|=)?\s*(\d+(?:\.\d+)*)\s*$", requirement)

    if not match:
        return True

    if not version:
        return False

    operator = match.group(1) or ">="
    wanted = _version_tuple(match.group(2))
    actual = _version_tuple(version)
    width = max(len(wanted), len(actual))
    wanted += (0,) * (width - len(wanted))
    actual += (0,) * (width - len(actual))

    return {
        ">=": actual >= wanted,
        "<=": actual <= wanted,
        "==": actual == wanted,
        "=": actual == wanted,
        ">": actual > wanted,
        "<": actual < wanted,
    }[operator]


def _version_tuple(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.split("."))
