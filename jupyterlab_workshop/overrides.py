"""Settings overrides the CLI writes for a JupyterLab it starts or builds.

``jupyter workshop launch``, ``lite`` and ``test`` each give JupyterLab an
``overrides.json`` of their own. Those are deliberate workshop runs, so
they also turn off JupyterLab's question about fetching Jupyter news,
which would otherwise be the first thing shown, ahead of the welcome
message or the workshop browser. An override is a default, not a user
setting: someone who has already answered the question in their own
settings keeps their answer, and only the unanswered state is replaced.
A deployment that reaches JupyterLab some other way, such as Binder or a
dev container, writes the same block into its own overrides.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: JupyterLab's own notification plugin, whose settings hold the prompt.
NOTIFICATION_PLUGIN = "@jupyterlab/apputils-extension:notification"

#: The setting behind the prompt: ``"true"`` always fetches, ``"false"``
#: never does, and the default ``"none"`` asks until answered. It is a
#: string in the schema, so the value written is the string.
NEWS_SETTING = "fetchNews"


def quiet_news(overrides: Mapping[str, Any]) -> dict[str, Any]:
    """A copy of ``overrides`` with the Jupyter news prompt turned off,
    unless the notification plugin's block already says what to do."""

    result: dict[str, Any] = dict(overrides)
    block = result.get(NOTIFICATION_PLUGIN)
    notification: dict[str, Any] = dict(block) if isinstance(block, Mapping) else {}

    if NEWS_SETTING not in notification:
        notification[NEWS_SETTING] = "false"

    result[NOTIFICATION_PLUGIN] = notification

    return result
