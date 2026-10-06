"""Where the authoring skill is.

The wheel carries the skill as package data, under `skills/`, so an
installed package always has the skill that matches it; a checkout of
the repository has it at the top level instead.
"""

from __future__ import annotations

from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent

SKILL_NAME = "jupyterlab-workshop-authoring"


def skill_directory() -> Path | None:
    """Where the authoring skill files are, packaged or in a checkout."""

    for candidate in (
        PACKAGE_DIR / "skills" / SKILL_NAME,
        PACKAGE_DIR.parent / "skills" / SKILL_NAME,
    ):
        if (candidate / "SKILL.md").is_file():
            return candidate

    return None
