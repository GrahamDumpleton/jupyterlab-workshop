"""A bridge from tools running outside the browser to the JupyterLab
frontend.

The MCP server and other tools cannot reach the extension's commands
directly: they run in another process and the frontend runs in a browser
tab. The bridge turns a request into a Jupyter Server event, which the
frontend receives over the events websocket when a workshop is open in
author mode. The frontend runs the command and posts the result back,
which resolves the request.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

SCHEMA_ID = "https://grahamdumpleton.github.io/jupyterlab-workshop/bridge/v1"

SCHEMA_VERSION = "1"

BRIDGE_SCHEMA: dict[str, Any] = {
    "$id": SCHEMA_ID,
    "version": SCHEMA_VERSION,
    "title": "Workshop bridge request",
    "description": "A command a tool asks the workshop extension to run.",
    "type": "object",
    "properties": {
        "request_id": {
            "type": "string",
            "title": "Request id",
            "description": "Identifier the frontend posts the result under.",
        },
        "command": {
            "type": "string",
            "title": "Command",
            "description": "The JupyterLab command id to execute.",
        },
        "args": {
            "type": "object",
            "title": "Arguments",
            "description": "Arguments passed to the command.",
        },
    },
    "required": ["request_id", "command", "args"],
}

DEFAULT_TIMEOUT = 60.0

SETTINGS_KEY = "jupyterlab_workshop_bridge"


class BridgeError(Exception):
    """A request could not be delivered or answered."""


@dataclass
class PendingRequest:
    """A request waiting for the frontend."""

    request_id: str
    command: str
    args: dict[str, Any]
    created: float
    future: asyncio.Future[Any] = field(repr=False)

    def to_dict(self) -> dict[str, Any]:
        """The request as the frontend or a poller sees it."""

        return {
            "request_id": self.request_id,
            "command": self.command,
            "args": self.args,
            "created": self.created,
        }


class Bridge:
    """Pending requests and the event logger they are announced through."""

    def __init__(self, event_logger: Any | None) -> None:
        self._event_logger = event_logger
        self._pending: dict[str, PendingRequest] = {}

        if event_logger is not None and SCHEMA_ID not in event_logger.schemas:
            event_logger.register_event_schema(BRIDGE_SCHEMA)

    def pending(self) -> list[dict[str, Any]]:
        """Requests not yet answered, oldest first."""

        return [item.to_dict() for item in self._pending.values()]

    async def request(
        self, command: str, args: dict[str, Any], timeout: float = DEFAULT_TIMEOUT
    ) -> Any:
        """Announce a command and wait for the frontend's answer."""

        if not command.startswith("workshop:"):
            raise BridgeError("Only workshop commands can be run through the bridge")

        loop = asyncio.get_running_loop()
        pending = PendingRequest(
            request_id=secrets.token_hex(8),
            command=command,
            args=args,
            created=time.time(),
            future=loop.create_future(),
        )

        self._pending[pending.request_id] = pending

        try:
            if self._event_logger is not None:
                self._event_logger.emit(
                    schema_id=SCHEMA_ID,
                    data={
                        "request_id": pending.request_id,
                        "command": command,
                        "args": args,
                    },
                )

            return await asyncio.wait_for(pending.future, timeout)
        except TimeoutError as error:
            raise BridgeError(
                f"No JupyterLab session answered {command} within {timeout:g}s; "
                "open the workshop in JupyterLab and turn on author mode"
            ) from error
        finally:
            self._pending.pop(pending.request_id, None)

    def resolve(
        self, request_id: str, result: Any = None, error: str | None = None
    ) -> bool:
        """Answer a request; returns False when it is unknown or already done."""

        pending = self._pending.get(request_id)

        if pending is None or pending.future.done():
            return False

        if error:
            pending.future.set_exception(BridgeError(error))
        else:
            pending.future.set_result(result)

        return True


def setup_bridge(server_app: Any) -> Bridge:
    """Create the bridge for a server and keep it in the web app settings."""

    bridge = Bridge(getattr(server_app, "event_logger", None))

    server_app.web_app.settings[SETTINGS_KEY] = bridge

    return bridge
