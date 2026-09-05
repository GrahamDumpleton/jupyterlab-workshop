import os
import stat
from pathlib import Path

import pytest

from jupyterlab_workshop.checks import (
    CheckError,
    create_checkpoint,
    list_checkpoints,
    restore_checkpoint,
    run_script,
)

MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\n"
    "name: demo\ntitle: Demo\npages: [pages/01.md]\n"
)


def make_workshop(root: Path) -> Path:
    workshop = root / "ws"

    (workshop / "pages").mkdir(parents=True)
    (workshop / "workshop.yaml").write_text(MANIFEST)
    (workshop / "pages" / "01.md").write_text("# Page\n")

    return workshop


class TestRunScript:
    def test_runs_python_scripts_in_the_workshop_directory(
        self, tmp_path: Path
    ) -> None:
        workshop = make_workshop(tmp_path)

        (workshop / "verify").mkdir()
        (workshop / "verify" / "check.py").write_text(
            "import os, sys\n"
            "print(os.path.basename(os.getcwd()))\n"
            "print(os.environ.get('WORKSHOP_TRACK', ''))\n"
            "sys.exit(3)\n"
        )

        result = run_script(
            tmp_path, "ws", "verify/check.py", environment={"WORKSHOP_TRACK": "pip"}
        )

        assert result.code == 3
        assert result.stdout.split() == ["ws", "pip"]

    @pytest.mark.skipif(os.name == "nt", reason="needs an executable bit")
    def test_runs_executable_scripts(self, tmp_path: Path) -> None:
        workshop = make_workshop(tmp_path)
        script = workshop / "check.sh"

        script.write_text("#!/bin/sh\necho hi >&2\nexit 0\n")
        script.chmod(script.stat().st_mode | stat.S_IXUSR)

        result = run_script(tmp_path, "ws", "check.sh")

        assert result.code == 0
        assert result.stderr.strip() == "hi"

    def test_refuses_scripts_outside_the_workshop(self, tmp_path: Path) -> None:
        make_workshop(tmp_path)
        (tmp_path / "outside.py").write_text("print('no')\n")

        with pytest.raises(CheckError):
            run_script(tmp_path, "ws", "../outside.py")

        with pytest.raises(CheckError, match="no script"):
            run_script(tmp_path, "ws", "verify/missing.py")

        with pytest.raises(CheckError, match="not a workshop"):
            run_script(tmp_path, "", "outside.py")

    def test_times_out(self, tmp_path: Path) -> None:
        workshop = make_workshop(tmp_path)

        (workshop / "slow.py").write_text("import time\ntime.sleep(5)\n")

        with pytest.raises(CheckError, match="did not finish"):
            run_script(tmp_path, "ws", "slow.py", timeout=0.2)


class TestCheckpoints:
    def test_create_list_and_restore(self, tmp_path: Path) -> None:
        workshop = make_workshop(tmp_path)

        (workshop / "notes.txt").write_text("first\n")
        (workshop / "_workshop").mkdir()
        (workshop / "_workshop" / "state.json").write_text("{}")

        record = create_checkpoint(
            tmp_path, "ws", "start", variables={"repo_dir": "demo"}
        )

        assert record["name"] == "start"
        assert record["variables"] == {"repo_dir": "demo"}
        assert [item["name"] for item in list_checkpoints(tmp_path, "ws")] == ["start"]

        # Change things after the checkpoint, then go back.
        (workshop / "notes.txt").write_text("changed\n")
        (workshop / "extra").mkdir()
        (workshop / "extra" / "file.txt").write_text("x")
        (workshop / "_workshop" / "state.json").write_text('{"kept": true}')

        restored = restore_checkpoint(tmp_path, "ws", "start")

        assert restored["variables"] == {"repo_dir": "demo"}
        assert (workshop / "notes.txt").read_text() == "first\n"
        assert not (workshop / "extra").exists()
        assert (workshop / "_workshop" / "state.json").read_text() == '{"kept": true}'
        assert (workshop / "workshop.yaml").read_text() == MANIFEST

    def test_rejects_bad_names_and_missing_checkpoints(self, tmp_path: Path) -> None:
        make_workshop(tmp_path)

        with pytest.raises(CheckError, match="needs a name"):
            create_checkpoint(tmp_path, "ws", "  ")

        with pytest.raises(CheckError, match="separators"):
            create_checkpoint(tmp_path, "ws", "a/b")

        with pytest.raises(CheckError, match="no checkpoint"):
            restore_checkpoint(tmp_path, "ws", "nothing")

        assert list_checkpoints(tmp_path, "ws") == []


class TestPreflight:
    def test_finds_python_and_reports_missing_tools(self) -> None:
        from jupyterlab_workshop.checks import _satisfies, preflight

        results = preflight(
            [
                {"name": "python3", "version": ">=3.12"},
                {"name": "no-such-tool-here", "optional": True},
                {"name": "bad name; rm"},
            ],
            check_versions=True,
        )

        assert results[0].found is True
        assert results[0].version.startswith("3.")
        assert results[0].satisfied is True
        assert results[1] == type(results[1])(
            name="no-such-tool-here", found=False, satisfied=False, optional=True
        )
        assert results[2].found is False

        assert _satisfies("2.39.1", ">=2.30") is True
        assert _satisfies("2.29", ">=2.30") is False
        assert _satisfies("3.12", "3.12") is True
        assert _satisfies("3.12.0", "==3.12") is True
        assert _satisfies("", ">=1") is False
        assert _satisfies("1.0", "weird") is True
