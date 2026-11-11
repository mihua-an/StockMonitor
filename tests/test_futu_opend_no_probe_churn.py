"""While a quote context is open, OpenD liveness comes from the context's own state, never from a TCP probe.

2026-10-15: a connect/close probe on every 0.2 s cycle (~17k per hour) made OpenD's API listener stop accepting
after ~44k of them; KeepAlive then failed, the context was lost and no reconnect could ever succeed.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from service.market.futu import opend_lifecycle as futu
from service.market.futu.service import FutuMarketService


def futu_service(tmp_path, monkeypatch):
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "security.csv"))
    svc = FutuMarketService(tmp_path / "futu.db", event_sink=MagicMock())
    svc._opend.context_generation = 42
    svc.advance_context_generation = lambda value: value
    svc._opend.sdk = SimpleNamespace(RET_OK=0, SubType=SimpleNamespace(
        QUOTE="QUOTE", RT_DATA="RT_DATA", TICKER="TICKER", ORDER_BOOK="ORDER_BOOK"))
    svc._opend.sdk.OpenQuoteContext = lambda **kwargs: context_holder["context"]
    monkeypatch.setattr(svc.opend_lifecycle, "load_sdk", lambda: svc._opend.sdk)
    monkeypatch.setattr(svc.opend_lifecycle, "install_push_handlers", lambda context: None)
    monkeypatch.setattr(svc.opend_lifecycle, "run_operation", lambda name, step: True)
    svc.poll_seconds = 0.0
    return svc


context_holder: dict = {}


def test_connected_cycles_open_no_probe_connections(tmp_path, monkeypatch):
    svc = futu_service(tmp_path, monkeypatch)
    context = MagicMock()
    context.status = "READY"
    context_holder["context"] = context
    probes = []
    monkeypatch.setattr(futu, "_opend_port_reachable", lambda *args, **kwargs: probes.append(1) or True)
    cycles = []
    real_wait = svc._wake.wait

    def wait(timeout=None):
        cycles.append(1)
        if len(cycles) >= 50:
            svc._stop.set()
        return real_wait(0)
    monkeypatch.setattr(svc._wake, "wait", wait)
    svc.opend_lifecycle.run()
    assert len(cycles) >= 50
    assert len(probes) == 1   # the one check before opening the context, none per cycle


def test_context_that_left_ready_is_treated_as_lost(tmp_path, monkeypatch):
    svc = futu_service(tmp_path, monkeypatch)
    context = MagicMock()
    context.status = "WAIT_RECONNECT"
    context_holder["context"] = context
    monkeypatch.setattr(futu, "_opend_port_reachable", lambda *args, **kwargs: True)
    monkeypatch.setattr(svc._stop, "wait", lambda timeout=None: svc._stop.set())
    svc.opend_lifecycle.run()
    assert "stopped answering (quote context WAIT_RECONNECT)" in svc._opend.last_error
    context.close.assert_called()
