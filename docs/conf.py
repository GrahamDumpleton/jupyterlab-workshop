"""Sphinx configuration for the jupyterlab-workshop documentation.

The pages are MyST-flavoured Markdown under docs/. The manifest reference
is generated from the JSON schema at the start of every build so that it
never goes stale.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT / "scripts"))

import generate_manifest_reference  # noqa: E402

generate_manifest_reference.main()

project = "jupyterlab-workshop"
author = "Graham Dumpleton"
copyright = "2026, Graham Dumpleton"
release = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]

extensions = ["myst_parser"]

source_suffix = {".md": "markdown"}
exclude_patterns = ["_build"]

myst_heading_anchors = 3

# The PDF that Read the Docs builds from the LaTeX output; see
# .readthedocs.yaml. One document, A4, with the manifest reference and the
# rest of the pages in the toctree order.
latex_documents = [
    (
        "index",
        "jupyterlab-workshop.tex",
        "jupyterlab-workshop documentation",
        author,
        "manual",
    )
]
latex_elements = {
    "papersize": "a4paper",
    "pointsize": "10pt",
}

html_theme = "furo"
html_title = "jupyterlab-workshop"
html_theme_options = {
    "source_repository": "https://github.com/GrahamDumpleton/jupyterlab-workshop",
    "source_branch": "main",
    "source_directory": "docs/",
}
