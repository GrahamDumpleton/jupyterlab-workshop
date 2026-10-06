"""The server extension's part in Jupyter Server's start and stop.

The extension is loaded as a function, which Jupyter Server never tells
of a shutdown. Workshop Author's conversations need to hear of one: a
turn still running when the event loop stops leaves its worker threads
waiting forever, and Python waits for them before the process can exit,
so stopping JupyterLab would hang. This small extension application is
loaded beside the function only for its stop hook, which fails the
bridge requests still waiting and closes every conversation, ending each
agent's process, while the loop still runs.
"""

from __future__ import annotations

from typing import Any

from jupyter_server.extension.application import ExtensionApp

from .bridge import SETTINGS_KEY as BRIDGE_KEY
from .bridge import Bridge


class WorkshopLifecycle(ExtensionApp):
    """Closes Workshop Author's conversations when the server stops."""

    name = "jupyterlab_workshop_lifecycle"

    load_other_extensions = True

    def current_activity(self) -> list[str] | None:
        """The conversations with a turn in progress, which count as activity."""

        manager = self._conversations()

        if manager is None:
            return None

        running = manager.running()

        return running or None

    async def stop_extension(self) -> None:
        """End every conversation before the event loop stops."""

        settings = self._settings()
        bridge = settings.get(BRIDGE_KEY)

        if isinstance(bridge, Bridge):
            bridge.cancel_all("JupyterLab is shutting down")

        manager = self._conversations()

        if manager is not None:
            if manager.open_paths():
                self.log.info("Closing Workshop Author conversations")

            await manager.close_all()

    def _settings(self) -> dict[str, Any]:
        serverapp = self.serverapp

        if serverapp is None or getattr(serverapp, "web_app", None) is None:
            return {}

        return dict(serverapp.web_app.settings)

    def _conversations(self) -> Any:
        from .handlers import CONVERSATIONS_KEY

        return self._settings().get(CONVERSATIONS_KEY)
