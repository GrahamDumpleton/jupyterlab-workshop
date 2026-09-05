"""Generate the manifest reference page for the docs from the JSON schema.

Run by `just docs`; the output is written to docs/reference/manifest.md,
which is not committed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent

SCHEMA = ROOT / "packages" / "core" / "src" / "schema" / "workshop.schema.json"

OUTPUT = ROOT / "docs" / "reference" / "manifest.md"


def type_of(prop: dict[str, Any], definitions: dict[str, Any]) -> str:
    """A short description of a property's type."""

    if "$ref" in prop:
        name = str(prop["$ref"]).split("/")[-1]
        target = definitions.get(name, {})

        return type_of(target, definitions)

    if "const" in prop:
        return f"`{prop['const']}`"

    if "enum" in prop:
        return ", ".join(f"`{value}`" for value in prop["enum"])

    if "oneOf" in prop:
        return " or ".join(type_of(item, definitions) for item in prop["oneOf"])

    kind = prop.get("type", "any")

    if isinstance(kind, list):
        return " or ".join(str(item) for item in kind)

    if kind == "array":
        items = prop.get("items", {})

        return f"list of {type_of(items, definitions)}" if items else "list"

    if kind == "object":
        return "mapping"

    return str(kind)


def render_properties(
    properties: dict[str, Any],
    required: list[str],
    definitions: dict[str, Any],
    depth: int,
    lines: list[str],
) -> None:
    """Append a table of properties, then sections for nested objects."""

    lines.append("| Field | Type | Required | Description |")
    lines.append("| --- | --- | --- | --- |")

    nested: list[tuple[str, dict[str, Any]]] = []

    for name, prop in properties.items():
        description = str(prop.get("description", "")).replace("|", "\\|")
        default = prop.get("default")

        if default not in (None, [], {}):
            description = f"{description} Default `{json.dumps(default)}`.".strip()

        lines.append(
            f"| `{name}` | {type_of(prop, definitions)} | "
            f"{'yes' if name in required else 'no'} | {description} |"
        )

        inner = nested_object(prop)

        if inner is not None:
            nested.append((name, inner))

    for name, inner in nested:
        lines.append("")
        lines.append(f"{'#' * (depth + 1)} `{name}` entries")
        lines.append("")

        if inner.get("description"):
            lines.append(str(inner["description"]))
            lines.append("")

        render_properties(
            inner.get("properties", {}),
            list(inner.get("required", [])),
            definitions,
            depth + 1,
            lines,
        )


def nested_object(prop: dict[str, Any]) -> dict[str, Any] | None:
    """The object schema inside a property, for arrays of objects or objects."""

    if prop.get("type") == "array":
        items = prop.get("items", {})

        return items if isinstance(items, dict) and "properties" in items else None

    if prop.get("type") == "object":
        if "properties" in prop:
            return prop

        extra = prop.get("additionalProperties")

        return extra if isinstance(extra, dict) and "properties" in extra else None

    return None


def main() -> int:
    """Write the reference page."""

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    definitions = schema.get("definitions", {})
    lines = [
        "# Manifest reference",
        "",
        "Generated from the JSON schema for `workshop.yaml`. The schema itself",
        "is printed by `jupyter workshop schema`.",
        "",
        str(schema.get("description", "")),
        "",
        "## Fields",
        "",
    ]

    render_properties(
        schema["properties"], list(schema.get("required", [])), definitions, 2, lines
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
