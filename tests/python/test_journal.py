import json
from pathlib import Path
from typing import Any

import pytest
import yaml

from jupyterlab_workshop.fetch import remove_workshop
from jupyterlab_workshop.journal import (
    HISTORY_MARKER,
    Journal,
    JournalError,
    locate,
    profile_body,
    read_history,
    read_profile,
    read_settings,
    record_creation,
    record_events,
    record_install,
    record_promotion,
    record_publication,
    render_for_prompt,
    reset_journal,
    save_profile,
    write_settings,
)

MANIFEST = (
    "apiVersion: jupyterlab-workshop/v1alpha1\n"
    "name: {name}\ntitle: {title}\nversion: '2'\n"
    "description: Two pages about {name}.\ntags: [python, basics]\n"
    "pages: [pages/01.md, pages/02.md]\n"
)

PAGES = [
    {"id": "01", "path": "pages/01.md", "title": "Start", "directives": []},
    {"id": "02", "path": "pages/02.md", "title": "Finish", "directives": []},
]


def event(kind: str, ts: str, **fields: Any) -> dict[str, Any]:
    """A progress event with the base fields a workshop sends."""

    return {
        "kind": kind,
        "ts": ts,
        "session_id": "s1",
        "instance_id": "i1",
        "workshop": "installed/collections/py-abc1234/intro",
        "name": "intro",
        "version": "2",
        "source": "archive:https://h/intro.tgz",
        "collection": "https://h/collection.json",
        "collection_id": "py",
        "collection_title": "Python workshops",
        "seq": 1,
        "labels": {},
        "frontend": "jupyterlab",
        "frontend_version": "0.28.0",
        "host": "local",
        "platform": "linux",
        "trust": "trusted",
        **fields,
    }


def write_library(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "library.json").write_text('{"version": 2}\n')


def write_workshop(directory: Path, name: str, title: str) -> None:
    directory.mkdir(parents=True)
    (directory / "workshop.yaml").write_text(MANIFEST.format(name=name, title=title))


def frontmatter(file: Path) -> dict[str, Any]:
    text = file.read_text()
    head = text[4:].partition("\n---\n")[0]
    data = yaml.safe_load(head)

    assert isinstance(data, dict)

    return data


def test_locate_finds_the_nearest_library_and_nothing_outside_one(
    tmp_path: Path,
) -> None:
    write_library(tmp_path / "lib")

    inside = tmp_path / "lib" / "installed" / "collections" / "py-abc1234" / "intro"
    located = locate(inside)

    assert located is not None
    assert located.journal.library == tmp_path / "lib"
    assert located.path == "installed/collections/py-abc1234/intro"
    assert located.journal.directory == tmp_path / "lib" / "journal"
    assert not located.journal.exists()

    assert locate(tmp_path / "elsewhere" / "intro") is None

    # A plain workshops directory has no registry and so no journal.
    assert (
        record_events(tmp_path / "elsewhere" / "intro", [event("page-enter", "x")]) == 0
    )
    assert not (tmp_path / "journal").exists()


def test_events_are_kept_cut_down_and_the_history_file_rewritten(
    tmp_path: Path,
) -> None:
    write_library(tmp_path)

    workshop = tmp_path / "installed" / "collections" / "py-abc1234" / "intro"

    write_workshop(workshop, "intro", "Python intro")

    first = [
        event("workshop-start", "2026-10-10T09:00:00Z", page="01", pages=PAGES),
        event("page-enter", "2026-10-10T09:00:01Z", page="01"),
        event("heartbeat", "2026-10-10T09:01:00Z", page="01", hidden=False),
        event(
            "action-executed",
            "2026-10-10T09:01:10Z",
            id="a1",
            type="execute",
            status="ok",
            trigger="click",
            downgraded=False,
        ),
        event(
            "verify-result",
            "2026-10-10T09:02:00Z",
            id="c1",
            status="error",
            attempt=1,
            trigger="click",
        ),
        event(
            "verify-result",
            "2026-10-10T09:03:00Z",
            id="c1",
            status="ok",
            attempt=2,
            trigger="click",
        ),
        event("hint-opened", "2026-10-10T09:03:30Z", id="h1"),
        event("form-submitted", "2026-10-10T09:03:40Z", id="f1", fields=["email"]),
        event("page-leave", "2026-10-10T09:04:00Z", page="01", active_ms=240000),
        event("workshop-abandon", "2026-10-10T09:04:00Z", page="01"),
        "not an event",
    ]

    assert record_events(workshop, first) == 7

    journal = Journal(tmp_path)
    lines = journal.events_file.read_text().splitlines()

    assert len(lines) == 7
    assert read_settings(journal) == {"version": 1}

    # Each kept event names the workshop by its library path and keeps
    # only the fields the journal uses; the pages lose their directives.
    start = json.loads(lines[0])

    assert start["path"] == "installed/collections/py-abc1234/intro"
    assert start["pages"] == [
        {"id": "01", "title": "Start"},
        {"id": "02", "title": "Finish"},
    ]
    assert start["collection_title"] == "Python workshops"
    assert "instance_id" not in start and "labels" not in start

    assert [json.loads(line)["kind"] for line in lines] == [
        "workshop-start",
        "page-enter",
        "verify-result",
        "verify-result",
        "hint-opened",
        "page-leave",
        "workshop-abandon",
    ]

    history = journal.history / "intro.md"
    facts = frontmatter(history)

    assert facts["title"] == "Python intro"
    assert facts["path"] == "installed/collections/py-abc1234/intro"
    assert facts["collection_id"] == "py"
    assert facts["status"] == "in progress"
    assert facts["first_opened"] == "2026-10-10"
    assert facts["last_activity"] == "2026-10-10"
    assert facts["pages_visible"] == 2
    assert facts["pages_reached"] == 1
    assert facts["sessions"] == 1
    assert facts["active_minutes"] == 4
    assert facts["checks"] == {"passed": 1, "failed": 0, "attempts": 2}
    assert facts["hints_opened"] == 1
    assert "finished" not in facts and "quizzes" not in facts

    body = history.read_text()

    assert "# Python intro\n\nTwo pages about intro.\n\nTags: python, basics." in body
    assert "- [x] Start\n- [ ] Finish" in body
    assert "- 2026-10-10: started" in body
    assert body.rstrip().endswith(HISTORY_MARKER)

    # What is written below the marker survives the next rewrite, and a
    # resume, a quiz and a finish bring the facts up to date.
    history.write_text(body + "\n## Notes\n\nThe agent's remarks.\n")

    second = [
        event("workshop-resume", "2026-10-11T09:00:00Z", page="01", pages=PAGES),
        event("page-enter", "2026-10-11T09:00:01Z", page="02"),
        event(
            "quiz-answered", "2026-10-11T09:01:00Z", id="q1", correct=False, attempt=1
        ),
        event(
            "quiz-answered", "2026-10-11T09:01:30Z", id="q1", correct=True, attempt=2
        ),
        event("workshop-finish", "2026-10-11T09:02:00Z", pages=2),
    ]

    assert record_events(workshop, second) == 5

    facts = frontmatter(history)

    assert facts["status"] == "finished"
    assert facts["finished"] == "2026-10-11"
    assert facts["last_activity"] == "2026-10-11"
    assert facts["pages_reached"] == 2
    assert facts["sessions"] == 2
    assert facts["quizzes"] == {"correct": 1, "wrong": 1}

    body = history.read_text()

    assert "- 2026-10-11: finished" in body
    assert body.endswith(f"{HISTORY_MARKER}\n\n## Notes\n\nThe agent's remarks.\n")

    # A restart counts progress afresh while the dates and sessions keep
    # counting.
    third = [
        event(
            "workshop-start",
            "2026-10-12T09:00:00Z",
            page="01",
            pages=PAGES,
            restarted_from="s2",
        ),
        event("page-enter", "2026-10-12T09:00:01Z", page="01"),
    ]

    assert record_events(workshop, third) == 2

    facts = frontmatter(history)

    assert facts["status"] == "in progress"
    assert "finished" not in facts
    assert facts["pages_reached"] == 1
    assert facts["sessions"] == 3
    assert "checks" not in facts and "quizzes" not in facts
    assert "- 2026-10-12: restarted" in history.read_text()

    records = read_history(journal)

    assert [record["path"] for record in records] == [
        "installed/collections/py-abc1234/intro"
    ]
    assert records[0]["file"] == "journal/history/intro.md"


def test_two_workshops_of_one_name_get_separate_history_files(tmp_path: Path) -> None:
    write_library(tmp_path)

    first = tmp_path / "installed" / "collections" / "py-abc1234" / "intro"
    second = tmp_path / "personal" / "workshops" / "intro"

    write_workshop(first, "intro", "Their intro")
    write_workshop(second, "intro", "My intro")

    record_events(first, [event("workshop-start", "2026-10-10T09:00:00Z", pages=PAGES)])
    record_events(
        second, [event("workshop-start", "2026-10-10T10:00:00Z", pages=PAGES)]
    )
    record_events(first, [event("page-enter", "2026-10-10T10:30:00Z", page="01")])

    journal = Journal(tmp_path)
    files = sorted(file.name for file in journal.history.glob("*.md"))
    hashed = [name for name in files if name != "intro.md"]

    assert len(files) == 2
    assert "intro.md" in files
    assert hashed[0].startswith("intro-") and hashed[0].endswith(".md")

    by_path = {record["path"]: record for record in read_history(journal)}

    assert by_path["installed/collections/py-abc1234/intro"]["title"] == "Their intro"
    assert by_path["installed/collections/py-abc1234/intro"]["pages_reached"] == 1
    assert by_path["personal/workshops/intro"]["title"] == "My intro"
    assert by_path["personal/workshops/intro"]["pages_reached"] == 0


def test_installs_removals_and_publications_are_noted(tmp_path: Path) -> None:
    write_library(tmp_path)

    workshop = tmp_path / "installed" / "collections" / "py-abc1234" / "intro"

    write_workshop(workshop, "intro", "Python intro")
    record_install(workshop, "https://h/intro.tgz", "https://h/collection.json", False)

    journal = Journal(tmp_path)
    history = journal.history / "intro.md"
    facts = frontmatter(history)

    assert facts["status"] == "not started"
    assert facts["installed"] == facts["last_activity"]
    assert facts["title"] == "Python intro"
    assert facts["version"] == "2"
    assert "installed from https://h/collection.json" in history.read_text()

    record_events(
        workshop, [event("workshop-start", "2026-10-10T09:00:00Z", pages=PAGES)]
    )
    record_install(workshop, "https://h/intro.tgz", "https://h/collection.json", True)

    facts = frontmatter(history)

    assert facts["updated"] == facts["last_activity"]
    assert "updated to version 2" in history.read_text()

    record_publication(workshop, "gist", "https://gist.github.com/x/1")

    facts = frontmatter(history)

    assert facts["published"] == "https://gist.github.com/x/1"
    assert "published as a gist at https://gist.github.com/x/1" in history.read_text()

    # Removing through the shared code notes the removal first, while the
    # manifest is there, and the history outlives the workshop.
    remove_workshop(tmp_path, "installed/collections/py-abc1234/intro")

    assert not workshop.exists()

    facts = frontmatter(history)

    assert facts["status"] == "removed"
    assert facts["removed"] == facts["last_activity"]
    assert facts["title"] == "Python intro"
    assert "- [ ] Start" in history.read_text()
    assert history.read_text().rstrip().endswith("removed\n\n" + HISTORY_MARKER)


def test_a_creation_and_a_promotion_carry_the_record_to_the_new_path(
    tmp_path: Path,
) -> None:
    write_library(tmp_path)

    workshop = tmp_path / "personal" / "workshops" / "loops"

    write_workshop(workshop, "loops", "Loops")
    record_creation(workshop, "workshop", "Loops", "Two pages on for loops.")

    journal = Journal(tmp_path)
    old = journal.history / "loops.md"

    assert frontmatter(old)["created"] == frontmatter(old)["last_activity"]
    assert "created with Workshop Author: Two pages on for loops." in old.read_text()

    record_events(
        workshop, [event("workshop-start", "2026-10-10T09:00:00Z", pages=PAGES)]
    )

    # A course is noted from what was proposed, since it has no manifest.
    course = tmp_path / "personal" / "courses" / "python"

    (course / "workshops").mkdir(parents=True)
    record_creation(course, "course", "Python course", "A course in parts.")

    assert frontmatter(journal.history / "python.md")["title"] == "Python course"
    assert (
        "course created with Workshop Author: A course in parts."
        in (journal.history / "python.md").read_text()
    )

    # Moving the workshop into the course re-keys its events and moves
    # its history file, so the record reads on under the new path.
    target = course / "workshops" / "loops"

    workshop.rename(target)
    record_promotion(workshop, target)

    # The file keeps the workshop's name, there being no other loops, and
    # is now about the new path.
    moved = journal.history / "loops.md"
    facts = frontmatter(moved)

    assert sorted(file.name for file in journal.history.glob("*.md")) == [
        "loops.md",
        "python.md",
    ]

    assert facts["path"] == "personal/courses/python/workshops/loops"
    assert facts["first_opened"] == "2026-10-10"
    assert facts["sessions"] == 1
    assert "created" in facts
    assert "moved into a course from personal/workshops/loops" in moved.read_text()

    paths = {
        json.loads(line)["path"]
        for line in journal.events_file.read_text().splitlines()
    }

    assert paths == {
        "personal/courses/python/workshops/loops",
        "personal/courses/python",
    }


def test_the_profile_is_saved_whole_and_the_prompt_is_kept_short(
    tmp_path: Path,
) -> None:
    write_library(tmp_path)

    journal = Journal(tmp_path)
    text = render_for_prompt(journal)

    assert "No profile has been written" in text
    assert "Nothing has been recorded" in text

    # A profile written without frontmatter gets the date; one with it
    # is kept as given.
    save_profile(journal, "# Me\n\nI know Python.")

    assert journal.profile_file.read_text().startswith("---\nupdated: ")
    assert profile_body(journal) == "# Me\n\nI know Python."

    save_profile(journal, "---\nupdated: 2026-01-01\n---\n\nKept as given.\n")

    assert (
        journal.profile_file.read_text()
        == "---\nupdated: 2026-01-01\n---\n\nKept as given.\n"
    )

    # The history is one line per workshop, the most recent first, and
    # older ones are counted rather than listed.
    for number in range(14):
        name = f"w{number:02d}"
        workshop = tmp_path / "personal" / "workshops" / name

        write_workshop(workshop, name, f"Workshop {number}")
        record_events(
            workshop,
            [
                event(
                    "workshop-start",
                    f"2026-10-{number + 1:02d}T09:00:00Z",
                    pages=PAGES,
                ),
                event("page-enter", f"2026-10-{number + 1:02d}T09:00:01Z", page="01"),
            ],
        )

    text = render_for_prompt(journal)

    assert "## Profile\n\nKept as given." in text
    assert "14 workshops or courses recorded" in text
    assert (
        "- Workshop 13 (personal/workshops/w13); in progress; from Python "
        "workshops; 1 of 2 pages; last active 2026-10-14" in text
    )
    assert "Workshop 0 " not in text
    assert "and 2 more, older" in text


def test_settings_profile_and_reset(tmp_path: Path) -> None:
    write_library(tmp_path)

    journal = Journal(tmp_path)

    with pytest.raises(JournalError, match="no journal to reset"):
        reset_journal(journal)

    write_settings(journal, {"welcome_dismissed": True})

    assert read_settings(journal) == {"version": 1, "welcome_dismissed": True}
    assert read_profile(journal) is None
    assert journal.exists() and not journal.has_profile()

    with pytest.raises(JournalError, match="no profile to reset"):
        reset_journal(journal, profile_only=True)

    journal.profile_file.write_text("# Me\n\nI like short pages.\n")

    assert read_profile(journal) == "# Me\n\nI like short pages.\n"

    # Resetting the profile keeps the rest; resetting everything moves the
    # directory whole; nothing is deleted.
    archive = reset_journal(journal, profile_only=True)

    assert archive.parent == tmp_path and archive.name.startswith("journal-archive-")
    assert (archive / "profile.md").read_text().startswith("# Me")
    assert not journal.has_profile()
    assert journal.settings_file.is_file()

    whole = reset_journal(journal)

    assert whole != archive
    assert (whole / "settings.yaml").is_file()
    assert not journal.exists()
