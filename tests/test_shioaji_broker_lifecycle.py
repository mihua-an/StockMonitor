from __future__ import annotations

import threading
from unittest.mock import MagicMock

from service.market.shioaji.session import ShioajiBrokerService


def _broker_shell() -> ShioajiBrokerService:
    broker = ShioajiBrokerService.__new__(ShioajiBrokerService)
    broker._lock = threading.RLock()
    broker._sync_mutex = threading.RLock()
    broker._thread = None
    broker._running = threading.Event()
    broker._stop_event = threading.Event()
    broker._subscription_mutation_frozen = False
    broker._reconnect_count = 0
    broker._session_generation = 1   # reconnect() records the generation it was in
    broker._session_recovery = None
    broker._disconnect = MagicMock()
    return broker


def test_reconnect_is_rejected_after_graceful_shutdown_begins() -> None:
    broker = _broker_shell()
    broker._subscription_mutation_frozen = True
    broker._stop_event.set()

    result = broker.reconnect()

    assert result["ok"] is False
    assert result["accepted"] is False
    assert broker._reconnect_count == 0
    broker._disconnect.assert_not_called()


def test_background_start_cannot_thaw_a_stopped_service_graph() -> None:
    broker = _broker_shell()
    broker._subscription_mutation_frozen = True

    try:
        broker.start_background()
    except RuntimeError as exc:
        assert "shutting down" in str(exc)
    else:
        raise AssertionError("stopped broker graph was restarted")


def test_subscription_syncs_and_a_reconnect_never_overlap() -> None:
    # The session thread and HTTP workers synced at the same time (calling the broker outside _lock),
    # and a reconnect could tear the session down mid-sync.
    import time

    broker = _broker_shell()
    inside, overlaps = [], []

    def sync(*, force: bool = False):
        if inside:
            overlaps.append("sync")
        inside.append(1)
        time.sleep(0.02)
        inside.pop()
        return []

    def disconnect():
        if inside:
            overlaps.append("disconnect")

    broker._sync_subscriptions_locked = sync
    broker._disconnect_locked = disconnect
    del broker._disconnect  # the shell's mock; the real wrapper takes the mutex
    broker.start_background = lambda: None
    threads = [threading.Thread(target=broker._sync_subscriptions) for _ in range(4)]
    threads.append(threading.Thread(target=broker.reconnect))
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    assert overlaps == []


def test_login_and_sync_failures_share_one_backoff_reset_by_a_success() -> None:
    """R12-25: one back-off policy for both recoveries (it was the same formula copied twice)."""
    from service.market.shared.daemon_connection import ReconnectBackoff

    broker = _broker_shell()
    broker._recovery_backoff = ReconnectBackoff(2.0, 60.0)
    broker._connected = threading.Event()
    broker._api = None
    waits: list[float] = []
    outcomes = iter(["login_fails", "login_fails", "login_ok_sync_fails", "login_ok_sync_ok"])
    state = {"step": None}

    def connect():
        state["step"] = next(outcomes)
        if state["step"] == "login_fails":
            raise RuntimeError("login refused")
        broker._connected.set()

    def sync():
        if state["step"] == "login_ok_sync_fails":
            raise RuntimeError("subscribe refused")
        broker._running.clear()      # the run ends after the first good sync

    def disconnect():
        broker._connected.clear()

    broker._connect, broker._sync_subscriptions, broker._disconnect = connect, sync, disconnect
    broker._refresh_stock_limits = lambda: None
    broker._refresh_txf_limits = lambda: None
    broker._apply_connection_settings = lambda: None
    broker._session_replacement_reason = lambda _now: None
    broker._set_error = lambda _exc: None
    broker._begin_session_recovery = lambda *_a: None
    broker._wake = threading.Event()
    broker._wake.set()
    broker.sync_seconds = 0
    broker._stop_event.wait = lambda delay: waits.append(delay) or False
    broker._running.set()
    broker._run()
    assert waits == [2.0, 4.0, 2.0], "two failed logins back off; the login that worked reset it before the sync failed"
    assert broker._recovery_backoff.next_delay() == 2.0, "the good sync reset it"
