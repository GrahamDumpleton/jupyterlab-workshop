import asyncio

import pytest

from educates_jupyterlab_workshop.bridge import Bridge, BridgeError


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
