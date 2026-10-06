"""JupyterLab server extension for guided interactive workshops."""

from __future__ import annotations

from typing import Any

try:
    from ._version import __version__
except ImportError:
    # The version file is generated when the package is built or installed.
    __version__ = "dev"

from .bridge import setup_bridge
from .handlers import setup_conversations, setup_handlers


def _jupyter_labextension_paths() -> list[dict[str, str]]:
    """Tell JupyterLab where the prebuilt frontend extension lives."""

    return [{"src": "labextension", "dest": "@jupyterlab-workshop/labextension"}]


def _jupyter_server_extension_points() -> list[dict[str, Any]]:
    """Declare this package as a Jupyter Server extension.

    The functions below do the work; the lifecycle application is there
    for the stop hook a function does not get.
    """

    from .lifecycle import WorkshopLifecycle

    return [
        {"module": "jupyterlab_workshop"},
        {"module": "jupyterlab_workshop", "app": WorkshopLifecycle},
    ]


def _load_jupyter_server_extension(server_app: Any) -> None:
    """Register the HTTP handlers that the frontend extension talks to."""

    bridge = setup_bridge(server_app)

    setup_conversations(server_app, bridge)
    setup_handlers(server_app)
    server_app.log.info("Registered jupyterlab_workshop server extension")


__all__ = ["__version__"]
