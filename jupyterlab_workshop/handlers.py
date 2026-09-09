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

from .analytics import (
    AnalyticsError,
    append_events,
    forward_events,
    identity_from_environment,
)
from .bridge import SETTINGS_KEY as BRIDGE_KEY
from .bridge import Bridge, BridgeError
from .catalog import CatalogError, load_catalog
from .checks import (
    CheckError,
    create_checkpoint,
    list_checkpoints,
    preflight,
    restore_checkpoint,
    run_script,
)
from .collection import CollectionError, list_installed, load_collection
from .environment import (
    EnvironmentSetupError,
    create_environment,
    environment_status,
    remove_environment,
)
from .fetch import FetchError, fetch_workshop, parse_source, remove_workshop
from .platform import current_platform
from .publish import PublishError, publish_workshop
from .scaffold import TEMPLATES, slug, write_scaffold

API_NAMESPACE = "jupyterlab-workshop"

DEFAULT_WORKSHOPS_DIRECTORY = "workshops"


class WorkshopHandler(APIHandler):
    """Shared helpers for the workshop endpoints."""

    @property
    def root_dir(self) -> Path:
        """The directory the server serves files from."""

        return Path(os.path.expanduser(str(self.settings.get("server_root_dir", ""))))

    def under_root(self, path: str, what: str = "path") -> Path:
        """Resolve a path relative to the root, refusing to leave it."""

        root = self.root_dir.resolve()
        resolved = (root / path).resolve()

        if resolved != root and root not in resolved.parents:
            raise tornado.web.HTTPError(
                400, f"The {what} must be inside the JupyterLab root directory"
            )

        return resolved

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
        collection = str(body.get("collection") or "")
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
                    source,
                    self.root_dir,
                    directory,
                    name=name,
                    overwrite=overwrite,
                    collection=collection,
                ),
            )
        except FetchError as error:
            status = 409 if "already exists" in str(error) else 400

            raise tornado.web.HTTPError(status, str(error)) from error

        self.finish(json.dumps(result.to_dict()))


class WorkshopsHandler(WorkshopHandler):
    """List the installed workshops and remove a downloaded one."""

    @tornado.web.authenticated
    def get(self) -> None:
        directory = self.get_argument("directory", DEFAULT_WORKSHOPS_DIRECTORY)

        try:
            records = list_installed(self.root_dir, directory)
        except CollectionError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps({"workshops": records}))

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


class CollectionHandler(WorkshopHandler):
    """Read a collection index from a URL or a file under the root."""

    @tornado.web.authenticated
    async def get(self) -> None:
        location = self.get_argument("url", "")

        if not location:
            raise tornado.web.HTTPError(400, "A url query argument is required")

        try:
            index = await IOLoop.current().run_in_executor(
                None, lambda: load_collection(location, self.root_dir)
            )
        except CollectionError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps({"url": location, "index": index}))


class CatalogHandler(WorkshopHandler):
    """Read a catalog from a URL or a file under the root."""

    @tornado.web.authenticated
    async def get(self) -> None:
        location = self.get_argument("url", "")

        if not location:
            raise tornado.web.HTTPError(400, "A url query argument is required")

        try:
            catalog = await IOLoop.current().run_in_executor(
                None, lambda: load_catalog(location, self.root_dir)
            )
        except CatalogError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps({"url": location, "catalog": catalog}))


class EventsHandler(WorkshopHandler):
    """Record a batch of progress events and forward it to a sink."""

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        workshop = str(body.get("workshop") or "")
        events = body.get("events")
        sink = str(body.get("sink") or "")

        if not isinstance(events, list):
            raise tornado.web.HTTPError(400, "events must be a list")

        # The hub identity is only attached when the frontend asks for it,
        # which it does under the administrator's identity policy.
        if body.get("identity") == "hub":
            user = identity_from_environment()

            for event in events:
                if isinstance(event, dict) and user:
                    event["user"] = user

        try:
            written = append_events(self.root_dir, workshop, events)
        except AnalyticsError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        forwarded = False
        problem = ""

        if sink and written:
            try:
                await IOLoop.current().run_in_executor(
                    None, lambda: forward_events(sink, events)
                )
                forwarded = True
            except AnalyticsError as error:
                problem = str(error)

        self.finish(
            json.dumps({"written": written, "forwarded": forwarded, "problem": problem})
        )


class EnvironmentHandler(WorkshopHandler):
    """Inspect, create and remove a workshop's isolated environment."""

    @tornado.web.authenticated
    def get(self) -> None:
        workshop = self.get_argument("workshop", "")
        kernel = self.get_argument("kernel", "")

        try:
            status = environment_status(self.root_dir, workshop, kernel)
        except EnvironmentSetupError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps(status.to_dict()))

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        workshop = str(body.get("workshop") or "")
        action = str(body.get("action") or "create")
        kernel = str(body.get("kernel") or "")
        requirements = str(body.get("requirements") or "")
        display_name = str(body.get("display") or "")
        force = bool(body.get("force"))

        try:
            if action == "create":
                status = await IOLoop.current().run_in_executor(
                    None,
                    lambda: create_environment(
                        self.root_dir,
                        workshop,
                        requirements,
                        kernel,
                        display_name,
                        force=force,
                    ),
                )
            elif action == "remove":
                status = await IOLoop.current().run_in_executor(
                    None, lambda: remove_environment(self.root_dir, workshop, kernel)
                )
            else:
                raise tornado.web.HTTPError(400, f'Unknown action "{action}"')
        except EnvironmentSetupError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps(status.to_dict()))


class InitHandler(WorkshopHandler):
    """Scaffold a new workshop directory under the root."""

    @tornado.web.authenticated
    def post(self) -> None:
        body = self.body_json()
        directory = str(body.get("directory") or "").strip()

        if not directory:
            raise tornado.web.HTTPError(400, "A directory is required")

        target = self.under_root(directory, "directory")
        name = str(body.get("name") or slug(target.name))
        title = str(body.get("title") or name.replace("-", " ").capitalize())
        template = str(body.get("template") or "starter")

        if template not in TEMPLATES:
            raise tornado.web.HTTPError(400, f'Unknown template "{template}"')

        platforms = _string_list(body.get("platforms"), "platforms")
        capabilities = _string_list(body.get("capabilities"), "capabilities")

        try:
            written = write_scaffold(
                target,
                name,
                title,
                ci=bool(body.get("ci", False)),
                template=template,
                platforms=platforms,
                capabilities=capabilities,
                gating=str(body.get("gating") or "soft"),
            )
        except FileExistsError as error:
            raise tornado.web.HTTPError(409, str(error)) from error
        except ValueError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        root = self.root_dir.resolve()

        self.finish(
            json.dumps(
                {
                    "path": target.relative_to(root).as_posix(),
                    "files": [path.relative_to(root).as_posix() for path in written],
                }
            )
        )


class PublishHandler(WorkshopHandler):
    """Build the archive, hash and collection entry of a workshop."""

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        workshop = str(body.get("workshop") or "")
        directory = self.under_root(workshop, "workshop")

        if not (directory / "workshop.yaml").is_file():
            raise tornado.web.HTTPError(400, f"{workshop} has no workshop.yaml")

        out = self.under_root(str(body.get("out") or f"{workshop}/dist"), "output")
        url = str(body.get("url") or "")

        try:
            result = await IOLoop.current().run_in_executor(
                None, lambda: publish_workshop(directory, out, url)
            )
        except PublishError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps(result.to_dict(relative_to=self.root_dir)))


class BridgeHandler(WorkshopHandler):
    """Run a workshop command in the frontend on behalf of a tool."""

    @property
    def bridge(self) -> Bridge:
        """The bridge created when the extension loaded."""

        bridge = self.settings.get(BRIDGE_KEY)

        if not isinstance(bridge, Bridge):
            raise tornado.web.HTTPError(500, "The workshop bridge is not set up")

        return bridge

    @tornado.web.authenticated
    def get(self) -> None:
        self.finish(json.dumps({"pending": self.bridge.pending()}))

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        command = str(body.get("command") or "")
        args = body.get("args") or {}
        timeout = float(body.get("timeout") or 60)

        if not command:
            raise tornado.web.HTTPError(400, "A command is required")

        if not isinstance(args, dict):
            raise tornado.web.HTTPError(400, "args must be an object")

        try:
            result = await self.bridge.request(command, args, timeout)
        except BridgeError as error:
            status = 504 if "answered" in str(error) else 400

            raise tornado.web.HTTPError(status, str(error)) from error

        self.finish(json.dumps({"result": result}))


class BridgeResultHandler(WorkshopHandler):
    """Receive the frontend's answer to a bridge request."""

    @tornado.web.authenticated
    def post(self) -> None:
        body = self.body_json()
        request_id = str(body.get("request_id") or "")
        error = body.get("error")
        bridge = self.settings.get(BRIDGE_KEY)

        if not request_id or not isinstance(bridge, Bridge):
            raise tornado.web.HTTPError(400, "A request_id is required")

        resolved = bridge.resolve(
            request_id,
            result=body.get("result"),
            error=str(error) if error else None,
        )

        self.finish(json.dumps({"resolved": resolved}))


def _string_list(value: object, field: str) -> list[str] | None:
    if value is None:
        return None

    if not isinstance(value, list) or not all(isinstance(i, str) for i in value):
        raise tornado.web.HTTPError(400, f"{field} must be a list of strings")

    return list(value)


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
        (url_path_join(base_url, API_NAMESPACE, "collection"), CollectionHandler),
        (url_path_join(base_url, API_NAMESPACE, "catalog"), CatalogHandler),
        (url_path_join(base_url, API_NAMESPACE, "events"), EventsHandler),
        (url_path_join(base_url, API_NAMESPACE, "environment"), EnvironmentHandler),
        (url_path_join(base_url, API_NAMESPACE, "init"), InitHandler),
        (url_path_join(base_url, API_NAMESPACE, "publish"), PublishHandler),
        (url_path_join(base_url, API_NAMESPACE, "bridge"), BridgeHandler),
        (
            url_path_join(base_url, API_NAMESPACE, "bridge", "result"),
            BridgeResultHandler,
        ),
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
