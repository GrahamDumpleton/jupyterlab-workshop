import asyncio

import pytest

from jupyterlab_workshop.bridge import Bridge, BridgeError


def test_bridge_resolves_requests_and_times_out() -> None:
    bridge = Bridge(None)

    async def scenario() -> None:
        task = asyncio.ensure_future(bridge.request("workshop:x", {"a": 1}, 5))

        await asyncio.sleep(0)

        pending = bridge.pending()

        assert len(pending) == 1
        assert pending[0]["args"] == {"a": 1}
        assert bridge.resolve(pending[0]["request_id"], result="done") is True
        assert await task == "done"
        assert bridge.pending() == []

        # An error from the frontend surfaces as an exception.
        task = asyncio.ensure_future(bridge.request("workshop:y", {}, 5))

        await asyncio.sleep(0)
        bridge.resolve(bridge.pending()[0]["request_id"], error="boom")

        with pytest.raises(BridgeError, match="boom"):
            await task

        with pytest.raises(BridgeError, match="author mode"):
            await bridge.request("workshop:z", {}, 0.05)

        with pytest.raises(BridgeError, match="Only workshop commands"):
            await bridge.request("docmanager:open", {}, 1)

        assert bridge.resolve("unknown") is False

    asyncio.run(scenario())


class _Logger:
    """Records what the bridge emits, as the server's event logger would."""

    def __init__(self) -> None:
        self.schemas: dict[str, object] = {}
        self.emitted: list[dict] = []

    def register_event_schema(self, schema: dict) -> None:
        self.schemas[schema["$id"]] = schema

    def emit(self, schema_id: str, data: dict) -> None:
        self.emitted.append(data)


def test_bridge_names_the_target_tab_only_when_given() -> None:
    logger = _Logger()
    bridge = Bridge(logger)

    async def scenario() -> None:
        untargeted = asyncio.ensure_future(bridge.request("workshop:a", {}, 5))
        targeted = asyncio.ensure_future(
            bridge.request("workshop:b", {}, 5, target="tab-1")
        )

        await asyncio.sleep(0)

        pending = {item["command"]: item for item in bridge.pending()}

        assert "target" not in pending["workshop:a"]
        assert pending["workshop:b"]["target"] == "tab-1"

        for item in pending.values():
            bridge.resolve(item["request_id"], result=None)

        await untargeted
        await targeted

    asyncio.run(scenario())

    assert "target" not in logger.emitted[0]
    assert logger.emitted[1]["target"] == "tab-1"


def test_cancelling_fails_every_waiting_request() -> None:
    bridge = Bridge(None)

    async def scenario() -> None:
        first = asyncio.ensure_future(bridge.request("workshop:a", {}, 600))
        second = asyncio.ensure_future(bridge.request("workshop:b", {}, 600))

        await asyncio.sleep(0)

        assert bridge.cancel_all("stopping") == 2

        for task in (first, second):
            with pytest.raises(BridgeError, match="stopping"):
                await task

        assert bridge.pending() == []

    asyncio.run(scenario())
