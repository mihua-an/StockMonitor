"""Checks a provider repeats every cycle must not redo work whose inputs have not moved."""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from service.market.futu import security_master as sm
from service.market.lifecycle import rollover


class _CountingRows(list):
    walked = 0

    def __iter__(self):
        type(self).walked += 1
        return super().__iter__()


def test_the_master_refresh_check_does_not_walk_unchanged_rows(tmp_path: Path):
    path = tmp_path / "security_master.csv"
    path.write_text("x", encoding="utf-8")
    catalog = SimpleNamespace(security_master_path=path, read_security_master=lambda: [], write_security_master=lambda rows: None)
    lifecycle = sm.FutuSecurityMasterLifecycle(path=path, lock=threading.RLock(), catalog=catalog, sdk_provider=lambda: None,
                                               call=lambda *a, **k: None, worker_alive=lambda: True, wake=lambda: None)
    lifecycle.rows = _CountingRows([{"market": "US", "type": "STOCK"}, {"market": "US", "type": "ETF"}])
    lifecycle.market_counts = {"cc": 1}
    lifecycle.updated_at = datetime.now(timezone.utc).isoformat()
    for _ in range(5):
        assert lifecycle.refresh_due() is False
    assert _CountingRows.walked == 1


def test_newly_listed_codes_are_looked_for_only_when_an_input_moved(monkeypatch):
    from service.market.history import history_fill

    calls, revision = [], {"now": 7}
    monkeypatch.setattr(history_fill, "background_list_revision", lambda: revision["now"])
    monkeypatch.setattr(history_fill, "listed_without_partition", lambda *a, **k: calls.append(a) or [])
    owner = SimpleNamespace(_ledger=SimpleNamespace(fill_settled_newest=lambda: [{"key_id": "k", "market": "STK", "trading_date": "2026-11-09", "session": "DAY"}],
                                                    fill_candidates=lambda: []),
                            _newly_listed_checked=None)
    find = next(v for k, v in vars(rollover).items() if isinstance(v, type) and hasattr(v, "_sessions_with_newly_listed_codes"))._sessions_with_newly_listed_codes
    for _ in range(4):
        assert find(owner) == []
    assert len(calls) == 1, "nothing moved: the list's history is not read again"
    revision["now"] = 8
    find(owner)
    assert len(calls) == 2, "the list changed: looked at once more"


def test_the_watch_list_is_read_once_until_it_is_saved(tmp_path: Path, monkeypatch):
    from service.market.futu.store import FutuControlStore

    store = FutuControlStore(tmp_path / "control.db")
    store.initialize_schema()
    opened = []
    real = store.read_session
    monkeypatch.setattr(store, "read_session", lambda: opened.append(1) or real())
    first = store.watchlist_rows()
    first.append({"code": "changed by a caller"})
    assert store.watchlist_rows() == [] and len(opened) == 1, "kept, and a caller's copy is its own"
    store._watchlist = None
    store.watchlist_rows()
    assert len(opened) == 2
