"""The actual-account sync stores the last attempt and the last complete success separately; status shows both
and the screen shows the success."""
from __future__ import annotations

import pytest

from tests.support.actual_sync import BUY, actual_service


def _status(ledger):
    return ledger.get_status()


def test_complete_sync_sets_attempt_and_success(tmp_path, monkeypatch):
    ledger, _calls = actual_service(tmp_path, monkeypatch, items=[BUY])
    try:
        assert ledger.sync_service.sync_from_gas()["ok"] is True
        status = _status(ledger)
        assert status["last_sync_attempt_status"] == "ok"
        assert status["last_sync_attempt_at"] and status["last_sync_success_at"]
        assert status["last_sync_success_at"] >= status["last_sync_attempt_at"]
        assert ledger.get_summary()["last_sync_success_at"] == status["last_sync_success_at"]
    finally:
        ledger.shutdown()


def test_incomplete_sync_records_the_attempt_but_not_a_success(tmp_path, monkeypatch):
    # A sell beyond the holding is a short (先賣) and syncs completely, so a rebuild that records errors is forced: what
    # is tested is the stored status after one, not a way to produce it.
    ledger, _calls = actual_service(tmp_path, monkeypatch, items=[BUY])
    rebuild = ledger.replace_raw_trades
    monkeypatch.setattr(ledger, "replace_raw_trades", lambda items: {**rebuild(items), "errors": 1})
    try:
        assert ledger.sync_service.sync_from_gas()["ok"] is False
        status = _status(ledger)
        assert status["last_sync_attempt_status"] == "incomplete"
        assert "帳務重建" in status["last_sync_attempt_error"]
        assert status["last_sync_success_at"] == ""
    finally:
        ledger.shutdown()


def test_a_failed_fetch_keeps_the_previous_success(tmp_path, monkeypatch):
    ledger, _calls = actual_service(tmp_path, monkeypatch, items=[BUY])
    try:
        ledger.sync_service.sync_from_gas()
        success = _status(ledger)["last_sync_success_at"]

        def broken(action, payload=None, *, write=False):
            raise RuntimeError("socket error at C:/secret/path")

        monkeypatch.setattr(ledger.sync_service, "_gas_request", broken)
        with pytest.raises(RuntimeError):
            ledger.sync_service.sync_from_gas()
        status = _status(ledger)
        assert status["last_sync_success_at"] == success
        assert status["last_sync_attempt_status"] == "failed"
        # Third-party exception text stays in the log, not in the stored status.
        assert "secret" not in status["last_sync_attempt_error"]
    finally:
        ledger.shutdown()
