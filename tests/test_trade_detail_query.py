"""The trade-detail pages are Market Runtime's (`trades.page`): the API forwards the request and returns its answer.

What the pages hold -- the WAL index, the materialized partitions, the tape rule -- is tested with Market Runtime
(native/market_runtime/src/trade_pages.rs, tests/e2e_trade_pages.rs). Here: the forward itself, and that the API
process no longer reads the WAL or parses a partition (that held its GIL for seconds at every start).
"""
from __future__ import annotations

import ast
from pathlib import Path

from service.market.history import trade_detail_query

ROOT = Path(__file__).resolve().parents[1]


class FakeClient:
    sent: list[dict] = []

    def trade_page(self, payload):
        FakeClient.sent.append(payload)
        return {"ok": True, "rows": [{"durable_sequence": 9}], "coverage": "WAL", "total_rows": 1}


def test_a_page_is_market_runtimes_answer_to_the_normalized_request(monkeypatch):
    FakeClient.sent = []
    monkeypatch.setattr(trade_detail_query, "RustViewClient", FakeClient)
    answer = trade_detail_query.trade_page(market="stk", code="2330", trading_date="2026-11-04T00:00", session="day",
                                           page=0, page_size=500, snapshot_watermark=-3, before_sequence=12, metadata_only=True)
    assert answer == {"ok": True, "rows": [{"durable_sequence": 9}], "coverage": "WAL", "total_rows": 1}
    assert FakeClient.sent == [{"market": "STK", "code": "2330", "trading_date": "2026-11-04", "session": "DAY", "page": 1,
                                "page_size": 100, "snapshot_watermark": 0, "before_sequence": 12, "metadata_only": True}]


def test_the_api_reads_no_wal_and_parses_no_partition_for_the_pages():
    for gone in ("service/market/history/wal_trade_index.py", "service/market/history/futures_trades.py"):
        assert not (ROOT / gone).exists(), gone
    tree = ast.parse((ROOT / "service/market/history/trade_detail_query.py").read_text(encoding="utf-8"))
    imported = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    imported |= {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    assert imported <= {"__future__", "typing", "service.market.shared.rust_view_client"}, imported
