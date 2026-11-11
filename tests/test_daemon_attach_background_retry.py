"""Tests for the FastAPI-side background daemon attach retry.

Ownership: the retry/backoff/escalation loop for attaching to a provider daemon lives on
``DaemonLease.attach_in_background`` (service/market/shared/daemon_lease.py). The Shioaji Market Daemon client
(``MarketDaemonClient.start_in_background``) and the Futu/Moomoo client (``MoomooDaemonClient.attach_in_background``)
only pass their policy: Shioaji never gives up and stops on a foreign port owner; Futu waits 1 s first, stops on
OpenD not running or a foreign owner, and gives up after 15 minutes. quote_api starts both loops; what the providers
subscribe is market_runtime's demand plan, not a watchlist the API pushes after attach (docs/system-architecture/01),
so there is no restore hook.
"""
from __future__ import annotations

import threading
import time

import pytest

from service.market.futu.daemon_client import MoomooDaemonClient
from service.market.shared import daemon_lease
from service.market.shared.daemon_lease import DaemonLease
from service.market.shioaji.daemon_client import MarketDaemonClient


@pytest.fixture(autouse=True)
def fast_backoff(monkeypatch):
    monkeypatch.setattr(daemon_lease, "ATTACH_BACKOFF", (0.01, 0.05))


class ScriptedStartStop:
    """A minimal .start()/.stop() pair whose results can be scripted."""

    def __init__(self, start_results=None, start_side_effect=None):
        self.starts = self.stops = 0
        self.stop_result = {"ok": True}
        self._start_results = list(start_results) if start_results is not None else None
        self._start_side_effect = start_side_effect

    def start(self):
        self.starts += 1
        if self._start_side_effect is not None:
            self._start_side_effect(self.starts)
        if self._start_results is not None:
            index = min(self.starts - 1, len(self._start_results) - 1)
            return self._start_results[index]
        return {"ok": True}

    def stop(self, **kwargs):
        self.stops += 1
        return self.stop_result


def _bare_client(scripted: ScriptedStartStop) -> MarketDaemonClient:
    """A MarketDaemonClient with no real transport, only start()/stop() wired."""
    runtime = MarketDaemonClient()
    runtime.cached_health = lambda: {}
    runtime.start = scripted.start
    runtime.stop = scripted.stop
    return runtime


def _bare_moomoo_client(scripted: ScriptedStartStop) -> MoomooDaemonClient:
    client = MoomooDaemonClient()
    client.start = scripted.start
    client.stop = scripted.stop
    return client


def _hold_lease(lease: DaemonLease, instance: str, lease_id: str = "L1") -> None:
    lease._attached, lease._lease_id, lease._instance_id = True, lease_id, instance


# ---------------------------------------------------------------------------
# MarketDaemonClient.start_in_background (Shioaji / Market Daemon)
# ---------------------------------------------------------------------------

def test_shioaji_start_in_background_retries_until_success_and_calls_on_attempt_every_time():
    scripted = ScriptedStartStop(start_results=[{"ok": False, "error": "not ready"}, {"ok": False, "error": "not ready"}, {"ok": True}])
    runtime = _bare_client(scripted)
    observed = []
    shutdown = threading.Event()
    thread = runtime.start_in_background(shutdown, on_attempt=lambda started_ns: observed.append(started_ns))
    thread.join(5)
    assert not thread.is_alive()
    assert scripted.starts == 3
    assert scripted.stops == 0
    assert len(observed) == 3


def test_shioaji_start_in_background_stops_client_if_shutdown_arrives_mid_attach():
    entered, release = threading.Event(), threading.Event()
    shutdown = threading.Event()

    def side_effect(attempt):
        entered.set()
        release.wait(3)
        shutdown.set()

    scripted = ScriptedStartStop(start_results=[{"ok": True}], start_side_effect=side_effect)
    runtime = _bare_client(scripted)
    thread = runtime.start_in_background(shutdown)
    assert entered.wait(2)
    release.set()
    thread.join(5)
    assert not thread.is_alive()
    assert scripted.starts == 1
    # Shutdown landed while attach was in flight: the late lease must be
    # released rather than left attached with nobody watching it.
    assert scripted.stops == 1


def test_shioaji_start_in_background_stops_between_attempts_without_calling_stop(monkeypatch):
    monkeypatch.setattr(daemon_lease, "ATTACH_BACKOFF", (5.0, 5.0))
    shutdown = threading.Event()
    scripted = ScriptedStartStop(start_results=[{"ok": False, "error": "not ready"}])
    runtime = _bare_client(scripted)
    thread = runtime.start_in_background(shutdown)
    deadline = time.monotonic() + 2.0
    while scripted.starts < 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(0.1)  # let the failed attempt finish its bookkeeping and enter the idle wait
    # Shutdown lands while idling between attempts (never attached => no stop()).
    shutdown.set()
    thread.join(5)
    assert not thread.is_alive()
    assert scripted.stops == 0


def test_shioaji_start_in_background_survives_start_raising_and_recovers():
    def side_effect(attempt):
        if attempt == 1:
            raise RuntimeError("transient")

    scripted = ScriptedStartStop(start_results=[{"ok": True}, {"ok": True}], start_side_effect=side_effect)
    runtime = _bare_client(scripted)
    observed = []
    shutdown = threading.Event()
    thread = runtime.start_in_background(shutdown, on_attempt=lambda started_ns: observed.append(started_ns))
    thread.join(5)
    assert not thread.is_alive()
    assert scripted.starts == 2
    # The raising attempt is still profiled, same as a normal failed attempt.
    assert len(observed) == 2


def test_shioaji_start_in_background_escalates_exactly_once_past_threshold(monkeypatch, caplog):
    import service.market.shioaji.daemon_client as monitor_runtime_module
    monkeypatch.setattr(monitor_runtime_module, "MARKET_DAEMON_ATTACH_ESCALATION_SECONDS", 0.0)
    scripted = ScriptedStartStop(start_results=[{"ok": False, "error": "not ready"}] * 4 + [{"ok": True}])
    runtime = _bare_client(scripted)
    shutdown = threading.Event()
    with caplog.at_level("ERROR", logger="service.market.shioaji.daemon_client"):
        thread = runtime.start_in_background(shutdown)
        thread.join(5)
    assert not thread.is_alive()
    escalation_messages = [r for r in caplog.records if "no longer a normal startup race" in r.message]
    assert len(escalation_messages) == 1


def test_shioaji_start_in_background_uses_injected_logger(caplog):
    import logging
    scripted = ScriptedStartStop(start_results=[{"ok": True}])
    runtime = _bare_client(scripted)
    custom_logger = logging.getLogger("custom.test.logger")
    shutdown = threading.Event()
    with caplog.at_level("INFO", logger="custom.test.logger"):
        thread = runtime.start_in_background(shutdown, logger=custom_logger)
        thread.join(5)
    assert not thread.is_alive()
    assert any("attach completed in background" in r.message for r in caplog.records)


def test_shioaji_a_foreign_port_owner_is_tried_once_and_stops_the_loop(caplog):
    # R12-15: a foreign program on 8010 used to be retried every second for as long as FastAPI ran.
    scripted = ScriptedStartStop(start_results=[{"ok": False, "classification": "FOREIGN_ENDPOINT", "error": "foreign"}])
    runtime = _bare_client(scripted)
    with caplog.at_level("ERROR", logger="service.market.shioaji.daemon_client"):
        thread = runtime.start_in_background(threading.Event())
        thread.join(5)
    assert not thread.is_alive() and scripted.starts == 1
    assert any("FOREIGN_ENDPOINT" in r.message and "attach stopped" in r.message for r in caplog.records)


def test_shioaji_transient_failures_back_off_and_never_give_up(monkeypatch):
    monkeypatch.setattr(daemon_lease, "ATTACH_BACKOFF", (1.0, 30.0))
    waits = []

    class RecordingEvent(threading.Event):
        def wait(self, timeout=None):
            waits.append(timeout)
            return False

    scripted = ScriptedStartStop(start_results=[{"ok": False, "error": "not ready"}] * 7 + [{"ok": True}])
    runtime = _bare_client(scripted)
    thread = runtime.start_in_background(RecordingEvent())
    thread.join(5)
    assert not thread.is_alive() and scripted.starts == 8
    assert waits == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0], waits


def test_shioaji_start_reports_a_foreign_endpoint_as_its_classification(monkeypatch):
    from service.market.shioaji import daemon_client as module

    def foreign(**kwargs):
        raise module.ForeignMarketDaemonEndpoint("port 8010 is occupied by a confirmed foreign endpoint")

    monkeypatch.setattr(module, "ensure_market_daemon", foreign)
    result = MarketDaemonClient().start()
    assert result["ok"] is False and result["classification"] == "FOREIGN_ENDPOINT"


# ---------------------------------------------------------------------------
# MoomooDaemonClient.attach_in_background (Futu)
# ---------------------------------------------------------------------------

def test_moomoo_attach_in_background_waits_before_first_attempt_then_retries_and_calls_on_attached():
    scripted = ScriptedStartStop(start_results=[{"ok": False, "error": "not ready"}, {"ok": True}])
    client = _bare_moomoo_client(scripted)
    on_attached_calls = []
    shutdown = threading.Event()
    started = time.monotonic()
    thread = client.attach_in_background(shutdown, on_attached=lambda: on_attached_calls.append(True))
    thread.join(5)
    elapsed = time.monotonic() - started
    assert not thread.is_alive()
    assert elapsed >= 1.0  # initial readiness-critical-section delay is honored
    assert scripted.starts == 2
    assert on_attached_calls == [True]


def test_moomoo_attach_in_background_shutdown_during_initial_delay_makes_zero_attempts():
    scripted = ScriptedStartStop()
    client = _bare_moomoo_client(scripted)
    shutdown = threading.Event()
    shutdown.set()  # already shutting down before the loop even starts
    thread = client.attach_in_background(shutdown)
    thread.join(5)
    assert not thread.is_alive()
    assert scripted.starts == 0


def test_moomoo_attach_in_background_logs_only_every_fifth_attempt(monkeypatch, caplog):
    import service.market.futu.daemon_client as moomoo_daemon_client_module
    monkeypatch.setattr(moomoo_daemon_client_module, "MOOMOO_DAEMON_ATTACH_ESCALATION_SECONDS", 1e9)
    scripted = ScriptedStartStop(start_results=[{"ok": False, "error": "not ready"}] * 6 + [{"ok": True}])
    client = _bare_moomoo_client(scripted)
    shutdown = threading.Event()
    with caplog.at_level("WARNING", logger="service.market.futu.daemon_client"):
        thread = client.attach_in_background(shutdown)
        thread.join(10)
    assert not thread.is_alive()
    assert scripted.starts == 7
    unavailable_logs = [r for r in caplog.records if "futu daemon attach unavailable" in r.message]
    attempts_logged = sorted(int(r.message.split("attempt=")[1].split(":")[0]) for r in unavailable_logs)
    # Attempts 1 and 5 only (out of 6 failing attempts) - not every attempt.
    assert attempts_logged == [1, 5]


def test_moomoo_attach_in_background_stops_permanently_on_opend_not_running(caplog):
    # OPEND_NOT_RUNNING is human-actionable, not a startup race: the loop must
    # report it once and give up rather than polling forever. Manual retry
    # (POST /api/futu-daemon/reconnect, wired to the System Connection
    # Diagnostics panel's button) is the only way to try again from here.
    scripted = ScriptedStartStop(start_results=[
        {"ok": False, "classification": "OPEND_NOT_RUNNING", "error": "Futu OpenD 未啟動"},
    ])
    client = _bare_moomoo_client(scripted)
    on_attached_calls = []
    shutdown = threading.Event()
    with caplog.at_level("WARNING", logger="service.market.futu.daemon_client"):
        thread = client.attach_in_background(shutdown, on_attached=lambda: on_attached_calls.append(True))
        thread.join(5)
    assert not thread.is_alive()
    assert scripted.starts == 1
    assert on_attached_calls == []
    stopped_logs = [r for r in caplog.records if "futu daemon attach stopped" in r.message]
    assert len(stopped_logs) == 1


def test_moomoo_attach_in_background_stops_client_if_shutdown_arrives_mid_attach():
    entered, release = threading.Event(), threading.Event()
    shutdown = threading.Event()

    def side_effect(attempt):
        entered.set()
        release.wait(3)
        shutdown.set()

    scripted = ScriptedStartStop(start_results=[{"ok": True}], start_side_effect=side_effect)
    client = _bare_moomoo_client(scripted)
    thread = client.attach_in_background(shutdown)
    assert entered.wait(3)
    release.set()
    thread.join(5)
    assert not thread.is_alive()
    assert scripted.starts == 1
    assert scripted.stops == 1


def test_moomoo_attach_in_background_backs_off_and_gives_up(monkeypatch, caplog):
    # Transient failures used to retry every second for as long as FastAPI ran. Now the delay grows
    # and the loop gives up after its budget; a foreign port owner stops it at once.
    import service.market.futu.daemon_client as module
    monkeypatch.setattr(daemon_lease, "ATTACH_BACKOFF", (1.0, 30.0))
    waits = []

    class RecordingEvent(threading.Event):
        def wait(self, timeout=None):
            waits.append(timeout)
            return False

    monkeypatch.setattr(module, "_ATTACH_GIVE_UP_SECONDS", 0.0)
    scripted = ScriptedStartStop(start_results=[{"ok": False, "error": "not ready"}] * 50)
    client = _bare_moomoo_client(scripted)
    thread = client.attach_in_background(RecordingEvent())
    thread.join(5)
    assert not thread.is_alive() and scripted.starts == 1, "gave up after its budget"
    waits.clear()
    monkeypatch.setattr(module, "_ATTACH_GIVE_UP_SECONDS", 3600.0)
    scripted = ScriptedStartStop(start_results=[{"ok": False, "error": "not ready"}] * 4
                                 + [{"ok": False, "classification": "FOREIGN_ENDPOINT", "error": "foreign"}])
    client = _bare_moomoo_client(scripted)
    thread = client.attach_in_background(RecordingEvent())
    thread.join(5)
    assert not thread.is_alive() and scripted.starts == 5, "a foreign port owner stops the loop"
    assert waits[1:] == [1.0, 2.0, 4.0, 8.0], waits


# ---------------------------------------------------------------------------
# Start() never reports success for a client that is not attached to the running daemon
# ---------------------------------------------------------------------------

def test_moomoo_start_reuses_only_a_lease_on_the_daemon_running_now(monkeypatch):
    from service.market.futu import daemon_client as module

    client = MoomooDaemonClient()
    alive = threading.Event()
    client._heartbeat_thread = threading.Thread(target=alive.wait, daemon=True)
    client._heartbeat_thread.start()
    _hold_lease(client._lease, "old-instance")
    monkeypatch.setattr(module, "probe_moomoo_daemon", lambda timeout=0.8: {"daemon_instance_id": "new-instance"})
    monkeypatch.setattr(module, "is_daemon_usable", lambda health: True)
    attached = []
    monkeypatch.setattr(client, "ensure_daemon", lambda: {"ok": True, "health": {"daemon_instance_id": "new-instance"}})
    monkeypatch.setattr(client, "_attach_to_current_daemon", lambda health: attached.append(health) or {"lease_id": "L2"})
    try:
        result = client._start_locked()
        assert attached, "a restarted daemon is attached to, not reused"
        assert result["ok"] is True and not result.get("reused_client_lease")
        _hold_lease(client._lease, "new-instance", "L2")
        reused = client._start_locked()
        assert reused["reused_client_lease"] is True and len(attached) == 1
    finally:
        alive.set()


def test_shioaji_start_while_running_but_detached_attaches_or_says_it_failed(monkeypatch):
    runtime = MarketDaemonClient()
    runtime._running.set()

    def refused(path, body=None, **kwargs):
        raise RuntimeError("daemon restarting")

    monkeypatch.setattr(runtime, "post_json", refused)
    failed = runtime._start_locked()
    assert failed["ok"] is False and failed["attached"] is False and "restarting" in failed["error"]

    attaches = []

    def accepted(path, body=None, **kwargs):
        attaches.append(path)
        return {"ok": True, "lease_id": f"L{len(attaches)}"}

    monkeypatch.setattr(runtime, "post_json", accepted)
    assert runtime._start_locked()["ok"] is True and attaches == ["/v1/client/attach"]

    # Attached, but the lease was taken from an instance that is gone -- start() attaches again instead of
    # answering ok for a lease the current daemon does not hold.
    _hold_lease(runtime._lease, "old-instance")
    runtime._health = {"daemon_instance_id": "new-instance"}
    assert runtime._start_locked()["ok"] is True and len(attaches) == 2


def test_moomoo_a_post_attach_callback_that_raises_never_attaches_again(caplog):
    """The attach holds the lease once it succeeded: the callback's failure is recorded, not a reason to retry."""
    scripted = ScriptedStartStop(start_results=[{"ok": True}, {"ok": True}, {"ok": True}])
    client = _bare_moomoo_client(scripted)
    calls = []

    def broken():
        calls.append(1)
        raise RuntimeError("restoring the watchlist failed")

    shutdown = threading.Event()
    with caplog.at_level("WARNING"):
        thread = client.attach_in_background(shutdown, on_attached=broken)
        thread.join(5)
    assert not thread.is_alive()
    assert scripted.starts == 1 and calls == [1], "one attach, one callback"
    assert any("post-attach callback" in r.getMessage() for r in caplog.records), "the callback failure is recorded"
