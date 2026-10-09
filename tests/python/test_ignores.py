"""The shared ignore entries, the scaffolds that render them and the check."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from jupyterlab_workshop.course import CollectionSpec, CourseOptions
from jupyterlab_workshop.course import gitignore as course_gitignore
from jupyterlab_workshop.ignores import (
    check_ignores,
    ignore_entries,
    render_ignores,
    repository_kind,
)
from jupyterlab_workshop.scaffold import gitignore as workshop_gitignore


def _git(directory: Path, *arguments: str) -> None:
    subprocess.run(
        ["git", "-C", str(directory), *arguments], check=True, capture_output=True
    )


def _options(lite: bool = False) -> CourseOptions:
    return CourseOptions(
        name="demo",
        title="Demo",
        description="A demo.",
        collections=(CollectionSpec("basics", "Basics"),),
        id_prefix="example.org",
        lite=lite,
    )


def test_scaffolds_render_the_shared_entries() -> None:
    workshop = workshop_gitignore()

    assert workshop == render_ignores("workshop")
    assert "# Runtime state written by the workshop extension\n_workshop/\n" in workshop
    assert ".claude/\n" in workshop

    # A course lists the JupyterLite site only when it has one.
    course = course_gitignore(_options())
    lite = course_gitignore(_options(lite=True))

    assert course == render_ignores("course")
    assert ".jupyterlite.doit.db" not in course
    assert ".jupyterlite.doit.db" in lite
    assert lite.index("test-results/") < lite.index(".jupyterlite.doit.db")
    assert lite.index(".jupyterlite.doit.db") < lite.index("\nscratch/\n")

    # Every pattern of every entry is in the rendered file once.
    for entry in ignore_entries("course", lite=True):
        for pattern in entry.patterns:
            assert lite.count(f"\n{pattern}\n") == 1


def test_check_asks_git_and_fix_appends_what_is_missing(tmp_path: Path) -> None:
    workshop = tmp_path / "demo"

    workshop.mkdir()
    (workshop / "workshop.yaml").write_text("name: demo\n")
    _git(workshop, "init", "-q")

    # A pattern written another way counts: _workshop without its slash.
    (workshop / ".gitignore").write_text("_workshop\nwork/\n")

    report = check_ignores(workshop)
    missing = [pattern for pattern, _ in report.missing]

    assert report.kind == "workshop"
    assert report.note == ""
    assert missing == ["dist/", "scratch/", ".ipynb_checkpoints/", ".claude/"]
    assert report.added == []
    assert dict(report.missing)[".claude/"].startswith("Claude Code's local state")

    fixed = check_ignores(workshop, fix=True)

    assert fixed.added == missing

    text = (workshop / ".gitignore").read_text()

    assert text.startswith("_workshop\nwork/\n\n# Published archives\ndist/\n")
    assert text.endswith(".claude/\n")
    assert check_ignores(workshop).missing == []
    assert check_ignores(workshop).to_dict()["missing"] == []

    # The report is what the tool and the command show.
    assert report.to_dict()["missing"][0] == {
        "pattern": "dist/",
        "why": "Published archives",
    }


def test_check_reads_the_file_outside_a_repository(tmp_path: Path) -> None:
    course = tmp_path / "course"

    (course / "lite").mkdir(parents=True)
    (course / "OUTLINE.md").write_text("# Outline\n")

    report = check_ignores(course)
    missing = [pattern for pattern, _ in report.missing]

    assert repository_kind(course) == "course"
    assert "not a git repository" in report.note
    assert ".workshop/" in missing
    assert "workshops/*/_workshop/" in missing
    assert ".jupyterlite.doit.db" in missing

    # A fix writes the whole file where there was none.
    fixed = check_ignores(course, fix=True)

    assert (course / ".gitignore").read_text() == render_ignores("course", lite=True)
    assert len(fixed.added) == len(missing)
    assert check_ignores(course).missing == []


def test_check_refuses_a_directory_that_is_neither(tmp_path: Path) -> None:
    assert repository_kind(tmp_path) is None

    with pytest.raises(ValueError, match="neither a workshop nor a course"):
        check_ignores(tmp_path)

    # Told the kind, it checks anyway.
    assert check_ignores(tmp_path, kind="workshop").kind == "workshop"
