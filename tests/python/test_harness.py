from pathlib import Path

import pytest

from jupyterlab_workshop.harness import remove_work_directory, timed_out_report


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
