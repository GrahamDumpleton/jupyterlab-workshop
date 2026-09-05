"""Recording and forwarding of progress events.

The frontend batches the events it observes (pages entered, actions run,
checks passed) and posts them to the server, which appends them to
``_workshop/events.jsonl`` in the workshop directory. When the learner
has opted in, or an administrator has configured a sink, the same batch
is forwarded to that URL as JSON lines. Forwarding happens from the
server so that the sink needs no CORS configuration.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .checks import CheckError, _workshop_dir

STATE_DIR = "_workshop"

EVENTS_FILE = "events.jsonl"

USER_AGENT = "jupyterlab-workshop"

MAX_BATCH = 1000


class AnalyticsError(Exception):
    """Events could not be recorded or forwarded."""


def append_events(root_dir: Path, workshop_path: str, events: list[Any]) -> int:
    """Append events to the workshop's events file; return how many."""

    try:
        workshop = _workshop_dir(root_dir, workshop_path)
    except CheckError as error:
        raise AnalyticsError(str(error)) from error

    records = [event for event in events[:MAX_BATCH] if isinstance(event, dict)]

    if not records:
        return 0

    directory = workshop / STATE_DIR

    directory.mkdir(parents=True, exist_ok=True)

    with (directory / EVENTS_FILE).open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")

    return len(records)


def read_events(root_dir: Path, workshop_path: str) -> list[dict[str, Any]]:
    """Every event recorded for a workshop, oldest first."""

    try:
        workshop = _workshop_dir(root_dir, workshop_path)
    except CheckError as error:
        raise AnalyticsError(str(error)) from error

    path = workshop / STATE_DIR / EVENTS_FILE

    if not path.is_file():
        return []

    events: list[dict[str, Any]] = []

    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue

        try:
            record = json.loads(line)
        except ValueError:
            continue

        if isinstance(record, dict):
            events.append(record)

    return events


def forward_events(sink: str, events: list[Any], timeout: float = 15.0) -> int:
    """POST events to a sink as JSON lines; return the HTTP status."""

    scheme = urlsplit(sink).scheme.lower()

    if scheme not in {"http", "https"}:
        raise AnalyticsError(
            f"Refusing to forward events to a {scheme or 'relative'} URL"
        )

    body = "".join(
        json.dumps(event, separators=(",", ":")) + "\n"
        for event in events[:MAX_BATCH]
        if isinstance(event, dict)
    ).encode("utf-8")

    request = Request(
        sink,
        data=body,
        method="POST",
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-ndjson",
        },
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            return int(response.status)
    except HTTPError as error:
        raise AnalyticsError(f"The sink {sink} answered {error.code}") from error
    except (URLError, OSError) as error:
        raise AnalyticsError(f"Unable to reach the sink {sink}: {error}") from error


def identity_from_environment(environ: dict[str, str] | None = None) -> str:
    """The learner identity JupyterHub provides, or an empty string."""

    values = environ if environ is not None else dict(os.environ)

    return values.get("JUPYTERHUB_USER", "")
