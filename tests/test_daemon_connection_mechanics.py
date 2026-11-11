import threading

import pytest

from service.market.shared.daemon_connection import matches_contract, ReconnectBackoff, lease_body
from service.market.shioaji import daemon_client as shioaji
from service.market.futu import daemon_client as futu


@pytest.mark.parametrize("version", [None, {}, [], True, 1.2, "bad", "01", 1.0])
def test_untrusted_protocol_is_rejected_without_coercion(version):
    assert not matches_contract({"ok": True, "identity": "owner", "protocol_version": version,
                                 "daemon_runtime_version": "v1"}, identity="owner", protocol=1, runtime="v1")


def test_delay_policy_preserves_source_schedules_and_lease_wire_keys():
    exponential = ReconnectBackoff(0.5, 8, 2)
    assert [exponential.next_delay() for _ in range(7)] == [.5, 1, 2, 4, 8, 8, 8]
    exponential.reset()
    assert exponential.next_delay() == .5
    fixed = ReconnectBackoff(1, 1)
    assert [fixed.next_delay() for _ in range(3)] == [1, 1, 1]
    assert lease_body("client", "control", "lease") == {"client_id": "client", "connection_id": "control", "lease_id": "lease"}


def _transport_name(subject) -> str:
    return "post_json" if isinstance(subject, shioaji.MarketDaemonClient) else "_request"


@pytest.fixture(params=["shioaji", "futu"])
def client(request, monkeypatch):
    result = shioaji.MarketDaemonClient() if request.param == "shioaji" else futu.MoomooDaemonClient()
    monkeypatch.setattr(futu, "probe_moomoo_daemon", lambda **kw: {"daemon_pid": 123})
    calls = []
    def request_ok(*args, **kwargs):
        calls.append((args, kwargs))
        return {"ok": True, "detached": True, "lease_id": "lease"}
    monkeypatch.setattr(result, _transport_name(result), request_ok)
    result._lease.attach("instance")
    calls.clear()
    return result, calls


def test_stop_timeout_retains_worker_and_blocks_restart_until_cleanup(client):
    subject, calls = client
    release = threading.Event()
    worker = threading.Thread(target=lambda: release.wait(3), name="blocked-worker")
    # Futu has no stream worker (its lease is renewed by the heartbeat loop).
    attribute = "_stream_thread" if isinstance(subject, shioaji.MarketDaemonClient) else "_heartbeat_thread"
    setattr(subject, attribute, worker)
    worker.start()
    try:
        stopped = subject.stop(timeout=0)
        assert not stopped["ok"] and stopped["workers_alive"] == ["blocked-worker"]
        assert getattr(subject, attribute) is worker
        assert not subject.start()["ok"]
        assert calls == []  # no detach/attach race against a still-running worker
    finally:
        release.set()
        worker.join(1)
    assert subject.stop(timeout=1)["ok"]
    assert len(calls) == 1
    assert subject.stop()["ok"] and len(calls) == 1
    assert not subject._stopping


def test_detach_failure_retains_lease_for_explicit_retry(client, monkeypatch):
    subject, _ = client
    def failed(*args, **kwargs):
        raise RuntimeError("transport failed")
    name = _transport_name(subject)
    monkeypatch.setattr(subject, name, failed)
    stopped = subject.stop()
    assert not stopped["ok"] and not stopped["detached"]
    assert not subject.start()["ok"]
    assert subject._lease.snapshot()["lease_id"] == "lease"
    monkeypatch.setattr(subject, name, lambda *args, **kwargs: {"ok": True, "detached": True})
    assert subject.stop()["ok"]


def test_a_refused_detach_is_not_detached(client, monkeypatch):
    subject, _ = client
    monkeypatch.setattr(subject, _transport_name(subject), lambda *a, **k: {"ok": False, "error": "unknown lease"})
    stopped = subject.stop()
    assert stopped["ok"] is False and stopped["detached"] is False


def test_a_lease_gone_with_its_daemon_instance_is_not_offered_on_stop(client, monkeypatch):
    # R12-15: the Shioaji client sent its old lease to the new instance, which refused it, and the stop then
    # wrote a false failure and answered ok False.
    subject, calls = client
    if isinstance(subject, shioaji.MarketDaemonClient):
        subject._health = {"daemon_instance_id": "restarted"}
    else:
        monkeypatch.setattr(futu, "probe_moomoo_daemon", lambda **kw: {"daemon_instance_id": "restarted"})
    stopped = subject.stop()
    assert stopped["ok"] is True and stopped["detached"] is False
    assert calls == [], "no detach sent for a lease the daemon running now never gave"


def test_futu_attach_rejected_does_not_start_workers(monkeypatch):
    subject = futu.MoomooDaemonClient()
    monkeypatch.setattr(subject, "ensure_daemon", lambda: {"ok": True, "health": {}})
    monkeypatch.setattr(subject, "_request", lambda *a, **k: {"ok": False, "error": "lease refused"})
    assert subject.start() == {"ok": False, "error": "lease refused"}
    assert subject._heartbeat_thread is None and not hasattr(subject, "_stream_thread")


def test_futu_status_is_a_non_blocking_cached_health_snapshot(monkeypatch):
    subject = futu.MoomooDaemonClient()
    subject._health = {"ok": True, "runtime": {"state": "LIVE"}}
    monkeypatch.setattr(
        futu,
        "probe_moomoo_daemon",
        lambda **kwargs: pytest.fail("status() must not probe the daemon"),
    )

    snapshot = subject.status()
    snapshot["runtime"]["state"] = "MUTATED"

    assert subject.status() == {"ok": True, "runtime": {"state": "LIVE"}}


@pytest.mark.parametrize("source", ["shioaji", "futu"])
def test_concurrent_starts_attach_once_and_reuse_workers(source, monkeypatch):
    subject = shioaji.MarketDaemonClient() if source == "shioaji" else futu.MoomooDaemonClient()
    release, entered, continue_attach = threading.Event(), threading.Event(), threading.Event()
    attaches, results = [], []
    def transport(*args, **kwargs):
        path = args[1] if source == "futu" else args[0]
        if path == "/v1/client/attach":
            attaches.append(True)
            entered.set()
            assert continue_attach.wait(2)
            return {"ok": True, "lease_id": "L1", "daemon_instance_id": "daemon-1"}
        return {"ok": True, "detached": True}
    monkeypatch.setattr(subject, _transport_name(subject), transport)
    if source == "shioaji":
        monkeypatch.setattr(shioaji, "ensure_market_daemon", lambda **kw: {"health": {}})
        monkeypatch.setattr(subject, "_health_loop", lambda: release.wait(2))
        monkeypatch.setattr(subject, "_stream_loop", lambda: release.wait(2))
    else:
        monkeypatch.setattr(subject, "ensure_daemon", lambda: {"ok": True})
        # The second start() reuses the lease only after a probe names the instance it is attached to.
        monkeypatch.setattr(futu, "probe_moomoo_daemon", lambda **kw: {"daemon_instance_id": "daemon-1"})
        monkeypatch.setattr(futu, "is_daemon_usable", lambda health: True)
        def worker(attribute):
            current = getattr(subject, attribute)
            if current and current.is_alive():
                return
            thread = threading.Thread(target=lambda: release.wait(2), name=attribute)
            setattr(subject, attribute, thread)
            thread.start()
        monkeypatch.setattr(subject, "_start_heartbeat", lambda: worker("_heartbeat_thread"))
    callers = [threading.Thread(target=lambda: results.append(subject.start())) for _ in range(2)]
    try:
        callers[0].start()
        assert entered.wait(1)
        callers[1].start()
        continue_attach.set()
        for caller in callers:
            caller.join(2)
        assert len(results) == 2 and all(result["ok"] for result in results)
        assert len(attaches) == 1
    finally:
        continue_attach.set()
        release.set()
        for caller in callers:
            if caller.ident:
                caller.join(2)
        assert subject.stop(timeout=2)["ok"]
