"""The paper desk and ledger keep one consistent version: a matching result is applied or kept aside (never skipped),
fills the ledger refuses wait and are recorded, closing reports a poll still running, placing an order holds the
ledger's write lock across its money check, a ledger write of any kind advances the ledger revision the dashboard is
keyed by, and the trades a caller asks for are selected in SQL."""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime

from service.account import paper_orders
from tests.support.paper_desk import TPE, append_results, make_desk


def _ts() -> int:
    return int(datetime(2026, 10, 16, 10, 0, 5, tzinfo=TPE).timestamp() * 1e9)


def _fill(oid: str, n: int, **override) -> dict:
    return {"type": "fill", "id": f"{oid}-F{n}", "order_id": oid, "code": "2330", "side": "buy", "qty": 1000.0, "price": 1_000_000,
            "exchange_ts_ns": _ts(), "trading_date": "2026-10-16", **override}


def test_a_result_that_cannot_be_used_is_kept_aside_and_the_rest_still_applies(tmp_path):
    desk, ledger, _clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 3000})["order"]["order_id"]
    append_results(desk, _fill(oid, 1))
    with open(desk.root / "results.jsonl", "ab") as fh:
        fh.write(b"{not json\n")
        fh.write((json.dumps({k: v for k, v in _fill(oid, 2).items() if k != "qty"}) + "\n").encode())
    append_results(desk, _fill(oid, 3))
    desk.poll()
    assert desk.view(oid)["filled"] == 2000, "the good results on both sides of the bad ones are applied"
    kept = [json.loads(line) for line in (desk.root / "results.quarantine.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [k["line"][:9] for k in kept] == ["{not json", '{"type": '] and all(k["error"] for k in kept)
    assert desk.view(oid)["fills"] and len(desk.view(oid)["fills"]) == 2, "a record missing its quantity changed nothing"
    assert [(t["trade_id"], t["qty"]) for t in ledger.get_raw_trades(limit=10)] == [(oid, 2000)], "one order, one trade of its good fills"


def test_fills_the_ledger_refuses_wait_and_are_one_recorded_recovery(tmp_path, monkeypatch):
    events = []

    class Emitter:
        def begin(self, **fields):
            events.append(("begin", fields["mechanism_id"], fields["trigger_reason"]))
            return type("Op", (), {"finish": lambda _self, outcome, **kw: events.append(("finish", outcome, kw.get("attempt")))})()

    import service.platform.remediation as remediation
    monkeypatch.setattr(remediation, "emitter", lambda: Emitter())
    desk, ledger, _clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})["order"]["order_id"]
    append_results(desk, _fill(oid, 1))
    real = ledger.local_input.import_matched_orders
    calls = []

    def refuse(rows):
        calls.append(len(rows))
        raise OSError("disk full")

    monkeypatch.setattr(ledger.local_input, "import_matched_orders", refuse)
    desk.poll()
    desk.poll()
    desk.poll()
    assert calls == [1], "no retry before the wait is over (no 0.2 s storm)"
    desk._import_retry_at = 0.0
    desk.poll()
    assert calls == [1, 1] and desk._import_retry_wait == 2 * paper_orders.IMPORT_RETRY_FIRST_S, "the wait doubles"
    monkeypatch.setattr(ledger.local_input, "import_matched_orders", real)
    desk._import_retry_at = 0.0
    desk.poll()
    assert [t["trade_id"] for t in ledger.get_raw_trades(limit=10)] == [oid]
    assert events == [("begin", "account.paper_fill_import_retry", "ledger_write_failed"), ("finish", "succeeded", 2)]


def test_close_reports_a_poll_that_is_still_running(tmp_path, monkeypatch):
    desk, _ledger, _clock = make_desk(tmp_path)
    inside, release = threading.Event(), threading.Event()

    def stuck():
        inside.set()
        release.wait(5)
        return False

    monkeypatch.setattr(desk, "poll", stuck)
    monkeypatch.setattr(paper_orders, "POLL_INTERVAL_S", 0.01)
    desk.start()
    assert inside.wait(2)
    assert desk.close(timeout=0.1) is False
    assert desk._thread is not None, "the handle is kept while the thread may still write"
    release.set()
    assert desk.close(timeout=2) is True and desk._thread is None


def test_placing_an_order_holds_the_ledger_write_lock_across_its_check(tmp_path):
    desk, ledger, _clock = make_desk(tmp_path)
    placed = []
    with ledger.write_lock:
        worker = threading.Thread(target=lambda: placed.append(desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 1000})))
        worker.start()
        time.sleep(0.2)
        assert not placed, "no order is checked against the ledger while a ledger write holds it"
    worker.join(5)
    assert placed and placed[0]["ok"]


def test_every_ledger_write_advances_the_revision_and_the_dashboard_follows(tmp_path):
    _desk_, ledger, _clock = make_desk(tmp_path)
    first = ledger.get_dashboard()
    revision = ledger.ledger_revision()
    assert ledger.get_dashboard() is first, "nothing changed: the cached dashboard"
    ledger.save_capital_settings({"markets": {"台股": {"daily_limit": "123456"}}})
    assert ledger.ledger_revision() > revision
    assert ledger.get_dashboard() is not first, "a settings write is a new dashboard, whatever the file's mtime says"


def test_the_trades_asked_for_are_selected_by_the_ledger(tmp_path):
    desk, ledger, clock = make_desk(tmp_path)
    for n, day in enumerate(("2026-10-14", "2026-10-15", "2026-10-16"), start=1):
        ledger.local_input.import_matched_orders([{"order_id": f"T{n}", "trade_date": day, "code": "2330", "action": "買進",
                                                   "fills": [{"qty": 1000, "price": 100}], "trade_time": "10:00:00", "reasons": []}])
    assert [t["trade_id"] for t in ledger.get_raw_trades(None, start="2026-10-15", end="2026-10-15")] == ["T2"]
    assert {t["trade_id"] for t in ledger.get_raw_trades(None, trade_ids=["T1", "T3", "missing"])} == {"T1", "T3"}
    assert [t["trade_id"] for t in ledger.get_raw_trades(None, after="2026-10-14")] == ["T3", "T2"]
    assert ledger.get_raw_trades(None, trade_ids=[]) == []
    # 交割款 lists exactly the trades not settled by the desk's day (T+2): 10-15 and 10-16 on 10-16.
    pending = desk.funds()["capital"]["pending"]
    assert sorted(t["trade_id"] for row in pending for t in row["trades"]) == ["T2", "T3"]
