"""The keep-alive contract between the provider daemons' HTTP servers and DaemonHttpTransport.

uvicorn closes a connection idle for its keep-alive (5 s by default) while the Futu lease heartbeat reused its pooled
connection every 5 s: a request sent in the same few milliseconds as the server's close was reset
(ConnectionResetError / ConnectionAbortedError), and each one was a recorded `client.futu_lease_reattach`. The client
now closes first -- it never reuses a connection idle for DAEMON_CLIENT_IDLE_SECONDS -- and both daemon servers keep
idle connections open longer than that, so the server's close has nothing to race. A heartbeat that still fails is
recorded with the OS error under it."""
from __future__ import annotations

import asyncio
import socket
import sys
import threading
import time
from pathlib import Path

import pytest
import requests
import urllib3

from service.market.futu.daemon_settings import MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS
from service.market.shared import daemon_transport
from service.market.shared.daemon_lease import DaemonLease, exception_chain
from service.market.shioaji.daemon_settings import MARKET_DAEMON_CLIENT_HEARTBEAT_SECONDS
from service.platform import remediation

ROOT = Path(__file__).resolve().parents[1]
# The server's keep-alive in the race test, short so the test runs in seconds; what matters is the client's idle time
# landing on it within the few milliseconds the race needs.
KEEP_ALIVE = 0.3


def test_both_daemon_servers_keep_idle_connections_longer_than_the_client_reuses_them():
    assert daemon_transport.DAEMON_SERVER_KEEP_ALIVE_SECONDS > daemon_transport.DAEMON_CLIENT_IDLE_SECONDS
    # Each lease heartbeat finds its connection still open, so a heartbeat never opens a connection either.
    assert daemon_transport.DAEMON_CLIENT_IDLE_SECONDS > max(MOOMOO_DAEMON_CLIENT_HEARTBEAT_SECONDS,
                                                             MARKET_DAEMON_CLIENT_HEARTBEAT_SECONDS)
    source = (ROOT / "backend/shared/provider_main.py").read_text(encoding="utf-8")
    assert "timeout_keep_alive=DAEMON_SERVER_KEEP_ALIVE_SECONDS" in source


@pytest.fixture
def server():
    import uvicorn
    from fastapi import FastAPI

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    app = FastAPI()

    @app.post("/v1/client/heartbeat")
    def heartbeat(body: dict):
        return {"ok": True}

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    instance = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                             access_log=False, timeout_keep_alive=KEEP_ALIVE))
    thread = threading.Thread(target=instance.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not instance.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert instance.started
    yield port
    instance.should_exit = True
    thread.join(timeout=5)


def test_a_connection_idle_for_the_server_keep_alive_is_never_reused(server, monkeypatch):
    monkeypatch.setattr(daemon_transport, "authorization_headers", lambda: {})
    monkeypatch.setattr(daemon_transport, "DAEMON_CLIENT_IDLE_SECONDS", KEEP_ALIVE / 2, raising=False)
    failures: list[str] = []
    lock = threading.Lock()

    def client(index: int) -> None:
        transport = daemon_transport.DaemonHttpTransport("127.0.0.1", server)
        for _ in range(3):
            # Idle times across the server's keep-alive, -12 .. +12 ms: the window where its close and the next
            # request cross (measured: about +-12 ms on this machine; outside it the client sees the close first).
            for offset_ms in range(-12, 13, 2):
                transport.post("/v1/client/heartbeat", json_body={})
                time.sleep(KEEP_ALIVE + offset_ms / 1000.0 + index * 0.0002)
                try:
                    transport.post("/v1/client/heartbeat", json_body={})
                except daemon_transport.DaemonTransportError as exc:
                    with lock:
                        failures.append(f"{offset_ms:+d} ms: {exception_chain(exc)}")

    workers = [threading.Thread(target=client, args=(index,)) for index in range(16)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    assert failures == []


def test_a_pooled_connection_is_reused_until_the_client_idle_limit(monkeypatch):
    monkeypatch.setattr(daemon_transport, "DAEMON_CLIENT_IDLE_SECONDS", 10.0)
    pool = daemon_transport._DaemonAdapter().poolmanager.connection_from_url("http://127.0.0.1:1")
    assert isinstance(pool, daemon_transport._IdleRetiringPool)
    conn = pool._get_conn()
    conn.sock = socket.socket()  # stands for an open connection; is_connection_dropped reads it
    pool._put_conn(conn)
    monkeypatch.setattr(urllib3.connectionpool, "is_connection_dropped", lambda _conn: False)
    again = pool._get_conn()
    assert again is conn and again.sock is not None, "idle under the limit: reused as is"
    pool._put_conn(again)
    conn.idle_since -= 10.0
    retired = pool._get_conn()
    assert retired is conn and retired.sock is None, "idle at the limit: closed, reopened on its next request"


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


class ProviderError(RuntimeError):
    """A provider client's error: a fixed message, the transport error as its cause."""


def test_a_failed_heartbeat_is_recorded_with_the_os_error_under_it(events):
    def post(path, body, timeout):
        if path == "/v1/client/heartbeat":
            reset = ConnectionResetError(10054, "reset")
            try:
                try:
                    raise requests.ConnectionError(urllib3.exceptions.ProtocolError("Connection aborted.", reset)) from reset
                except requests.ConnectionError as exc:
                    raise daemon_transport.DaemonTransportError("無法連線到 daemon", classification="NETWORK_UNREACHABLE") from exc
            except daemon_transport.DaemonTransportError as exc:
                raise ProviderError("無法連線到 daemon") from exc
        return {"ok": True, "lease_id": "lease-1", "daemon_instance_id": "d1"}

    lease = DaemonLease(provider="futu", client_id="c1", client_name="fastapi", post=post, component="futu_client",
                        attach_mechanism="client.futu_daemon_attach", reattach_mechanism="client.futu_lease_reattach")
    lease.attach("d1")
    lease.keep("d1")
    started = [e for e in events if e["mechanism_id"] == "client.futu_lease_reattach" and e["outcome"] == "started"]
    assert len(started) == 1 and started[0]["trigger_reason"] == "heartbeat_failed"
    cause = started[0]["detail"]["cause"]
    assert cause.startswith("ProviderError <- DaemonTransportError <- ConnectionError"), cause
    assert "ConnectionResetError[10054]" in cause, cause
