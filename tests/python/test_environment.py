import json
import os
from pathlib import Path

import pytest

from jupyterlab_workshop.environment import (
    EnvironmentSetupError,
    create_environment,
    environment_status,
    list_workshop_kernels,
    prune_workshop_kernels,
    registered_kernel_name,
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
    assert status.kernel == registered_kernel_name(tmp_path / "ws", "workshop-demo")
    assert status.kernel.startswith("workshop-demo-")
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
    assert status.venv == str(workshop / "_workshop" / "venv")
    assert Path(status.bin) == Path(status.python).parent
    assert status.stale is False
    assert "-m venv" in (workshop / "_workshop" / "environment.log").read_text()
    assert (workshop / "_workshop" / "environment.json").is_file()

    (workshop / "requirements.txt").write_text("requests\n")

    assert environment_status(tmp_path, "ws", "workshop-demo").stale is True

    removed = remove_environment(tmp_path, "ws", "workshop-demo")

    assert removed.ready is False
    assert not (workshop / "_workshop" / "venv").exists()
    assert not (workshop / "_workshop" / "environment.json").exists()


def test_create_environment_keeps_a_matching_environment(tmp_path: Path) -> None:
    workshop = _workshop(tmp_path)

    create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )

    # A marker inside the venv survives a second create, since the
    # requirements have not changed, and goes when a rebuild is forced.
    marker = workshop / "_workshop" / "venv" / "marker"

    marker.write_text("")

    kept = create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )

    assert kept.ready is True
    assert marker.is_file()

    create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False, force=True
    )

    assert not marker.exists()

    # Changed requirements rebuild without force.
    marker.write_text("")
    (workshop / "requirements.txt").write_text("# changed\n")
    create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )

    assert not marker.exists()


def test_create_environment_checks_its_inputs(tmp_path: Path) -> None:
    _workshop(tmp_path)

    with pytest.raises(EnvironmentSetupError, match="no requirements file"):
        create_environment(tmp_path, "ws", "missing.txt", "k", register=False)

    with pytest.raises(EnvironmentSetupError, match="outside"):
        create_environment(tmp_path, "ws", "../requirements.txt", "k", register=False)

    with pytest.raises(EnvironmentSetupError, match="kernel name"):
        create_environment(tmp_path, "ws", "requirements.txt", "", register=False)


def test_kernel_env_puts_the_environment_first_on_path(tmp_path: Path) -> None:
    from jupyterlab_workshop.checks import venv_bin_dir
    from jupyterlab_workshop.environment import kernel_env

    env = kernel_env(tmp_path / "venv")

    assert env["VIRTUAL_ENV"] == str(tmp_path / "venv")
    assert env["PATH"].startswith(str(venv_bin_dir(tmp_path / "venv")))
    assert env["PATH"].endswith("${PATH}")


def _spec(kernels: Path, name: str, python: Path) -> Path:
    """Register a kernelspec by hand, as ipykernel install would."""

    directory = kernels / name
    directory.mkdir(parents=True)
    (directory / "kernel.json").write_text(
        json.dumps(
            {
                "argv": [str(python), "-m", "ipykernel_launcher"],
                "display_name": name,
                "language": "python",
            }
        )
    )

    return directory


@pytest.fixture
def kernels(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private Jupyter data directory, so the tests' specs are their own."""

    data = tmp_path / "jupyter-data"
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(data))
    monkeypatch.delenv("JUPYTER_PATH", raising=False)

    return data / "kernels"


def test_registered_kernel_name_differs_by_location(tmp_path: Path) -> None:
    first = registered_kernel_name(tmp_path / "a" / "ws", "workshop-demo")
    second = registered_kernel_name(tmp_path / "b" / "ws", "workshop-demo")

    assert first != second
    assert (
        first.startswith("workshop-demo-") and len(first) == len("workshop-demo-") + 8
    )
    assert registered_kernel_name(tmp_path / "a" / "ws", "workshop-demo") == first


def test_registered_means_the_spec_points_into_this_venv(
    tmp_path: Path, kernels: Path
) -> None:
    _workshop(tmp_path)
    status = create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )

    assert status.registered is False

    # A spec of the right name that starts another copy's Python does
    # not count, and is not this workshop's to remove.
    other = tmp_path / "elsewhere" / "_workshop" / "venv" / "bin" / "python"
    _spec(kernels, status.kernel, other)

    assert environment_status(tmp_path, "ws", "workshop-demo").registered is False

    remove_environment(tmp_path, "ws", "workshop-demo")

    assert (kernels / status.kernel).is_dir()

    # One that starts this venv's Python counts, and goes with the venv.
    create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )
    (kernels / status.kernel).rename(kernels / "kept")
    _spec(kernels, status.kernel, Path(status.python))

    assert environment_status(tmp_path, "ws", "workshop-demo").registered is True

    remove_environment(tmp_path, "ws", "workshop-demo")

    assert not (kernels / status.kernel).exists()
    assert (kernels / "kept").is_dir()


def test_a_missing_spec_is_registered_again_without_a_rebuild(
    tmp_path: Path, kernels: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workshop(tmp_path)
    before = create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )
    registered: list[str] = []

    def fake_register(
        workshop: Path, python: Path, name: str, display: str, log: Path, timeout: float
    ) -> None:
        registered.append(name)
        _spec(kernels, name, python)

    monkeypatch.setattr(
        "jupyterlab_workshop.environment._register_kernel", fake_register
    )

    after = create_environment(tmp_path, "ws", "requirements.txt", "workshop-demo")

    assert registered == [before.kernel]
    assert after.registered is True
    assert after.created_at == before.created_at

    # A record from a release that shared one name between copies is
    # moved to the per-copy name, and the shared spec is left alone.
    record = tmp_path / "ws" / "_workshop" / "environment.json"
    data = json.loads(record.read_text())
    data["kernel"] = "workshop-demo"
    record.write_text(json.dumps(data))
    _spec(
        kernels,
        "workshop-demo",
        tmp_path / "other" / "_workshop" / "venv" / "bin" / "python",
    )
    (kernels / before.kernel).rename(kernels / "moved-aside")

    healed = create_environment(tmp_path, "ws", "requirements.txt", "workshop-demo")

    assert healed.kernel == before.kernel
    assert healed.registered is True
    assert registered == [before.kernel, before.kernel]
    assert (kernels / "workshop-demo").is_dir()

    # Registered and matching, a second creation does nothing at all.
    assert create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo"
    ).registered
    assert registered == [before.kernel, before.kernel]


def test_prune_removes_only_stale_workshop_kernels(
    tmp_path: Path, kernels: Path
) -> None:
    _workshop(tmp_path)
    status = create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )
    gone = tmp_path / "gone" / "_workshop" / "venv" / "bin" / "python"

    _spec(kernels, "workshop-live-1234abcd", Path(status.python))
    _spec(kernels, "workshop-gone-1234abcd", gone)
    _spec(kernels, "my-own-kernel", tmp_path / "nowhere" / "bin" / "python")

    listed = {kernel.name: kernel.exists for kernel in list_workshop_kernels()}

    assert listed == {"workshop-live-1234abcd": True, "workshop-gone-1234abcd": False}

    pruned = prune_workshop_kernels()

    assert [kernel.name for kernel in pruned] == ["workshop-gone-1234abcd"]
    assert (kernels / "workshop-live-1234abcd").is_dir()
    assert (kernels / "my-own-kernel").is_dir()
    assert not (kernels / "workshop-gone-1234abcd").exists()
    assert os.environ["JUPYTER_DATA_DIR"] == str(kernels.parent)
