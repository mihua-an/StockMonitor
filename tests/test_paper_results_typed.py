"""B's result records are checked whole against their type's fields before anything changes (R14-22): an unknown
type, a missing or mistyped field is quarantined, never half-applied or ignored. Inside the desk shares are int and
prices 1/10_000 integers; display numbers only in the answers (R14-21)."""
from __future__ import annotations

import json

from tests.support.paper_desk import append_results, make_desk, read_commands


def _quarantined(desk):
    path = desk.root / "results.quarantine.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []


def test_bad_results_are_quarantined_and_change_nothing(tmp_path):
    desk, _ledger, _clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100", "qty": 3000})["order"]["order_id"]
    append_results(desk,
            {"type": "teleported", "id": "x1", "order_id": oid},
            {"type": "fill", "id": "x2", "order_id": oid, "qty": 1000},                       # no price
            {"type": "fill", "id": "x3", "order_id": oid, "qty": 1000.5, "price": 1_000_000},  # half a share
            {"type": "done", "id": "x4", "order_id": oid, "state": "vanished"})
    desk.poll()
    errors = [q["error"] for q in _quarantined(desk)]
    assert len(errors) == 4
    assert "unknown result type 'teleported'" in errors[0] and "has no price" in errors[1]
    assert "whole number" in errors[2] and "state is one of" in errors[3]
    view = desk.view(oid)
    assert (view["state"], view["filled"], view["fills"]) == ("submitted", 0, [])


def test_shares_and_prices_stay_integers_inside(tmp_path):
    desk, _ledger, _clock = make_desk(tmp_path)
    oid = desk.place({"code": "2330", "side": "買進", "price": "100.5", "qty": 2000})["order"]["order_id"]
    assert read_commands(desk)[0]["qty"] == 2000 and isinstance(read_commands(desk)[0]["qty"], int)
    append_results(desk, {"type": "fill", "id": "f1", "order_id": oid, "qty": 1000.0, "price": 1_005_000, "exchange_ts_ns": 0,
                   "trading_date": "2026-10-16"})
    desk.poll()
    order = desk._orders[oid]
    assert order["filled"] == 1000 and isinstance(order["filled"], int)
    assert order["fills"][0]["price_scaled"] == 1_005_000 and "price" not in order["fills"][0]
    view = desk.view(oid)
    assert (view["filled"], view["unfilled"], view["avg_price"], view["fills"][0]["price"]) == (1000, 1000, 100.5, 100.5)
