import json
import subprocess
from pathlib import Path

import pytest

from jupyterlab_workshop import cli
from jupyterlab_workshop.course import CollectionSpec, CourseOptions, write_course
from jupyterlab_workshop.promotion import (
    PromotionError,
    course_collections,
    outline_entry,
    promote_workshop,
)
from jupyterlab_workshop.scaffold import initialize_repository, write_scaffold

MANIFEST = """\
apiVersion: jupyterlab-workshop/v1alpha1
name: git-basics
title: Git basics
description: The first steps with git.
pages:
  - pages/01-start.md
  - pages/02-commit.md
"""


def _workshop(directory: Path) -> Path:
    (directory / "pages").mkdir(parents=True)
    (directory / "workshop.yaml").write_text(MANIFEST)
    (directory / "pages" / "01-start.md").write_text("---\ntitle: Start\n---\n\n# Go\n")
    (directory / "pages" / "02-commit.md").write_text("# Make a commit\n")
    (directory / "_workshop").mkdir()
    (directory / "_workshop" / "gist.json").write_text('{"url": "g"}\n')
    (directory / "_workshop" / "agent.json").write_text("{}\n")
    initialize_repository(directory)

    return directory


def _identity(repository: Path) -> None:
    for key, value in (("user.email", "t@example.org"), ("user.name", "Test")):
        subprocess.run(
            ["git", "-C", str(repository), "config", key, value],
            check=True,
            capture_output=True,
        )


def _course(directory: Path, collections: tuple[CollectionSpec, ...]) -> Path:
    write_course(
        directory,
        CourseOptions(
            name=directory.name,
            title="A course",
            description="Things.",
            collections=collections,
            id_prefix="example.org",
            version="1.2.3",
        ),
    )
    initialize_repository(directory)
    _identity(directory)
    subprocess.run(
        ["git", "-C", str(directory), "add", "."], check=True, capture_output=True
    )
    subprocess.run(
        ["git", "-C", str(directory), "commit", "-q", "-m", "Start"],
        check=True,
        capture_output=True,
    )

    return directory


def test_promote_moves_the_workshop_into_the_course_and_takes_it_in(
    tmp_path: Path,
) -> None:
    workshop = _workshop(tmp_path / "personal" / "workshops" / "git-basics")
    course = _course(
        tmp_path / "personal" / "courses" / "tools",
        (CollectionSpec("basics", "The basics"), CollectionSpec("more", "More")),
    )

    # Two collections, so the one joined has to be named.
    with pytest.raises(PromotionError, match="name the one the workshop joins"):
        promote_workshop(workshop, course)

    with pytest.raises(PromotionError, match="no collection nope"):
        promote_workshop(workshop, course, "nope")

    report = promote_workshop(workshop, course, "basics")
    target = course / "workshops" / "git-basics"

    assert report.target == target
    assert report.collection == "basics"
    assert (report.indexed, report.outlined, report.ordered) == (True, True, True)
    assert report.committed is True

    # The directory moved whole, less its own repository and conversation,
    # keeping its gist record.
    assert not workshop.exists()
    assert (target / "pages" / "02-commit.md").is_file()
    assert (target / "_workshop" / "gist.json").is_file()
    assert not (target / "_workshop" / "agent.json").exists()
    assert not (target / ".git").exists()

    # The index lists it, with the Justfile's address, and the order and
    # the outline name it.
    index = json.loads((course / "collections/basics/collection.json").read_text())

    assert [entry["name"] for entry in index["workshops"]] == ["git-basics"]
    assert index["id"] == "example.org/tools/basics"
    assert index["workshops"][0]["versions"][0]["source"] == {
        "git": "https://github.com/OWNER/tools",
        "ref": "main",
        "subdir": "workshops/git-basics",
    }
    assert 'basics := "git-basics"' in (course / "Justfile").read_text()

    outline = (course / "OUTLINE.md").read_text()
    entry_at = outline.index("### 1. `git-basics`: Git basics")

    assert entry_at > outline.index("### The The basics workshops")
    assert entry_at < outline.index("### Topics the The basics collection leaves out")
    assert "Pages, in order: Start; Make a commit." in outline
    assert "The first steps with git." in outline

    # Committed in the course, with the workshop's files.
    log = subprocess.run(
        ["git", "-C", str(course), "log", "--oneline", "--", "workshops/git-basics"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout

    assert "Add the workshop git-basics" in log
    assert not subprocess.run(
        ["git", "-C", str(course), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    # A second workshop goes after the first in the index and the order.
    second = _workshop(tmp_path / "personal" / "workshops" / "git-more")
    (second / "workshop.yaml").write_text(MANIFEST.replace("git-basics", "git-more"))

    report = promote_workshop(second, course, "basics")
    index = json.loads((course / "collections/basics/collection.json").read_text())

    assert [entry["name"] for entry in index["workshops"]] == [
        "git-basics",
        "git-more",
    ]
    assert 'basics := "git-basics git-more"' in (course / "Justfile").read_text()
    assert "### 2. `git-more`:" in (course / "OUTLINE.md").read_text()

    # The same name twice is refused.
    third = _workshop(tmp_path / "elsewhere" / "git-more")

    with pytest.raises(PromotionError, match="already has a workshop called"):
        promote_workshop(third, course, "basics")


def test_promote_into_a_plain_repository_and_without_an_identity(
    tmp_path: Path,
) -> None:
    # A course that is only a repository with workshops/: nothing to index
    # or outline, and no identity to commit as.
    workshop = _workshop(tmp_path / "git-basics")
    course = tmp_path / "plain"

    (course / "workshops").mkdir(parents=True)
    initialize_repository(course)
    subprocess.run(
        ["git", "-C", str(course), "config", "user.useConfigOnly", "true"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(course), "config", "--unset-all", "user.name"],
        check=False,
        capture_output=True,
    )

    report = promote_workshop(workshop, course)

    assert report.collection is None
    assert (report.indexed, report.outlined, report.ordered) == (False, False, False)
    assert (course / "workshops" / "git-basics" / "workshop.yaml").is_file()

    # Whether the commit happened depends on the machine's git identity;
    # either way the report says.
    if not report.committed:
        assert "git commit failed" in report.commit_note

    # A directory that is not a repository is a plain move.
    other = _workshop(tmp_path / "other")
    plain = tmp_path / "no-git"

    (plain / "workshops").mkdir(parents=True)

    report = promote_workshop(other, plain)

    assert report.committed is False
    assert report.commit_note == "the course is not a git repository"


def test_promote_refuses_what_it_should(tmp_path: Path) -> None:
    workshop = _workshop(tmp_path / "ws")
    course = _course(tmp_path / "course", (CollectionSpec("one", "One"),))

    with pytest.raises(PromotionError, match="not a workshop"):
        promote_workshop(tmp_path / "nothing", course)

    with pytest.raises(PromotionError, match="not a directory"):
        promote_workshop(workshop, tmp_path / "missing")

    with pytest.raises(PromotionError, match="single workshop"):
        promote_workshop(workshop, _workshop(tmp_path / "solo"))

    downloaded = _workshop(tmp_path / "downloaded")

    (downloaded / "_workshop" / "source.json").write_text("{}")

    with pytest.raises(PromotionError, match="not yours to move"):
        promote_workshop(downloaded, course)

    inside = course / "workshops" / "inside"

    _workshop(inside)

    with pytest.raises(PromotionError, match="already inside"):
        promote_workshop(inside, course)


def test_course_collections_follow_the_catalog_or_the_directory(
    tmp_path: Path,
) -> None:
    course = tmp_path / "course"

    write_course(
        course,
        CourseOptions(
            name="course",
            title="Course",
            description="",
            collections=(CollectionSpec("b", "Bee"), CollectionSpec("a", "Ay")),
            id_prefix="x",
        ),
    )

    # The catalog's order, not the alphabet.
    assert course_collections(course) == [
        {"name": "b", "title": "Bee"},
        {"name": "a", "title": "Ay"},
    ]

    (course / "catalog.json").unlink()

    assert [item["name"] for item in course_collections(course)] == ["a", "b"]
    assert course_collections(tmp_path / "none") == []


def test_outline_entry_reads_the_manifest_and_the_pages(tmp_path: Path) -> None:
    workshop = _workshop(tmp_path / "git-basics")
    entry = outline_entry(workshop, 3)

    assert entry.startswith("### 3. `git-basics`: Git basics\n\nThe first steps")
    assert "Pages, in order: Start; Make a commit." in entry
    assert "Promoted from a workshop of its own on" in entry

    # A manifest with nothing to say still gets an entry.
    bare = tmp_path / "bare"

    bare.mkdir()
    (bare / "workshop.yaml").write_text("name: bare\n")

    assert outline_entry(bare, 1).startswith(
        "### 1. `bare`: bare\n\nOne line on the question"
    )


def test_course_promote_command(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    workshop = _workshop(tmp_path / "git-basics")
    course = _course(tmp_path / "course", (CollectionSpec("one", "One"),))

    assert cli.main(["course", "promote", str(workshop), str(course)]) == 0

    out = capsys.readouterr().out

    assert f"moved {workshop} to {course / 'workshops' / 'git-basics'}" in out
    assert "joined the collection one: index, OUTLINE.md, Justfile" in out
    assert "committed in the course" in out

    assert cli.main(["course", "promote", str(workshop), str(course)]) == 2
    assert "not a workshop" in capsys.readouterr().err


def test_scaffolded_workshop_keeps_its_files_through_promotion(tmp_path: Path) -> None:
    # The whole of a scaffolded workshop, pages and files, moves.
    workshop = tmp_path / "starter"

    write_scaffold(workshop, "starter", "Starter", ci=False, template="starter")
    initialize_repository(workshop)

    course = _course(tmp_path / "course", (CollectionSpec("one", "One"),))
    report = promote_workshop(workshop, course)

    assert (report.target / "workshop.yaml").is_file()
    assert sorted(p.name for p in (report.target / "pages").iterdir())
