from pathlib import Path

import pytest

from jupyterlab_workshop.harness import (
    forget_environment,
    remove_work_directory,
    timed_out_report,
)


def test_timed_out_report_keeps_results_and_names_the_running_action() -> None:
    progress = {
        "results": [
            {
                "page": "p1",
                "id": "a",
                "type": "execute",
                "status": "ok",
                "message": "",
                "seconds": 1.0,
            },
            {
                "page": "p1",
                "id": "b",
                "type": "verify",
                "status": "skipped",
                "message": "",
                "seconds": 0,
            },
        ],
        "current": {"page": "p2", "id": "c", "type": "execute", "startedAt": 0},
    }

    report = timed_out_report("demo", progress, 1200.0)

    assert report["workshop"] == "demo"
    assert report["timedOut"] is True
    assert [item["id"] for item in report["results"]] == ["a", "b", "c"]
    assert report["results"][-1]["status"] == "error"
    assert report["results"][-1]["timedOut"] is True
    assert "1200s" in report["results"][-1]["message"]
    assert (report["passed"], report["failed"], report["skipped"]) == (1, 1, 1)


def test_timed_out_report_without_progress_still_fails() -> None:
    report = timed_out_report("demo", None, 60.0)

    assert report["failed"] == 1
    assert report["results"][0]["id"] == "self-test"
    assert "60s" in report["results"][0]["message"]


def test_remove_work_directory_retries_while_the_root_is_held(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # The first two removals fail the way Windows does while a process
    # from the server's tree still holds a file; the third succeeds.
    calls: list[Path] = []
    waits: list[float] = []

    def remover(path: Path) -> None:
        calls.append(path)

        if len(calls) < 3:
            raise PermissionError(32, "being used by another process", str(path))

    assert remove_work_directory(tmp_path, remover, waits.append, delay=0.5)
    assert len(calls) == 3
    assert waits == [0.5, 0.5]
    assert capsys.readouterr().err == ""


def test_remove_work_directory_gives_up_with_a_warning(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def remover(path: Path) -> None:
        raise PermissionError(32, "being used by another process", str(path))

    assert not remove_work_directory(tmp_path, remover, lambda _: None, attempts=3)
    assert "leaving" in capsys.readouterr().err


def test_remove_work_directory_treats_a_missing_root_as_done(tmp_path: Path) -> None:
    def remover(path: Path) -> None:
        raise FileNotFoundError(str(path))

    assert remove_work_directory(tmp_path, remover, lambda _: None)


def test_remove_work_directory_removes_a_real_tree(tmp_path: Path) -> None:
    root = tmp_path / "root"

    (root / "nested").mkdir(parents=True)
    (root / "nested" / "file.txt").write_text("x")

    assert remove_work_directory(root)
    assert not root.exists()


def test_forget_environment_drops_what_a_test_created(tmp_path: Path) -> None:
    from jupyterlab_workshop.environment import create_environment

    workshop = tmp_path / "ws"

    workshop.mkdir()
    (workshop / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: demo\ntitle: Demo\n"
        "capabilities: [install-packages]\n"
        "environment: {requirements: requirements.txt}\npages: [a.md]\n"
    )
    (workshop / "requirements.txt").write_text("# nothing\n")
    create_environment(
        tmp_path, "ws", "requirements.txt", "workshop-demo", register=False
    )

    assert (workshop / "_workshop" / "venv").is_dir()

    # Nothing was registered, so no kernel is reported, but the venv and
    # its record are gone.
    assert forget_environment(tmp_path, "ws") is None
    assert not (workshop / "_workshop" / "venv").exists()
    assert not (workshop / "_workshop" / "environment.json").exists()


def test_forget_environment_leaves_other_workshops_alone(tmp_path: Path) -> None:
    workshop = tmp_path / "plain"

    workshop.mkdir()
    (workshop / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: plain\ntitle: P\n"
        "pages: [a.md]\n"
    )

    assert forget_environment(tmp_path, "plain") is None
    assert forget_environment(tmp_path, "missing") is None
