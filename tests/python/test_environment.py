from pathlib import Path

import pytest

from jupyterlab_workshop.environment import (
    EnvironmentSetupError,
    create_environment,
    environment_status,
    remove_environment,
)

MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\nname: demo\ntitle: Demo\npages: [a.md]\n"
)


def _workshop(root: Path) -> Path:
    workshop = root / "ws"

    workshop.mkdir()
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (workshop / "requirements.txt").write_text("# nothing to install\n")

    return workshop


def test_status_before_creation_is_not_ready(tmp_path: Path) -> None:
    _workshop(tmp_path)

    status = environment_status(tmp_path, "ws", "workshop-demo")

    assert status.ready is False
    assert status.kernel == "workshop-demo"
    assert status.to_dict()["createdAt"] == ""

    with pytest.raises(EnvironmentSetupError, match="not a workshop"):
        environment_status(tmp_path, "nope", "k")


def test_create_environment_builds_a_venv_and_tracks_requirements(
    tmp_path: Path,
) -> None:
    workshop = _workshop(tmp_path)

    # Registration is off so the test needs neither ipykernel nor the
    # package index; the venv itself is real.
    status = create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )

    assert status.ready is True
    assert status.registered is False
    assert Path(status.python).is_file()
    assert status.stale is False
    assert "-m venv" in (workshop / "_workshop" / "environment.log").read_text()
    assert (workshop / "_workshop" / "environment.json").is_file()

    (workshop / "requirements.txt").write_text("requests\n")

    assert environment_status(tmp_path, "ws", "workshop-demo").stale is True

    removed = remove_environment(tmp_path, "ws", "workshop-demo")

    assert removed.ready is False
    assert not (workshop / "_workshop" / "venv").exists()
    assert not (workshop / "_workshop" / "environment.json").exists()


def test_create_environment_checks_its_inputs(tmp_path: Path) -> None:
    _workshop(tmp_path)

    with pytest.raises(EnvironmentSetupError, match="no requirements file"):
        create_environment(tmp_path, "ws", "missing.txt", "k", register=False)

    with pytest.raises(EnvironmentSetupError, match="outside"):
        create_environment(tmp_path, "ws", "../requirements.txt", "k", register=False)

    with pytest.raises(EnvironmentSetupError, match="kernel name"):
        create_environment(tmp_path, "ws", "requirements.txt", "", register=False)
