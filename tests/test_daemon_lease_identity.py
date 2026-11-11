"""A caller naming a lease it does not hold fell back to the client's only other lease."""
from __future__ import annotations

from service.market.lifecycle.daemon import MarketDaemonLifecycleManager


def test_a_named_lease_that_is_not_held_never_matches_another():
    manager = MarketDaemonLifecycleManager(idle_grace_seconds=5, lease_timeout_seconds=30, client_heartbeat_seconds=5)
    live = manager.attach("fastapi", connection_id="stream-2", lease_kind="websocket", expires=False)
    stale = manager.detach("fastapi", lease_id="lease-of-a-closed-stream", connection_id="stream-1")
    assert stale["detached"] is False and stale["client_count"] == 1, "the live stream's lease stays"
    assert manager.detach("fastapi", lease_id=live["lease_id"], connection_id="stream-2")["detached"] is True
    # A caller that knows only the client id still finds its single lease.
    manager.attach("fastapi")
    assert manager.detach("fastapi")["detached"] is True
