"""HTTP handlers exposed by the workshop server extension."""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import tornado
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado.ioloop import IOLoop

from .checks import (
    CheckError,
    create_checkpoint,
    list_checkpoints,
    preflight,
    restore_checkpoint,
    run_script,
)
from .fetch import FetchError, fetch_workshop, parse_source, remove_workshop
from .platform import current_platform

API_NAMESPACE = "educates-workshop"

DEFAULT_WORKSHOPS_DIRECTORY = "workshops"


class WorkshopHandler(APIHandler):
    """Shared helpers for the workshop endpoints."""

    @property
    def root_dir(self) -> Path:
        """The directory the server serves files from."""

        return Path(os.path.expanduser(str(self.settings.get("server_root_dir", ""))))

    def body_json(self) -> dict[str, Any]:
        """The request body as a mapping, or an empty mapping."""

        if not self.request.body:
            return {}

        try:
            data = json.loads(self.request.body)
        except ValueError as error:
            raise tornado.web.HTTPError(400, f"Invalid JSON body: {error}") from error

        if not isinstance(data, dict):
            raise tornado.web.HTTPError(400, "The request body must be an object")

        return data


class PlatformHandler(WorkshopHandler):
    """Report the operating system, shell and directories of the server."""

    @tornado.web.authenticated
    def get(self) -> None:
        info = current_platform(
            shell_command=_configured_shell_command(self.settings),
            root_dir=str(self.root_dir),
        )

        self.finish(json.dumps(info.to_dict()))


class FetchHandler(WorkshopHandler):
    """Download a workshop from a git forge or archive URL into the root."""

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        directory = str(body.get("directory") or DEFAULT_WORKSHOPS_DIRECTORY)
        name = str(body.get("name") or "")
        overwrite = bool(body.get("overwrite", False))

        try:
            source = parse_source(body.get("source") or {})
        except FetchError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        # Downloading and unpacking block, so keep them off the event loop.
        try:
            result = await IOLoop.current().run_in_executor(
                None,
                lambda: fetch_workshop(
                    source, self.root_dir, directory, name=name, overwrite=overwrite
                ),
            )
        except FetchError as error:
            status = 409 if "already exists" in str(error) else 400

            raise tornado.web.HTTPError(status, str(error)) from error

        self.finish(json.dumps(result.to_dict()))


class WorkshopsHandler(WorkshopHandler):
    """Remove a downloaded workshop directory."""

    @tornado.web.authenticated
    def delete(self) -> None:
        path = self.get_argument("path", "")

        if not path:
            raise tornado.web.HTTPError(400, "A path query argument is required")

        try:
            removed = remove_workshop(self.root_dir, path)
        except FetchError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps({"removed": removed}))


class VerifyHandler(WorkshopHandler):
    """Run a verify script shipped with a workshop."""

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        workshop = str(body.get("workshop") or "")
        script = str(body.get("script") or "")
        timeout = float(body.get("timeout") or 60)
        environment = body.get("environment")

        if not script:
            raise tornado.web.HTTPError(400, "A script is required")

        if environment is not None and not isinstance(environment, dict):
            raise tornado.web.HTTPError(400, "environment must be an object")

        try:
            result = await IOLoop.current().run_in_executor(
                None,
                lambda: run_script(
                    self.root_dir,
                    workshop,
                    script,
                    timeout=timeout,
                    environment={
                        str(key): str(value)
                        for key, value in (environment or {}).items()
                    },
                ),
            )
        except CheckError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps(result.to_dict()))


class CheckpointsHandler(WorkshopHandler):
    """List, create and restore checkpoints of a workshop."""

    @tornado.web.authenticated
    def get(self) -> None:
        workshop = self.get_argument("workshop", "")

        try:
            records = list_checkpoints(self.root_dir, workshop)
        except CheckError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps({"checkpoints": records}))

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        workshop = str(body.get("workshop") or "")
        name = str(body.get("name") or "")
        action = str(body.get("action") or "create")
        variables = body.get("variables")

        if variables is not None and not isinstance(variables, dict):
            raise tornado.web.HTTPError(400, "variables must be an object")

        try:
            if action == "create":
                record = await IOLoop.current().run_in_executor(
                    None,
                    lambda: create_checkpoint(
                        self.root_dir, workshop, name, variables=variables
                    ),
                )
            elif action == "restore":
                record = await IOLoop.current().run_in_executor(
                    None, lambda: restore_checkpoint(self.root_dir, workshop, name)
                )
            else:
                raise tornado.web.HTTPError(400, f'Unknown action "{action}"')
        except CheckError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps(record))


class PreflightHandler(WorkshopHandler):
    """Report which tools a workshop requires are installed."""

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        tools = body.get("tools")
        check_versions = bool(body.get("versions", True))

        if not isinstance(tools, list) or not all(isinstance(t, dict) for t in tools):
            raise tornado.web.HTTPError(400, "tools must be a list of objects")

        results = await IOLoop.current().run_in_executor(
            None, lambda: preflight(tools, check_versions=check_versions)
        )

        self.finish(json.dumps({"tools": [result.to_dict() for result in results]}))


def setup_handlers(server_app: Any) -> None:
    """Add the extension's handlers to the server's web application."""

    web_app = server_app.web_app
    base_url = web_app.settings["base_url"]

    handlers = [
        (url_path_join(base_url, API_NAMESPACE, "platform"), PlatformHandler),
        (url_path_join(base_url, API_NAMESPACE, "fetch"), FetchHandler),
        (url_path_join(base_url, API_NAMESPACE, "workshops"), WorkshopsHandler),
        (url_path_join(base_url, API_NAMESPACE, "verify"), VerifyHandler),
        (url_path_join(base_url, API_NAMESPACE, "checkpoints"), CheckpointsHandler),
        (url_path_join(base_url, API_NAMESPACE, "preflight"), PreflightHandler),
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
