"""HTTP handlers exposed by the workshop server extension."""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from typing import Any

import tornado
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

from .platform import current_platform

API_NAMESPACE = "educates-workshop"


class PlatformHandler(APIHandler):
    """Report the operating system, shell and directories of the server."""

    @tornado.web.authenticated
    def get(self) -> None:
        info = current_platform(
            shell_command=_configured_shell_command(self.settings),
            root_dir=os.path.expanduser(str(self.settings.get("server_root_dir", ""))),
        )

        self.finish(json.dumps(info.to_dict()))


def setup_handlers(server_app: Any) -> None:
    """Add the extension's handlers to the server's web application."""

    web_app = server_app.web_app
    base_url = web_app.settings["base_url"]

    handlers = [
        (url_path_join(base_url, API_NAMESPACE, "platform"), PlatformHandler),
    ]

    web_app.add_handlers(".*$", handlers)


def _configured_shell_command(settings: dict[str, Any]) -> Sequence[str] | None:
    # The terminal manager is registered by jupyter_server_terminals and
    # carries the shell command it was configured with, when present.
    terminal_manager = settings.get("terminal_manager")
    shell_command = getattr(terminal_manager, "shell_command", None)

    if isinstance(shell_command, (list, tuple)) and shell_command:
        return [str(part) for part in shell_command]

    return None
