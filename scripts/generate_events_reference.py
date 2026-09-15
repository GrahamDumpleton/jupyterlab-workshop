"""Generate the progress events reference page for the docs from its schema.

Run by `just docs` alongside the manifest reference; the output is
written to docs/reference/events.md, which is not committed. The events
schema describes one event: the base fields every event carries, and
under definitions/kinds the extra fields of each kind.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from generate_manifest_reference import render_properties

ROOT = Path(__file__).resolve().parent.parent

SCHEMA = ROOT / "packages" / "core" / "src" / "schema" / "events.schema.json"

OUTPUT = ROOT / "docs" / "reference" / "events.md"


def main() -> int:
    """Write the reference page."""

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    definitions: dict[str, Any] = schema.get("definitions", {})
    kinds: dict[str, Any] = definitions.get("kinds", {})
    lines = [
        "# Events reference",
        "",
        "Generated from the JSON schema for the progress events a workshop",
        "reports. The schema itself is printed by `jupyter workshop schema",
        "--events` and published beside the manifest schema; [Progress",
        "events](../analytics.md) explains how the events are recorded and",
        "reported.",
        "",
        str(schema.get("description", "")),
        "",
        "## Base fields",
        "",
        "Every event carries these, whatever its kind.",
        "",
    ]

    render_properties(
        schema["properties"], list(schema.get("required", [])), definitions, 2, lines
    )

    lines += ["", "## Kinds", ""]

    for kind, spec in kinds.items():
        lines += [f"### `{kind}`", ""]

        if spec.get("description"):
            lines += [str(spec["description"]), ""]

        properties = spec.get("properties", {})

        if properties:
            render_properties(
                properties, list(spec.get("required", [])), definitions, 3, lines
            )
        else:
            lines.append("No extra fields.")

        lines.append("")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
