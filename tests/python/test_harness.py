import io
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

from jupyterlab_workshop.harness import (
    _emit,
    _start_server,
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


def test_declared_workspace_is_read_from_the_manifest(tmp_path: Path) -> None:
    from jupyterlab_workshop.harness import declared_workspace

    (tmp_path / "workshop.yaml").write_text(
        "apiVersion: jupyterlab-workshop/v1alpha1\nname: w\ntitle: W\n"
        "workspace: work/\npages: [a.md]\n"
    )

    assert declared_workspace(tmp_path) == ["work"]

    (tmp_path / "workshop.yaml").write_text(
        "name: w\ntitle: W\nworkspace: learner\npages: [a.md]\n"
    )

    assert declared_workspace(tmp_path) == ["learner"]

    (tmp_path / "workshop.yaml").write_text("name: w\ntitle: W\npages: [a.md]\n")

    assert declared_workspace(tmp_path) == ["work"]
    assert declared_workspace(tmp_path / "missing") == []


def test_start_server_keeps_jupyterlab_state_under_the_work_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The server must not share the user's workspace or settings, whose
    # restored tabs and preferences would change the run, so the flags
    # point at fresh directories under the work directory.

    started: dict[str, Any] = {}

    class FakeProcess:
        pass

    def fake_popen(command: list[str], **kwargs: Any) -> FakeProcess:
        started["command"] = command
        started["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr(subprocess, "Popen", fake_popen)

    root = tmp_path / "root"
    settings = tmp_path / "settings"
    state = tmp_path / "lab"
    log = tmp_path / "jupyterlab.log"
    root.mkdir()
    settings.mkdir()

    _start_server(root, 8888, "token", settings, state, log)

    command = started["command"]
    assert f"--LabApp.app_settings_dir={settings}" in command
    assert f"--LabApp.workspaces_dir={state / 'workspaces'}" in command
    assert f"--LabApp.user_settings_dir={state / 'user-settings'}" in command
    assert (state / "workspaces").is_dir()
    assert (state / "user-settings").is_dir()
    assert started["kwargs"]["cwd"] == root


@pytest.mark.skipif(sys.platform == "win32", reason="O_NONBLOCK is a POSIX flag")
def test_emit_waits_out_a_non_blocking_pipe(monkeypatch: pytest.MonkeyPatch) -> None:
    # Node puts a pipe it inherits into non-blocking mode, and a plain
    # print() to it then fails as soon as the pipe is full. _emit must
    # deliver every byte regardless, retrying while a slow reader drains.

    read_end, write_end = os.pipe()
    os.set_blocking(write_end, False)
    writer = os.fdopen(write_end, "w", encoding="utf-8")
    monkeypatch.setattr(sys, "stdout", writer)

    received = bytearray()

    def drain() -> None:
        os.set_blocking(read_end, True)
        while True:
            chunk = os.read(read_end, 4096)
            if not chunk:
                break
            received.extend(chunk)

    # Well past any pipe buffer, so the writer is forced to wait.
    text = "x" * 300_000

    # A plain print fails outright on the full pipe, which is the bug.
    with pytest.raises(BlockingIOError):
        while True:
            writer.write(text)
            writer.flush()

    reader = threading.Thread(target=drain)
    reader.start()

    try:
        _emit(text)
        _emit("done")
    finally:
        writer.close()
        reader.join()

    assert received.endswith(b"done\n")
    assert received.count(b"x") >= len(text)


def test_emit_writes_plainly_to_a_stream_without_a_descriptor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = io.StringIO()
    monkeypatch.setattr(sys, "stderr", captured)

    _emit("warning: something", error=True)

    assert captured.getvalue() == "warning: something\n"
