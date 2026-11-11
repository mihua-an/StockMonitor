"""R12-15: the lease life cycle both daemon clients share (service/market/shared/daemon_lease.py). A reattach after
the daemon restarted is always a recorded recovery, even when the first try succeeds (the Shioaji client finished a
recovery it had never opened, so nothing was written); a lease is offered only to the instance that gave it; and the
shutdown receipt says what the detach did."""
from __future__ import annotations

import threading

import pytest

from service.market.shared.daemon_lease import DaemonLease
from service.platform import remediation


@pytest.fixture
def events(monkeypatch):
    recorded: list[dict] = []
    emitter = remediation.RemediationEmitter(service_id="test", pipe_path="")
    original = emitter._emit_tracked

    def emit(**kwargs):
        event, queued = original(**kwargs)
        recorded.append(event)
        return event, queued

    monkeypatch.setattr(emitter, "_emit_tracked", emit)
    monkeypatch.setattr(remediation, "emitter", lambda: emitter)
    return recorded


class Daemon:
    """The daemon's lease endpoints: one instance at a time, scripted answers per path."""

    def __init__(self, instance="d1"):
        self.instance = instance
        self.calls: list[tuple[str, dict]] = []
        self.refuse: set[str] = set()
        self.raise_on: set[str] = set()

    def post(self, path, body, timeout):
        self.calls.append((path, dict(body)))
        if path in self.raise_on:
            raise RuntimeError(f"{path} transport failed")
        if path in self.refuse:
            return {"ok": False, "error": "refused"}
        return {"ok": True, "lease_id": body.get("lease_id") or f"{self.instance}-lease",
                "daemon_instance_id": self.instance}


@pytest.fixture(params=["shioaji", "futu"])
def lease(request):
    daemon = Daemon()
    subject = DaemonLease(provider=request.param, client_id="c1", client_name="fastapi", post=daemon.post,
                          component=f"{request.param}_client", attach_mechanism=f"client.{request.param}_daemon_attach",
                          reattach_mechanism=f"client.{request.param}_lease_reattach")
    subject.daemon = daemon
    return subject


def _rows(events, mechanism):
    return [(e["outcome"], e.get("trigger_reason")) for e in events if e["mechanism_id"] == mechanism]


def test_a_restarted_daemon_retaken_at_the_first_try_is_one_recorded_recovery(lease, events):
    lease.attach("d1")
    lease.daemon.instance = "d2"
    lease.daemon.calls.clear()
    lease.keep("d2")
    assert lease.attached and lease.instance_id == "d2"
    attach = lease.daemon.calls[0]
    assert attach[0] == "/v1/client/attach" and "lease_id" not in attach[1], "the old lease is not offered to d2"
    rows = _rows(events, f"client.{lease.provider}_lease_reattach")
    assert rows == [("started", "instance_changed"), ("succeeded", "instance_changed")]


def test_a_refused_heartbeat_retakes_the_same_lease_and_is_recorded(lease, events):
    lease.attach("d1")
    lease.daemon.refuse.add("/v1/client/heartbeat")
    lease.daemon.calls.clear()
    lease.keep("d1")
    assert [path for path, _ in lease.daemon.calls] == ["/v1/client/heartbeat", "/v1/client/attach"]
    assert lease.daemon.calls[1][1]["lease_id"] == "d1-lease", "same instance: attach again under the same lease"
    assert _rows(events, f"client.{lease.provider}_lease_reattach") == [("started", "heartbeat_failed"),
                                                                         ("succeeded", "heartbeat_failed")]


def test_a_failed_reattach_leaves_the_client_not_attached_and_says_why(lease, events):
    lease.attach("d1")
    lease.daemon.instance = "d2"
    lease.daemon.raise_on.add("/v1/client/attach")
    lease.keep("d2")
    snapshot = lease.snapshot()
    assert snapshot["attached"] is False and "reattach" in snapshot["last_heartbeat_error"]
    assert _rows(events, f"client.{lease.provider}_lease_reattach") == [("started", "instance_changed")], "still open"
    lease.daemon.raise_on.clear()
    lease.keep("d2")
    assert lease.attached
    assert _rows(events, f"client.{lease.provider}_lease_reattach")[-1][0] == "succeeded"


def test_nothing_is_detached_once_the_lease_went_with_its_instance(lease):
    lease.attach("d1")
    lease.observe("d2")
    lease.daemon.calls.clear()
    assert lease.detach() == {"ok": True, "detached": False}
    assert lease.daemon.calls == []


def test_a_refused_or_failed_detach_keeps_the_lease_and_is_not_detached(lease):
    lease.attach("d1")
    lease.daemon.refuse.add("/v1/client/detach")
    refused = lease.detach()
    assert refused["ok"] is False and refused["detached"] is False and lease.attached
    lease.daemon.refuse.clear()
    lease.daemon.raise_on.add("/v1/client/detach")
    failed = lease.detach()
    assert failed["ok"] is False and failed["detached"] is False and lease.attached
    lease.daemon.raise_on.clear()
    assert lease.detach()["detached"] is True and not lease.attached


def test_the_shutdown_receipt_says_what_each_stop_did():
    from api.services import quote_api

    class Client:
        def __init__(self, result):
            self.result = result

        def stop(self):
            if isinstance(self.result, Exception):
                raise self.result
            return self.result

    def receipt(shioaji, futu):
        resources = quote_api.Resources.__new__(quote_api.Resources)
        resources.shutdown = threading.Event()
        resources.runtime, resources.futu = Client(shioaji), Client(futu)
        return resources.prepare_shutdown()

    assert receipt({"ok": True, "detached": True}, {"ok": True, "detached": False}) == {
        "shioaji": "detached", "futu": "no lease held"}
    assert receipt({"ok": False, "detached": False, "error": "refused"}, RuntimeError("boom")) == {
        "shioaji": "detach failed: refused", "futu": "detach failed: RuntimeError"}


# A late health reading is not a lost client: the lease is renewed on its own cadence. 10-28 17:26 a Windows shadow
# copy held the Shioaji daemon's snapshot file 26 s and 12:18 the Futu /health missed its 0.8 s twice; both clients
# skipped every heartbeat meanwhile, the 20 s lease expired and the next heartbeat answered 503.

def test_an_unread_daemon_health_still_renews_the_held_lease_and_never_attaches_unseen(lease, events):
    lease.attach("d1")
    lease.daemon.calls.clear()
    lease.keep(None)
    assert [path for path, _ in lease.daemon.calls] == ["/v1/client/heartbeat"]
    assert lease.attached and lease.instance_id == "d1"
    assert _rows(events, f"client.{lease.provider}_lease_reattach") == []
    fresh = DaemonLease(provider=lease.provider, client_id="c2", client_name="fastapi", post=lease.daemon.post,
                        component="x", attach_mechanism=f"client.{lease.provider}_daemon_attach",
                        reattach_mechanism=f"client.{lease.provider}_lease_reattach")
    lease.daemon.calls.clear()
    fresh.keep(None)
    assert lease.daemon.calls == [], "no lease is taken from a daemon whose health was not seen"


class _CountingLease:
    def __init__(self, stop, after):
        self.calls: list[tuple[str, object]] = []
        self._stop, self._after = stop, after

    def _record(self, kind, value):
        self.calls.append((kind, value))
        if len(self.calls) >= self._after:
            self._stop()

    def keep(self, instance_id):
        self._record("keep", instance_id)

    def observe(self, instance_id):
        self._record("observe", instance_id)


def test_shioaji_renews_the_lease_while_the_daemon_snapshot_is_late(monkeypatch):
    from service.market.shioaji import daemon_client

    client = daemon_client.MarketDaemonClient(health_ledger=type("L", (), {"set_component_state": lambda *_a, **_k: None})())
    client.HEALTH_POLL_SECONDS = 0.0
    client.HEARTBEAT_SECONDS = 0.0
    client._lease = _CountingLease(lambda: None, after=99)
    polls = []

    def late_snapshot(*_a, **_k):
        polls.append(1)
        if len(polls) >= 3:
            client._running.clear()
        return {"producer": {}, "snapshot_fresh": False, "snapshot_age_seconds": 26.0, "daemon_pid": 4242}

    monkeypatch.setattr(daemon_client, "read_dataflow_snapshot", lambda _path: {})
    monkeypatch.setattr(daemon_client, "assess_passive_health_snapshot", late_snapshot)
    client._running.set()
    client._health_loop()
    assert client._lease.calls == [("keep", None)] * 3
    assert client._stream_last_error == "market daemon passive health snapshot unavailable"


def test_futu_renews_the_lease_when_health_does_not_answer(monkeypatch):
    from service.market.futu import daemon_client

    monkeypatch.setattr(daemon_client, "MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS", 0.001)
    client = daemon_client.MoomooDaemonClient()
    client._lease = _CountingLease(client._stop.set, after=2)
    probes = []

    def unanswered(timeout):
        probes.append(timeout)
        if len(probes) >= 3:
            client._stop.set()

    monkeypatch.setattr(daemon_client, "probe_moomoo_daemon", unanswered)
    client._start_heartbeat()
    client._heartbeat_thread.join(timeout=5)
    assert not client._heartbeat_thread.is_alive()
    assert client._lease.calls[:2] == [("keep", None)] * 2
