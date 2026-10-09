"""HTTP handlers exposed by the workshop server extension."""

from __future__ import annotations

import asyncio
import json
import os
import posixpath
from collections.abc import Coroutine, Sequence
from pathlib import Path
from typing import Any

import tornado
from jupyter_core.utils import ensure_async
from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import websocket
from tornado.ioloop import IOLoop

from .analytics import (
    AnalyticsError,
    append_events,
    forward_events,
    identity_from_environment,
)
from .attachments import MESSAGE_LIMIT, AttachmentError, parse_attachments
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
from .collection import (
    CollectionError,
    list_courses,
    list_installed,
    load_collection,
)
from .conversations import (
    CLEAR_COMMANDS,
    Conversation,
    ConversationError,
    ConversationManager,
)
from .environment import (
    EnvironmentSetupError,
    create_environment,
    environment_status,
    remove_environment,
)
from .fetch import (
    FetchError,
    _resolve_inside,
    fetch_workshop,
    parse_source,
    remove_workshop,
)
from .library import (
    COURSES_DIRECTORY,
    DEFAULT_COURSE_WORKSHOPS,
    PERSONAL_WORKSHOPS_DIRECTORY,
    LibraryError,
    course_of_path,
    is_own_library_path,
    linked_course_path,
    plan_upgrade,
    read_library,
    unlink_course,
    upgrade_library,
)
from .platform import current_platform, has_web_proxy
from .promotion import PromotionError, promote_workshop
from .publish import PublishError, publish_workshop
from .scaffold import TEMPLATES, initialize_repository, slug, write_scaffold

API_NAMESPACE = "jupyterlab-workshop"

DEFAULT_WORKSHOPS_DIRECTORY = "workshops"


def under_root(root_dir: Path, path: str, what: str = "path") -> Path:
    """Resolve a path relative to the root, refusing to leave it."""

    root = root_dir.resolve()
    resolved = (root / path).resolve()

    if resolved == root or root in resolved.parents:
        return resolved

    # A course a workshop library links in from elsewhere counts as
    # inside, when the library's registry vouches for the link.
    parts = [part for part in path.replace("\\", "/").split("/") if part]
    linked = None if ".." in parts else linked_course_path(root, parts)

    if linked is None:
        raise tornado.web.HTTPError(
            400, f"The {what} must be inside the JupyterLab root directory"
        )

    return linked


class WorkshopHandler(APIHandler):
    """Shared helpers for the workshop endpoints."""

    @property
    def root_dir(self) -> Path:
        """The directory the server serves files from."""

        return Path(os.path.expanduser(str(self.settings.get("server_root_dir", ""))))

    def under_root(self, path: str, what: str = "path") -> Path:
        """Resolve a path relative to the root, refusing to leave it."""

        return under_root(self.root_dir, path, what)

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
        # The web proxy is another server extension, so it is the server's
        # extension manager, not the process, that knows whether it loaded.
        serverapp = self.serverapp
        extensions = serverapp.extension_manager.extensions if serverapp else {}

        info = current_platform(
            shell_command=_configured_shell_command(self.settings),
            root_dir=str(self.root_dir),
            web_proxy=has_web_proxy(extensions),
        )

        # Whether an AI agent is installed, so the browser knows whether to
        # offer Workshop Author without asking again. Not a workshop
        # variable: it says what the server has, not where it runs.
        manager = self.settings.get(CONVERSATIONS_KEY)
        agent = isinstance(manager, ConversationManager) and agent_installed(manager)

        self.finish(json.dumps({**info.to_dict(), "agent": agent}))


class FetchHandler(WorkshopHandler):
    """Download a workshop from a git forge or archive URL into the root."""

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()

        # Only a missing directory takes the default: an empty one, or
        # ".", is the root itself, where a workshop library may live.
        raw_directory = body.get("directory")
        directory = (
            DEFAULT_WORKSHOPS_DIRECTORY if raw_directory is None else str(raw_directory)
        )

        name = str(body.get("name") or "")
        collection = str(body.get("collection") or "")
        overwrite = bool(body.get("overwrite", False))
        standalone = bool(body.get("standalone", False))

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
                    standalone=standalone,
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


class CoursesHandler(WorkshopHandler):
    """List a workshop library's courses, unlink a linked one, and promote
    a workshop into one.

    Unlinking has to happen here rather than through the contents API:
    deleting a linked directory there could reach the files it links to,
    and a link whose target has gone is not listed there at all.
    """

    @tornado.web.authenticated
    async def post(self) -> None:
        """Move one of the owner's workshops into one of their courses."""

        data = self.body_json()
        directory = str(data.get("directory") or DEFAULT_WORKSHOPS_DIRECTORY)
        workshop = str(data.get("workshop") or "").strip().strip("/")
        course = str(data.get("course") or "").strip().strip("/")
        collection = str(data.get("collection") or "") or None

        if not workshop or not course:
            raise tornado.web.HTTPError(400, "workshop and course are required")

        # The workshop is the owner's own, standing alone; the course is
        # one of theirs, named by its root.
        if not is_own_library_path(directory, workshop) or course_of_path(
            directory, workshop
        ):
            raise tornado.web.HTTPError(
                400,
                f"{workshop} is not one of your own workshops under "
                f"{PERSONAL_WORKSHOPS_DIRECTORY}/",
            )

        placed = course_of_path(directory, course)

        if placed is None or placed[1]:
            raise tornado.web.HTTPError(
                400, f"{course} is not a course under {COURSES_DIRECTORY}/"
            )

        workshop_dir = self.under_root(workshop, "workshop")
        course_dir = self.under_root(course, "course")

        try:
            report = promote_workshop(workshop_dir, course_dir, collection)
        except PromotionError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        # The workshop's conversation, if one is open, hands on to the
        # course's, with the workshop named as the place to carry on.
        inside = f"{DEFAULT_COURSE_WORKSHOPS}/{report.target.name}"
        manager = self.settings.get(CONVERSATIONS_KEY)

        if isinstance(manager, ConversationManager):
            await manager.moved(workshop, course, inside)

        self.finish(
            json.dumps({**report.to_dict(), "path": posixpath.join(course, inside)})
        )

    @tornado.web.authenticated
    def get(self) -> None:
        directory = self.get_argument("directory", DEFAULT_WORKSHOPS_DIRECTORY)

        try:
            courses = list_courses(self.root_dir, directory)
        except CollectionError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps({"courses": courses}))

    @tornado.web.authenticated
    def delete(self) -> None:
        directory = self.get_argument("directory", DEFAULT_WORKSHOPS_DIRECTORY)
        name = self.get_argument("name", "")

        if not name:
            raise tornado.web.HTTPError(400, "A name query argument is required")

        try:
            library_dir = _resolve_inside(self.root_dir, directory)
            removed = unlink_course(library_dir, name)
        except (FetchError, LibraryError) as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps({"unlinked": removed}))


class LibraryHandler(WorkshopHandler):
    """Report a workshop library's registry version and upgrade its layout.

    A library made by an earlier release keeps its workshops in the
    previous layout. The browser reads the registry itself, so this
    handler is only for the upgrade, which moves directories the browser
    could not move safely through the contents API, links among them.
    """

    @tornado.web.authenticated
    def get(self) -> None:
        directory = self.get_argument("directory", DEFAULT_WORKSHOPS_DIRECTORY)

        try:
            _resolve_inside(self.root_dir, directory)

            registry = read_library(self.root_dir, directory)
            plan = plan_upgrade(self.root_dir, directory)
        except (FetchError, LibraryError) as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        if registry is None:
            raise tornado.web.HTTPError(404, f"{directory} is not a workshop library")

        self.finish(
            json.dumps(
                {
                    "version": registry.get("version"),
                    "upgrade": None if plan is None else plan.to_dict(),
                }
            )
        )

    @tornado.web.authenticated
    def post(self) -> None:
        body = self.body_json()
        raw_directory = body.get("directory")
        directory = (
            DEFAULT_WORKSHOPS_DIRECTORY if raw_directory is None else str(raw_directory)
        )

        try:
            _resolve_inside(self.root_dir, directory)

            plan = upgrade_library(self.root_dir, directory)
        except (FetchError, LibraryError) as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        self.finish(json.dumps({"upgraded": plan.to_dict()}))


class VerifyHandler(WorkshopHandler):
    """Run a verify script shipped with a workshop."""

    @tornado.web.authenticated
    async def post(self) -> None:
        body = self.body_json()
        workshop = str(body.get("workshop") or "")
        script = str(body.get("script") or "")
        timeout = float(body.get("timeout") or 60)
        environment = body.get("environment")
        cwd = body.get("cwd")

        if not script:
            raise tornado.web.HTTPError(400, "A script is required")

        if environment is not None and not isinstance(environment, dict):
            raise tornado.web.HTTPError(400, "environment must be an object")

        if cwd is not None and not isinstance(cwd, str):
            raise tornado.web.HTTPError(400, "cwd must be a string")

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
                    cwd=cwd or None,
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
        subdir = body.get("subdir")

        if variables is not None and not isinstance(variables, dict):
            raise tornado.web.HTTPError(400, "variables must be an object")

        if subdir is not None and not isinstance(subdir, str):
            raise tornado.web.HTTPError(400, "subdir must be a string")

        try:
            if action == "create":
                record = await IOLoop.current().run_in_executor(
                    None,
                    lambda: create_checkpoint(
                        self.root_dir,
                        workshop,
                        name,
                        variables=variables,
                        subdir=subdir or None,
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
        token = str(body.get("token") or "")

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
                    None, lambda: forward_events(sink, events, token=token)
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
        frontends = _string_list(body.get("frontends"), "frontends")
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
                frontends=frontends,
            )
        except FileExistsError as error:
            raise tornado.web.HTTPError(409, str(error)) from error
        except ValueError as error:
            raise tornado.web.HTTPError(400, str(error)) from error

        # A workshop of one's own starts as a repository, unless it is
        # being added to one, so its history begins with it.
        repository = bool(body.get("git", True)) and initialize_repository(target)

        root = self.root_dir.resolve()

        self.finish(
            json.dumps(
                {
                    "path": target.relative_to(root).as_posix(),
                    "files": [path.relative_to(root).as_posix() for path in written],
                    "git": repository,
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
        target = str(body.get("target") or "") or None

        if not command:
            raise tornado.web.HTTPError(400, "A command is required")

        if not isinstance(args, dict):
            raise tornado.web.HTTPError(400, "args must be an object")

        try:
            result = await self.bridge.request(command, args, timeout, target)
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


# Where the server keeps its conversation manager.
CONVERSATIONS_KEY = "jupyterlab_workshop_conversations"

# Turns in progress, held so they are not collected while they run.
_TURNS: set[asyncio.Future[None]] = set()


def agent_installed(manager: ConversationManager) -> bool:
    """Whether the conversation manager's provider can run here."""

    try:
        return manager.provider.available()
    except Exception:
        return False


class AgentStatusHandler(WorkshopHandler):
    """Report whether Workshop Author can run, and how it is logged in."""

    @tornado.web.authenticated
    async def get(self) -> None:
        manager = self.settings.get(CONVERSATIONS_KEY)

        if not isinstance(manager, ConversationManager):
            raise tornado.web.HTTPError(500, "Conversations are not set up")

        status = await manager.provider.status()

        self.finish(json.dumps({**status.to_dict(), "login": manager.login_command()}))


class ConversationHandler(JupyterHandler, websocket.WebSocketHandler):
    """A websocket carrying one workshop's or course's conversation with
    the agent.

    The first message opens the conversation, naming the workshop or
    course, or a draft for one not yet created, with its kind; the socket
    then receives everything that happens in it, starting with what
    happened before, and sends messages, permission answers and
    interrupts. A draft's socket also creates the workshop or course from
    the agreed plan, or discards the draft.
    """

    auth_resource = "contents"

    conversation: Conversation | None = None

    @property
    def max_message_size(self) -> int:
        """How large one message may be: room for the attachments, as base64."""

        return MESSAGE_LIMIT * 4 // 3 + 1024 * 1024

    async def pre_get(self) -> None:
        """Refuse a user who may not change files on this server."""

        authorized = await ensure_async(
            self.authorizer.is_authorized(self, self.current_user, "write", "contents")
        )

        if not authorized:
            raise tornado.web.HTTPError(403)

    @ws_authenticated
    async def get(self, *args: Any, **kwargs: Any) -> None:
        """Upgrade the request to a websocket."""

        await self.pre_get()

        result = super().get(*args, **kwargs)

        if result is not None:
            await result

    @property
    def manager(self) -> ConversationManager:
        """The server's conversations."""

        manager = self.settings.get(CONVERSATIONS_KEY)

        if not isinstance(manager, ConversationManager):
            raise ConversationError("Conversations are not set up")

        return manager

    @property
    def root_dir(self) -> Path:
        """The directory the server serves files from."""

        return Path(os.path.expanduser(str(self.settings.get("server_root_dir", ""))))

    async def on_message(self, message: str | bytes) -> None:
        """Act on one message from the panel."""

        try:
            data = json.loads(message)
        except ValueError:
            await self._send({"type": "error", "message": "Not JSON"})

            return

        if not isinstance(data, dict):
            return

        try:
            await self._handle(data)
        except ConversationError as error:
            await self._send({"type": "error", "message": str(error)})

    def on_close(self) -> None:
        """Stop sending this socket what happens."""

        if self.conversation is not None:
            self.conversation.detach(self._send)

    async def _handle(self, data: dict[str, Any]) -> None:
        kind = data.get("type")

        if kind == "open":
            await self._open(data)

            return

        conversation = self.conversation

        if conversation is None:
            raise ConversationError("Open a conversation first")

        if kind == "send":
            text = str(data.get("text") or "").strip()

            try:
                attachments = parse_attachments(data.get("attachments"))
            except AttachmentError as error:
                raise ConversationError(str(error)) from error

            if not text and not attachments:
                return

            # Starting over is the panel's to do, so the history it shows
            # goes with the agent's session.
            if text.lower() in CLEAR_COMMANDS and not attachments:
                await self.manager.clear(conversation)
            else:
                self._start_turn(conversation, conversation.send(text, attachments))

        elif kind == "compact":
            self._start_turn(conversation, conversation.compact())

        elif kind == "clear":
            await self.manager.clear(conversation)

        elif kind == "create":
            # The workshop is made from the plan, its conversation begins
            # with the plan as the brief, and the panel is told where to
            # carry on.
            created, text = await self.manager.create(conversation)

            self.conversation = None

            self._start_turn(created, created.send(text))

        elif kind == "discard":
            await self.manager.discard(conversation)

            self.conversation = None

        elif kind == "permission":
            conversation.session.answer(
                str(data.get("id") or ""),
                bool(data.get("allow")),
                bool(data.get("remember")),
            )

        elif kind == "answer":
            answers = data.get("answers")

            conversation.session.answer_question(
                str(data.get("id") or ""),
                {str(key): str(value) for key, value in answers.items()}
                if isinstance(answers, dict)
                else None,
            )

        elif kind == "interrupt":
            await conversation.session.interrupt()

        elif kind == "configure":
            await self.manager.configure(
                conversation,
                str(data.get("model") or ""),
                str(data.get("effort") or ""),
            )

        elif kind == "terminal":
            await self._send(
                {
                    "type": "terminal",
                    "cwd": conversation.path,
                    "command": self.manager.terminal_command(conversation),
                }
            )

        elif kind == "close":
            await self.manager.close(conversation.path)

            self.conversation = None

            await self._send({"type": "closed"})

    def _start_turn(
        self, conversation: Conversation, turn: Coroutine[Any, Any, None]
    ) -> None:
        if conversation.running:
            turn.close()

            raise ConversationError("The agent is still working on the last message")

        # The turn runs on its own, so permission answers and interrupts
        # arriving meanwhile are read. The task is kept until it ends.
        task = asyncio.ensure_future(turn)

        _TURNS.add(task)
        task.add_done_callback(_TURNS.discard)

    async def _open(self, data: dict[str, Any]) -> None:
        if self.conversation is not None:
            raise ConversationError("This socket already has a conversation")

        path = str(data.get("path") or "").strip().strip("/")
        draft = str(data.get("draft") or "")
        workshops_directory = str(data.get("directory") or "")

        if draft:
            await self._open_draft(data, draft, workshops_directory)

            return

        if not path:
            raise ConversationError("A workshop or course path is required")

        try:
            directory = under_root(self.root_dir, path, "workshop or course")
        except tornado.web.HTTPError as error:
            raise ConversationError(str(error.log_message)) from error

        await self._send({"type": "starting"})

        try:
            conversation = await self.manager.open(
                path,
                workshops_directory,
                directory,
                str(data.get("model") or ""),
                str(data.get("effort") or ""),
            )
        except ConversationError:
            raise
        except Exception as error:
            self.log.exception("Unable to start a conversation about %s", path)

            raise ConversationError(f"The agent could not start: {error}") from error

        await self._attach(conversation, data)

    async def _open_draft(
        self, data: dict[str, Any], draft: str, workshops_directory: str
    ) -> None:
        await self._send({"type": "starting"})

        try:
            conversation = await self.manager.open_draft(
                draft,
                workshops_directory,
                str(data.get("model") or ""),
                str(data.get("effort") or ""),
                str(data.get("kind") or "workshop"),
            )
        except ConversationError:
            raise
        except Exception as error:
            self.log.exception("Unable to start drafting a workshop or course")

            raise ConversationError(f"The agent could not start: {error}") from error

        await self._attach(conversation, data)

    async def _attach(self, conversation: Conversation, data: dict[str, Any]) -> None:
        self.conversation = conversation

        conversation.attach(self._send, str(data.get("client") or ""))

        await self._send(
            {
                "type": "opened",
                "path": conversation.path,
                "draft": conversation.draft,
                "kind": conversation.kind,
                "provider": conversation.provider,
                "session_id": conversation.session.session_id,
                "running": conversation.running,
                "history": conversation.history,
                "info": await conversation.info(),
            }
        )

    async def _send(self, message: dict[str, Any]) -> None:
        try:
            await self.write_message(json.dumps(message))
        except websocket.WebSocketClosedError:
            if self.conversation is not None:
                self.conversation.detach(self._send)


def _string_list(value: object, field: str) -> list[str] | None:
    if value is None:
        return None

    if not isinstance(value, list) or not all(isinstance(i, str) for i in value):
        raise tornado.web.HTTPError(400, f"{field} must be a list of strings")

    return list(value)


def setup_conversations(server_app: Any, bridge: Bridge) -> ConversationManager:
    """Create the server's conversation manager and keep it in the settings.

    Nothing is started until a conversation is opened, so a server
    without the `ai` extra pays nothing for it.
    """

    from .skill import skill_directory

    root = Path(os.path.expanduser(str(server_app.root_dir)))
    manager = ConversationManager(root, bridge, skill=skill_directory())

    server_app.web_app.settings[CONVERSATIONS_KEY] = manager

    return manager


def setup_handlers(server_app: Any) -> None:
    """Add the extension's handlers to the server's web application."""

    web_app = server_app.web_app
    base_url = web_app.settings["base_url"]

    handlers = [
        (url_path_join(base_url, API_NAMESPACE, "platform"), PlatformHandler),
        (url_path_join(base_url, API_NAMESPACE, "fetch"), FetchHandler),
        (url_path_join(base_url, API_NAMESPACE, "workshops"), WorkshopsHandler),
        (url_path_join(base_url, API_NAMESPACE, "courses"), CoursesHandler),
        (url_path_join(base_url, API_NAMESPACE, "library"), LibraryHandler),
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
        (url_path_join(base_url, API_NAMESPACE, "agent", "status"), AgentStatusHandler),
        (
            url_path_join(base_url, API_NAMESPACE, "agent", "conversation"),
            ConversationHandler,
        ),
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
