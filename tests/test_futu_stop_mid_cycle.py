"""The provider's stop closes the OpenD context from its own thread while the worker may be mid-cycle. A step that
starts after that runs on a closed context: a full close would re-subscribe every pair right after the logout, each
failure logged as a subscribe retry."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from service.market.futu import opend_lifecycle as futu
from service.market.futu.service import FutuMarketService


def futu_service(tmp_path, monkeypatch, context):
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "security.csv"))
    svc = FutuMarketService(tmp_path / "futu.db", event_sink=MagicMock())
    svc._opend.context_generation = 42
    svc.advance_context_generation = lambda value: value
    svc._opend.sdk = SimpleNamespace(RET_OK=0, SubType=SimpleNamespace(
        QUOTE="QUOTE", RT_DATA="RT_DATA", TICKER="TICKER", ORDER_BOOK="ORDER_BOOK"))
    svc._opend.sdk.OpenQuoteContext = lambda **kwargs: context
    monkeypatch.setattr(svc.opend_lifecycle, "load_sdk", lambda: svc._opend.sdk)
    monkeypatch.setattr(svc.opend_lifecycle, "install_push_handlers", lambda context: None)
    monkeypatch.setattr(futu, "_opend_port_reachable", lambda *args, **kwargs: True)
    svc.poll_seconds = 0.0
    return svc


def _ready_context():
    context = MagicMock()
    context.status = "READY"
    return context


def test_a_stop_during_a_cycle_runs_no_later_step(tmp_path, monkeypatch):
    svc = futu_service(tmp_path, monkeypatch, _ready_context())
    synced = []

    def stop_now(_context):
        # What FutuMarketService.stop() does from the daemon's thread: flag the stop, then close the context.
        svc._stop.set()
        svc.opend_lifecycle.close_context()

    monkeypatch.setattr(svc.security_master, "refresh_if_needed", stop_now)
    monkeypatch.setattr(svc.session_lifecycle, "tick", lambda: synced.append("session_lifecycle"))
    monkeypatch.setattr(svc.opend_lifecycle, "sync_context", lambda context: synced.append("subscription_sync") or {"ok": True})
    svc.opend_lifecycle.run()
    assert synced == []
    assert svc.operation_state.get("subscription_sync") is None


def test_a_live_context_runs_every_step(tmp_path, monkeypatch):
    svc = futu_service(tmp_path, monkeypatch, _ready_context())
    ran = []
    monkeypatch.setattr(svc.security_master, "refresh_if_needed", lambda context: ran.append("security_master"))
    monkeypatch.setattr(svc.session_lifecycle, "tick", lambda: ran.append("session_lifecycle"))

    def sync(context):
        ran.append("subscription_sync")
        svc._stop.set()
        return {"ok": True}

    monkeypatch.setattr(svc.opend_lifecycle, "sync_context", sync)
    svc.opend_lifecycle.run()
    assert ran == ["security_master", "session_lifecycle", "subscription_sync"]
