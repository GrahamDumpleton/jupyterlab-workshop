"""The learning journal kept in a workshop library.

A library's owner learns from the workshops in it, and the journal is
the record of that: the ``journal/`` directory at the library root,
written by the extension from what it already sees happen, so it is
useful with no AI configured at all. It holds:

- ``events.jsonl``, an append-only log of what happened, one JSON object
  per line: the progress events worth keeping, copied from the batches
  every workshop posts, and the events the extension makes itself when
  a workshop is installed, updated, removed, created, moved into a
  course or published. Each carries the workshop's path relative to the
  library.

- ``history/<name>.md``, one file per workshop or course the person has
  touched, rewritten from the log whenever something happens to it: the
  facts in its frontmatter, and a body naming the pages reached and the
  dates things happened. Anything written below the marker at the end
  of the generated part is kept, so an agent, or the person, can add to
  a file without losing it on the next rewrite.

- ``profile.md``, the only file an agent writes: who the person is as a
  learner, in their own and the agent's words. Nothing here creates it;
  its absence is how the extension knows the person has not met the
  mentor yet.

- ``settings.yaml``, the record's format version and small settings such
  as whether the welcome has been dismissed.

Facts and interpretations are kept apart: the log and the history files
are the extension's, and nothing else rewrites them; the profile is the
agent's and the person's. A reset moves the directory, or just the
profile, aside to ``journal-archive-<stamp>/`` rather than deleting it.

The journal only exists in a library, found by walking up from a
workshop's directory to the nearest ``library.json``; a workshop in a
plain workshops directory records nothing here. Nothing in it leaves
the machine unless an agent is asked to read it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from .library import LIBRARY_FILE

log = logging.getLogger(__name__)

#: The journal's directory at the library root.
JOURNAL_DIRECTORY = "journal"

#: Where the history files go, under the journal.
HISTORY_DIRECTORY = "history"

#: The append-only log of events, under the journal.
EVENTS_FILE = "events.jsonl"

#: The learner's profile, written by an agent and the person.
PROFILE_FILE = "profile.md"

#: The journal's own settings and format version.
SETTINGS_FILE = "settings.yaml"

#: Where a reset moves the journal, followed by a time stamp.
ARCHIVE_PREFIX = "journal-archive-"

#: The format version written to the settings and every history file.
JOURNAL_VERSION = 1

#: How many history entries a prompt lists in full; the rest are counted.
PROMPT_RECENT = 12

#: The marker ending the generated part of a history file.
HISTORY_MARKER = (
    "<!-- Written by jupyterlab-workshop from the journal's events; what is "
    "above is rewritten, what is below is kept. -->"
)

MANIFEST_FILE = "workshop.yaml"

#: Events the extension makes itself, beside the progress events.
INSTALLED = "workshop-installed"
UPDATED = "workshop-updated"
REMOVED = "workshop-removed"
CREATED = "workshop-created"
COURSE_CREATED = "course-created"
PROMOTED = "workshop-promoted"
PUBLISHED = "workshop-published"

#: The progress event kinds the journal keeps, with the fields of each
#: beyond the base fields. Heartbeats, actions, forms, preflights and
#: environments say nothing about learning worth keeping for years.
KEPT_KINDS: Mapping[str, tuple[str, ...]] = {
    "workshop-start": ("page", "restarted_from"),
    "workshop-resume": ("page", "resumed_from"),
    "workshop-finish": (),
    "workshop-abandon": ("page",),
    "page-enter": ("page",),
    "page-leave": ("page", "active_ms"),
    "gate-skipped": ("page", "requirements"),
    "verify-result": ("id", "status", "attempt"),
    "quiz-answered": ("id", "correct", "attempt"),
    "hint-opened": ("id",),
    "checkpoint-restored": (),
}

#: The fields every kept progress event carries over.
_BASE_FIELDS = (
    "ts",
    "session_id",
    "name",
    "version",
    "collection",
    "collection_id",
    "collection_title",
)

#: The kinds that start a run of the workshop, after which progress is
#: counted afresh.
_RUN_STARTS = frozenset({"workshop-start"})


class JournalError(Exception):
    """The journal could not be read or changed."""


@dataclass(frozen=True)
class Journal:
    """A library's journal, whether or not it exists yet."""

    #: The library the journal belongs to.
    library: Path

    @property
    def directory(self) -> Path:
        """The ``journal/`` directory."""

        return self.library / JOURNAL_DIRECTORY

    @property
    def history(self) -> Path:
        """The directory of history files."""

        return self.directory / HISTORY_DIRECTORY

    @property
    def events_file(self) -> Path:
        """The append-only log."""

        return self.directory / EVENTS_FILE

    @property
    def profile_file(self) -> Path:
        """The learner's profile."""

        return self.directory / PROFILE_FILE

    @property
    def settings_file(self) -> Path:
        """The journal's settings."""

        return self.directory / SETTINGS_FILE

    def exists(self) -> bool:
        """Whether anything has been recorded yet."""

        return self.directory.is_dir()

    def has_profile(self) -> bool:
        """Whether the learner's profile has been written."""

        return self.profile_file.is_file()


@dataclass(frozen=True)
class Located:
    """A directory's place in a library's journal."""

    journal: Journal

    #: The directory's path relative to the library, with forward slashes.
    path: str


def locate(directory: Path) -> Located | None:
    """The journal of the library a directory lies in, or None.

    The library is the nearest parent holding ``library.json``. The
    path is walked as given, not resolved, so a workshop reached through
    a course linked into the library counts as inside it.
    """

    absolute = Path(directory).absolute()

    for parent in absolute.parents:
        if (parent / LIBRARY_FILE).is_file():
            relative = absolute.relative_to(parent).as_posix()

            return Located(Journal(parent), relative)

    return None


def record_events(workshop_dir: Path, events: Iterable[Any]) -> int:
    """Keep the progress events of a batch that the journal wants.

    Returns how many were kept; zero when the workshop is not in a
    library. The workshop's history file is rewritten afterwards.
    """

    located = locate(workshop_dir)

    if located is None:
        return 0

    kept = [
        record
        for event in events
        if isinstance(event, dict) and (record := _kept(event, located.path))
    ]

    if not kept:
        return 0

    _append(located.journal, kept)
    _refresh(located.journal, located.path)

    return len(kept)


def record_install(target: Path, source: str, collection: str, replaced: bool) -> None:
    """Note that a workshop was installed at ``target``, or replaced there."""

    _record_own(
        target,
        UPDATED if replaced else INSTALLED,
        {"source": source, "collection": collection},
    )


def record_removal(target: Path) -> None:
    """Note that the workshop at ``target`` is about to be removed."""

    _record_own(target, REMOVED, {})


def record_creation(directory: Path, kind: str, title: str, summary: str) -> None:
    """Note that Workshop Author created a workshop or a course."""

    _record_own(
        directory,
        COURSE_CREATED if kind == "course" else CREATED,
        {"title": title, "summary": summary},
        read_manifest=kind != "course",
    )


def record_publication(directory: Path, kind: str, url: str) -> None:
    """Note that a workshop or course was published, as a gist or on GitHub."""

    _record_own(directory, PUBLISHED, {"where": kind, "url": url})


def record_promotion(workshop: Path, target: Path) -> None:
    """Note that a workshop moved into a course, carrying its record over.

    The events recorded under the old path are re-keyed to the new one,
    and its history file moves with them, so the record reads as one.
    """

    before = locate(workshop)
    after = locate(target)

    if before is None or after is None or before.journal != after.journal:
        return

    journal = before.journal

    if journal.events_file.is_file():
        lines = journal.events_file.read_text(encoding="utf-8").splitlines()
        rewritten: list[str] = []

        for line in lines:
            record = _parse(line)

            if record is not None and record.get("path") == before.path:
                record["path"] = after.path
                line = json.dumps(record, separators=(",", ":"))

            rewritten.append(line)

        journal.events_file.write_text(
            "".join(f"{line}\n" for line in rewritten), encoding="utf-8"
        )

    old = _existing_history(journal, before.path)

    if old is not None:
        old.unlink()

    _record_own(target, PROMOTED, {"from": before.path})


def read_history(journal: Journal) -> list[dict[str, Any]]:
    """The facts of every history file, most recently active first."""

    if not journal.history.is_dir():
        return []

    records: list[dict[str, Any]] = []

    for file in sorted(journal.history.glob("*.md")):
        facts, _ = _split(file.read_text(encoding="utf-8"))

        if facts.get("path"):
            facts["file"] = file.relative_to(journal.library).as_posix()
            records.append(facts)

    records.sort(key=lambda facts: str(facts.get("last_activity") or ""), reverse=True)

    return records


def read_profile(journal: Journal) -> str | None:
    """The learner's profile, or None when it has not been written."""

    if not journal.has_profile():
        return None

    return journal.profile_file.read_text(encoding="utf-8")


def profile_body(journal: Journal) -> str | None:
    """The profile without its frontmatter, or None when there is none."""

    profile = read_profile(journal)

    if profile is None:
        return None

    _, body = _split(profile)

    return body.strip()


def save_profile(journal: Journal, text: str) -> None:
    """Write the learner's profile whole, the one file an agent writes.

    A frontmatter block with the date and the format version is put in
    front when the text has none, so the file says when it was last
    written.
    """

    _ensure(journal)

    body = text.strip() + "\n"

    if not body.startswith("---\n"):
        head = _yaml({"updated": _now()[:10], "version": JOURNAL_VERSION})
        body = f"---\n{head}---\n\n{body}"

    journal.profile_file.write_text(body, encoding="utf-8")


def ensure_journal(journal: Journal) -> None:
    """Create the journal's directory and settings when they are not there."""

    _ensure(journal)


def render_for_prompt(journal: Journal, recent: int = PROMPT_RECENT) -> str:
    """The journal as an agent's prompt carries it, within a budget.

    The profile as written, then the history condensed to a line per
    workshop or course, the most recently active first, with the older
    ones counted rather than listed.
    """

    parts: list[str] = []
    body = profile_body(journal)

    if body is None:
        parts.append(
            "## Profile\n\nNo profile has been written yet: nothing is known "
            "about the person as a learner beyond the history below."
        )
    else:
        parts.append(f"## Profile\n\n{body}")

    records = read_history(journal)

    if not records:
        parts.append(
            "## History\n\nNothing has been recorded yet: no workshop has been "
            "installed or opened in this library."
        )
    else:
        lines = [
            "## History",
            "",
            f"{len(records)} workshops or courses recorded, the most recently "
            "active first:",
            "",
        ]
        lines += [f"- {_history_line(facts)}" for facts in records[:recent]]

        if len(records) > recent:
            lines.append(
                f"- and {len(records) - recent} more, older; the full journal "
                "lists them."
            )

        parts.append("\n".join(lines))

    return "\n\n".join(parts) + "\n"


def _history_line(facts: Mapping[str, Any]) -> str:
    # One workshop of the history, as the prompt lists it.
    title = facts.get("title") or facts.get("name") or facts.get("path")
    pieces = [f"{title} ({facts.get('path')})", str(facts.get("status") or "")]

    if facts.get("collection_title"):
        pieces.append(f"from {facts['collection_title']}")

    if facts.get("created"):
        pieces.append("made with Workshop Author")

    if "pages_visible" in facts:
        pieces.append(
            f"{facts.get('pages_reached', 0)} of {facts['pages_visible']} pages"
        )

    checks = facts.get("checks")

    if isinstance(checks, dict):
        pieces.append(
            f"checks {checks.get('passed', 0)} passed and {checks.get('failed', 0)} "
            f"failing in {checks.get('attempts', 0)} attempts"
        )

    quizzes = facts.get("quizzes")

    if isinstance(quizzes, dict):
        pieces.append(
            f"quizzes {quizzes.get('correct', 0)} right and {quizzes.get('wrong', 0)} "
            "wrong"
        )

    if facts.get("hints_opened"):
        pieces.append(f"{facts['hints_opened']} hints opened")

    if facts.get("active_minutes"):
        pieces.append(f"{facts['active_minutes']} minutes active")

    if facts.get("finished"):
        pieces.append(f"finished {facts['finished']}")

    pieces.append(f"last active {facts.get('last_activity', '')}")

    return "; ".join(piece for piece in pieces if piece)


def read_settings(journal: Journal) -> dict[str, Any]:
    """The journal's settings; empty when there are none."""

    if not journal.settings_file.is_file():
        return {}

    try:
        data = yaml.safe_load(journal.settings_file.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise JournalError(
            f"{journal.settings_file} cannot be read: {error}"
        ) from error

    return data if isinstance(data, dict) else {}


def write_settings(journal: Journal, settings: Mapping[str, Any]) -> None:
    """Write the journal's settings, keeping the format version."""

    _ensure(journal)

    data = {"version": JOURNAL_VERSION, **settings}

    journal.settings_file.write_text(_yaml(data), encoding="utf-8")


def reset_journal(journal: Journal, profile_only: bool = False) -> Path:
    """Move the journal, or only its profile, aside; return where it went.

    Nothing is deleted: the whole directory, or the profile alone, goes
    to ``journal-archive-<stamp>/`` beside it, so a reset made by
    mistake can be undone by moving it back.
    """

    if not journal.exists():
        raise JournalError(f"{journal.library} has no journal to reset")

    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    archive = journal.library / f"{ARCHIVE_PREFIX}{stamp}"
    counter = 1

    while archive.exists():
        counter += 1
        archive = journal.library / f"{ARCHIVE_PREFIX}{stamp}-{counter}"

    if profile_only:
        if not journal.has_profile():
            raise JournalError(f"{journal.library} has no profile to reset")

        archive.mkdir()
        shutil.move(str(journal.profile_file), str(archive / PROFILE_FILE))
    else:
        shutil.move(str(journal.directory), str(archive))

    return archive


def _kept(event: dict[str, Any], path: str) -> dict[str, Any] | None:
    # A progress event cut down to what the journal keeps of it, or None
    # for a kind it does not keep.
    kind = str(event.get("kind") or "")
    fields = KEPT_KINDS.get(kind)

    if fields is None:
        return None

    record: dict[str, Any] = {
        "kind": kind,
        "ts": event.get("ts") or _now(),
        "path": path,
    }

    for name in _BASE_FIELDS[1:]:
        if name in event:
            record[name] = event[name]

    for name in fields:
        if name in event:
            record[name] = event[name]

    # The pages a start or resume lists carry their directives too, which
    # the journal has no use for.
    pages = event.get("pages")

    if kind in {"workshop-start", "workshop-resume"} and isinstance(pages, list):
        record["pages"] = [
            {"id": str(page.get("id") or ""), "title": str(page.get("title") or "")}
            for page in pages
            if isinstance(page, dict)
        ]

    if kind == "checkpoint-restored":
        record["checkpoint"] = str(event.get("name") or "")

    return record


def _record_own(
    directory: Path, kind: str, fields: Mapping[str, Any], read_manifest: bool = True
) -> None:
    # An event the extension makes itself, about the workshop or course
    # at a directory; nothing happens outside a library.
    located = locate(directory)

    if located is None:
        return

    record: dict[str, Any] = {"kind": kind, "ts": _now(), "path": located.path}

    if read_manifest:
        manifest = _manifest(directory)

        for name in ("name", "title", "version"):
            if manifest.get(name):
                record[name] = str(manifest[name])

    record.update({key: value for key, value in fields.items() if value})

    _append(located.journal, [record])
    _refresh(located.journal, located.path)


def _append(journal: Journal, records: list[dict[str, Any]]) -> None:
    _ensure(journal)

    with journal.events_file.open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")


def _ensure(journal: Journal) -> None:
    # The directory and its settings exist from the first thing recorded.
    journal.history.mkdir(parents=True, exist_ok=True)

    if not journal.settings_file.is_file():
        journal.settings_file.write_text(
            _yaml({"version": JOURNAL_VERSION}), encoding="utf-8"
        )


def _events_for(journal: Journal, path: str) -> list[dict[str, Any]]:
    # The log's events about one path, in order. The path is looked for
    # in the line before it is parsed, since most lines are about others.
    if not journal.events_file.is_file():
        return []

    needle = json.dumps(path)
    events: list[dict[str, Any]] = []

    for line in journal.events_file.read_text(encoding="utf-8").splitlines():
        if needle not in line:
            continue

        record = _parse(line)

        if record is not None and record.get("path") == path:
            events.append(record)

    return events


def _parse(line: str) -> dict[str, Any] | None:
    if not line.strip():
        return None

    try:
        record = json.loads(line)
    except ValueError:
        return None

    return record if isinstance(record, dict) else None


def _refresh(journal: Journal, path: str) -> None:
    # Rewrite the history file of a path from its events, keeping what
    # was added below the marker.
    events = _events_for(journal, path)

    if not events:
        return

    file = _history_file(journal, path)
    kept = ""

    if file.is_file():
        _, body = _split(file.read_text(encoding="utf-8"))
        _, marker, tail = body.partition(HISTORY_MARKER)

        if marker:
            kept = tail.strip("\n")

    manifest = _manifest(journal.library / path)
    facts = summarize(events, manifest)
    facts["path"] = path
    facts["journal"] = JOURNAL_VERSION

    body = _body(facts, events, manifest)
    text = f"---\n{_yaml(facts)}---\n\n{body}\n{HISTORY_MARKER}\n"

    if kept:
        text += f"\n{kept}\n"

    file.write_text(text, encoding="utf-8")


def summarize(
    events: list[dict[str, Any]], manifest: Mapping[str, Any]
) -> dict[str, Any]:
    """The facts of a workshop's record, from its events and its manifest.

    Progress is counted over the current run, from the latest
    ``workshop-start``, since a restart begins again; the dates, the
    sessions and the time spent are counted over everything.
    """

    latest = events[-1]
    facts: dict[str, Any] = {}

    # What it is called comes from the manifest while the workshop is
    # there, else from the last event that said.
    for name in ("title", "name", "version"):
        value = manifest.get(name) or _last(events, name)

        if value:
            facts[name] = str(value)

    for name in ("collection", "collection_id", "collection_title"):
        value = _last(events, name)

        if value:
            facts[name] = str(value)

    # The dates things happened.
    dated = (
        ("installed", {INSTALLED}),
        ("updated", {UPDATED}),
        ("created", {CREATED, COURSE_CREATED}),
        ("first_opened", {"workshop-start"}),
        ("finished", {"workshop-finish"}),
        ("removed", {REMOVED}),
    )

    for name, kinds in dated:
        matching = [event for event in events if event["kind"] in kinds]

        if not matching:
            continue

        chosen = matching[0] if name == "first_opened" else matching[-1]
        facts[name] = _date(chosen)

    facts["last_activity"] = _date(latest)

    # A removal after the last install or creation leaves the record of a
    # workshop that is no longer there.
    present = [
        event
        for event in events
        if event["kind"] in {INSTALLED, UPDATED, CREATED, COURSE_CREATED, REMOVED}
    ]

    if present and present[-1]["kind"] == REMOVED:
        facts["status"] = "removed"
    else:
        facts.pop("removed", None)

    # Progress over the current run.
    starts = [
        index for index, event in enumerate(events) if event["kind"] in _RUN_STARTS
    ]
    run = events[starts[-1] :] if starts else []
    pages = _pages(events)
    reached = {str(event.get("page")) for event in run if event["kind"] == "page-enter"}
    finished_run = any(event["kind"] == "workshop-finish" for event in run)

    if "status" not in facts:
        if finished_run:
            facts["status"] = "finished"
        elif run:
            facts["status"] = "in progress"
        else:
            facts["status"] = "not started"

    if not finished_run:
        facts.pop("finished", None)

    if pages:
        facts["pages_visible"] = len(pages)
        facts["pages_reached"] = sum(1 for page in pages if page["id"] in reached)

    facts["sessions"] = sum(
        1 for event in events if event["kind"] in {"workshop-start", "workshop-resume"}
    )

    active = sum(
        int(event.get("active_ms") or 0)
        for event in events
        if event["kind"] == "page-leave"
    )

    if active:
        facts["active_minutes"] = max(1, round(active / 60000))

    # Checks and quizzes: the last outcome of each check in the run, every
    # answer to a quiz.
    outcomes: dict[str, str] = {}
    attempts = 0

    for event in run:
        if event["kind"] == "verify-result" and event.get("status") != "skipped":
            outcomes[str(event.get("id"))] = str(event.get("status"))
            attempts += 1

    if attempts:
        facts["checks"] = {
            "passed": sum(1 for status in outcomes.values() if status == "ok"),
            "failed": sum(1 for status in outcomes.values() if status == "error"),
            "attempts": attempts,
        }

    answers = [event for event in run if event["kind"] == "quiz-answered"]

    if answers:
        facts["quizzes"] = {
            "correct": sum(1 for event in answers if event.get("correct") is True),
            "wrong": sum(1 for event in answers if event.get("correct") is False),
        }

    counted = (
        ("hints_opened", "hint-opened"),
        ("checkpoints_restored", "checkpoint-restored"),
        ("gates_skipped", "gate-skipped"),
    )

    for name, kind in counted:
        count = sum(1 for event in run if event["kind"] == kind)

        if count:
            facts[name] = count

    published = [event for event in events if event["kind"] == PUBLISHED]

    if published:
        facts["published"] = str(published[-1].get("url") or "")

    return facts


def _body(
    facts: Mapping[str, Any],
    events: list[dict[str, Any]],
    manifest: Mapping[str, Any],
) -> str:
    # The readable part of a history file: what the workshop is about,
    # the pages reached, and the dates things happened.
    lines = [f"# {facts.get('title') or facts.get('name') or facts.get('path')}", ""]
    description = str(manifest.get("description") or "").strip()

    if description:
        lines += [description, ""]

    tags = manifest.get("tags")

    if isinstance(tags, list) and tags:
        lines += ["Tags: " + ", ".join(str(tag) for tag in tags) + ".", ""]

    pages = _pages(events)

    if pages:
        starts = [
            index for index, event in enumerate(events) if event["kind"] in _RUN_STARTS
        ]
        run = events[starts[-1] :] if starts else []
        reached = {
            str(event.get("page")) for event in run if event["kind"] == "page-enter"
        }

        lines += ["## Pages", ""]
        lines += [
            f"- [{'x' if page['id'] in reached else ' '}] {page['title'] or page['id']}"
            for page in pages
        ]
        lines.append("")

    lines += ["## Record", ""]

    for event in events:
        line = _record_line(event)

        if line:
            lines.append(f"- {_date(event)}: {line}")

    lines.append("")

    return "\n".join(lines)


def _record_line(event: dict[str, Any]) -> str:
    # One dated line of the record, or an empty string for an event the
    # record does not list page by page.
    kind = event["kind"]

    if kind == INSTALLED:
        source = event.get("collection_title") or event.get("collection")

        return f"installed from {source}" if source else "installed"

    if kind == UPDATED:
        version = event.get("version")

        return f"updated to version {version}" if version else "updated"

    if kind == REMOVED:
        return "removed"

    if kind == CREATED:
        return _with_summary("created with Workshop Author", event)

    if kind == COURSE_CREATED:
        return _with_summary("course created with Workshop Author", event)

    if kind == PROMOTED:
        return f"moved into a course from {event.get('from')}"

    if kind == PUBLISHED:
        where = "as a gist" if event.get("where") == "gist" else "to GitHub"

        return f"published {where} at {event.get('url')}"

    if kind == "workshop-start":
        return "restarted" if event.get("restarted_from") else "started"

    if kind == "workshop-finish":
        return "finished"

    return ""


def _with_summary(text: str, event: dict[str, Any]) -> str:
    summary = str(event.get("summary") or "").strip()

    return f"{text}: {summary}" if summary else text


def _pages(events: list[dict[str, Any]]) -> list[dict[str, str]]:
    # The visible pages as the latest start or resume listed them.
    for event in reversed(events):
        pages = event.get("pages")

        if isinstance(pages, list):
            return [page for page in pages if isinstance(page, dict)]

    return []


def _last(events: list[dict[str, Any]], name: str) -> Any:
    for event in reversed(events):
        if event.get(name):
            return event[name]

    return None


def _date(event: Mapping[str, Any]) -> str:
    return str(event.get("ts") or "")[:10]


def _history_file(journal: Journal, path: str) -> Path:
    # The history file of a path: the one already about it, else one
    # named after the workshop's directory, with a hash of the path when
    # another workshop of the same name has that file.
    existing = _existing_history(journal, path)

    if existing is not None:
        return existing

    name = path.rsplit("/", 1)[-1]
    plain = journal.history / f"{name}.md"

    if not plain.exists():
        return plain

    digest = hashlib.sha1(path.encode("utf-8")).hexdigest()[:7]

    return journal.history / f"{name}-{digest}.md"


def _existing_history(journal: Journal, path: str) -> Path | None:
    if not journal.history.is_dir():
        return None

    name = path.rsplit("/", 1)[-1]

    for file in sorted(journal.history.glob(f"{name}*.md")):
        facts, _ = _split(file.read_text(encoding="utf-8"))

        if facts.get("path") == path:
            return file

    return None


def _split(text: str) -> tuple[dict[str, Any], str]:
    # A Markdown file's frontmatter as a mapping, and the rest.
    if not text.startswith("---\n"):
        return {}, text

    head, separator, body = text[4:].partition("\n---\n")

    if not separator:
        return {}, text

    try:
        data = yaml.safe_load(head)
    except yaml.YAMLError:
        return {}, text

    return (data if isinstance(data, dict) else {}), body


def _manifest(directory: Path) -> dict[str, Any]:
    # The manifest of a workshop that is still there, read leniently; a
    # course, or a removed workshop, gives nothing.
    try:
        data = yaml.safe_load((directory / MANIFEST_FILE).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return {}

    return data if isinstance(data, dict) else {}


def _yaml(data: Mapping[str, Any]) -> str:
    return str(yaml.safe_dump(dict(data), sort_keys=False, allow_unicode=True))


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
