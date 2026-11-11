"""A remote trade change, the ledger rebuild and the phone's publish are one operation. The
answer is ok only when the rebuild is complete, and an incomplete ledger is never published to the phone."""
from __future__ import annotations

import threading
from types import SimpleNamespace

from service.account.actual_account_sync import ActualAccountSync


def _sync(rebuild_errors: int):
    published = []
    svc = ActualAccountSync.__new__(ActualAccountSync)
    svc.ledger = SimpleNamespace(replace_raw_trades=lambda items: {"errors": rebuild_errors, "rows": len(items)},
                                 _set_meta_many=lambda *a, **k: None, get_summary=lambda: {}, _lock=threading.RLock())
    svc.publisher = SimpleNamespace(schedule_mobile_publish=lambda reason, delay_minutes, ledger_signature=None: published.append(reason),
                                    get_mobile_publish_status=lambda: {"due": bool(published)})
    svc._gas_request = lambda action, *a, **k: {"items": [{"trade_id": "t1"}], "next_offset": None, "raw_revision": 1} if action == "actualRawTrades" else {"ok": True}

    def no_bridge(**_k):
        raise RuntimeError("no bridge")

    svc.get_gas_bridge_status = no_bridge
    return svc, published


def test_an_incomplete_rebuild_is_not_published_and_a_complete_one_is():
    svc, published = _sync(rebuild_errors=2)
    result = svc._sync_from_gas_locked(bridge_status_before=None, sync_source="manual", publish_reason="desktop_trade_update")
    assert result["ok"] is False and published == []
    svc, published = _sync(rebuild_errors=0)
    result = svc._sync_from_gas_locked(bridge_status_before=None, sync_source="manual", publish_reason="desktop_trade_update")
    assert result["ok"] is True and published == ["desktop_trade_update"]


def test_a_saved_trade_with_an_incomplete_ledger_is_not_ok():
    svc = ActualAccountSync.__new__(ActualAccountSync)
    sent = []
    svc._gas_request = lambda action, payload=None, **k: sent.append((action, payload)) or {"ok": True, "trade_id": "t9"}
    svc.sync_from_gas = lambda **k: {"ok": False, "error": "帳務重建有 1 筆錯誤", "mobile_publish": None}
    result = svc.remote_save_trade({"code": "2330", "action": "賣出"})
    assert sent == [("actualTradeCreate", {"trade": {"code": "2330", "action": "賣出"}})], "the trade's action stays the trade's"
    assert (result["ok"], result["remote_applied"], result["error"]) == (False, True, "帳務重建有 1 筆錯誤")
    svc.sync_from_gas = lambda **k: {"ok": True, "mobile_publish": {"due": True}}
    assert svc.remote_delete_trade("t9")["ok"] is True


def test_a_saved_trade_stays_applied_when_what_follows_fails():
    """The sheet has the change; a rebuild that raises is answered, not lost. No second request touches the
    revision: GAS raised it with the change."""
    svc = ActualAccountSync.__new__(ActualAccountSync)
    actions = []

    def gas(action, *a, **k):
        actions.append(action)
        return {"ok": True, "trade_id": "t9", "raw_revision": 12}

    def broken_sync(**_k):
        raise RuntimeError("sheet read timed out")

    svc._gas_request = gas
    svc.sync_from_gas = broken_sync
    result = svc.remote_delete_trade("t9")
    assert result["remote_applied"] is True and result["ok"] is False
    assert "sheet read timed out" in result["error"]
    assert result["remote"]["raw_revision"] == 12 and actions == ["actualTradeDelete"]
