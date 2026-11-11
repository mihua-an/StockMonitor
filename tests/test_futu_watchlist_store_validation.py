"""A rejected Futu watchlist write must never be the destructive half of DELETE-then-INSERT.

``FutuControlStore.replace_watchlist`` validated every requested code against the local
security master and then ran ``DELETE FROM watchlist`` regardless of the outcome. Two
consequences, both silent data loss in LIVE:

* an empty security master (fresh install, or a failed master refresh -- ``known_codes()``
  returns an empty set whenever the master CSV is missing) rejected *every* code, so the
  user's very first watchlist could never be saved at all;
* any fully rejected non-empty request wiped whatever was already persisted, because the
  DELETE ran before the (empty) INSERT.

``FutuMarketService.pollable_watch_codes`` already carries the empty-master bootstrap
tolerance, so that behaviour is the codebase's own intent -- this store just did not follow
it. Validation with a populated master is deliberately unchanged.
"""
from __future__ import annotations

from service.market.futu.store import FutuControlStore


def _store(tmp_path):
    store = FutuControlStore(tmp_path / "futu_market.db")
    store.initialize_schema()
    return store


def _rows(store):
    return [(row["code"], row["sort_order"]) for row in store.watchlist_rows()]


def _replace(store, codes, known):
    rejected: list[list[str]] = []
    requested = [(code, code, index, "2026-09-27T00:00:00.000+00:00") for index, code in enumerate(codes)]
    returned = store.replace_watchlist(
        requested,
        known_codes_snapshot=lambda: set(known),
        report_rejected=rejected.append,
    )
    return returned, (rejected[-1] if rejected else [])


def test_an_empty_security_master_does_not_reject_the_first_watchlist(tmp_path):
    store = _store(tmp_path)

    returned, rejected = _replace(store, ["US.AAPL", "CC.BTCUSD"], known=set())

    assert _rows(store) == [("US.AAPL", 0), ("CC.BTCUSD", 1)]
    assert [row[0] for row in returned] == ["US.AAPL", "CC.BTCUSD"]
    assert rejected == []


def test_a_fully_rejected_request_keeps_the_persisted_watchlist(tmp_path):
    store = _store(tmp_path)
    _replace(store, ["US.AAPL", "US.TSLA"], known={"US.AAPL", "US.TSLA"})

    returned, rejected = _replace(store, ["US.NOPE"], known={"US.AAPL", "US.TSLA"})

    assert _rows(store) == [("US.AAPL", 0), ("US.TSLA", 1)], "the 商品列 was emptied by a rejected write"
    assert [row[0] for row in returned] == ["US.AAPL", "US.TSLA"]
    assert rejected == ["US.NOPE"]


def test_a_populated_master_still_rejects_unknown_additions(tmp_path):
    store = _store(tmp_path)
    _replace(store, ["US.AAPL", "US.TSLA"], known={"US.AAPL", "US.TSLA"})

    returned, rejected = _replace(store, ["US.AAPL", "US.MU", "US.NOPE"], known={"US.AAPL", "US.MU", "US.TSLA"})

    # US.MU is in the master so it is added; US.NOPE is not and is rejected; US.TSLA was
    # simply not requested, which is an ordinary removal.
    assert _rows(store) == [("US.AAPL", 0), ("US.MU", 1)]
    assert [row[0] for row in returned] == ["US.AAPL", "US.MU"]
    assert rejected == ["US.NOPE"]


def test_a_persisted_code_survives_a_master_that_no_longer_lists_it(tmp_path):
    store = _store(tmp_path)
    _replace(store, ["US.AAPL", "US.TSLA"], known={"US.AAPL", "US.TSLA"})

    returned, rejected = _replace(store, ["US.AAPL", "US.TSLA"], known={"US.AAPL"})

    assert _rows(store) == [("US.AAPL", 0), ("US.TSLA", 1)]
    assert [row[0] for row in returned] == ["US.AAPL", "US.TSLA"]
    assert rejected == []


def test_clearing_the_watchlist_on_purpose_still_clears_it(tmp_path):
    store = _store(tmp_path)
    _replace(store, ["US.AAPL"], known={"US.AAPL"})

    returned, rejected = _replace(store, [], known={"US.AAPL"})

    assert _rows(store) == []
    assert returned == []
    assert rejected == []


def test_a_request_of_only_malformed_codes_is_refused_not_a_clear():
    # Malformed codes were dropped before the store saw them, so a non-empty request of only malformed codes
    # reached it as "clear the list". They are rejections now, and such a request changes nothing.
    import threading
    from types import SimpleNamespace

    from service.market.futu.service import FutuMarketService

    svc = FutuMarketService.__new__(FutuMarketService)
    svc._lock = threading.RLock()
    svc._last_watchlist_rejected_codes = []
    svc.product_catalog = SimpleNamespace(watchlist=lambda: [{"code": "US.AAPL"}])
    calls = []
    svc.control_store = SimpleNamespace(replace_watchlist=lambda *a, **k: calls.append(a) or [])
    svc._canonical_futu_code = lambda code: (_ for _ in ()).throw(ValueError(code))
    assert svc.replace_watchlist([{"code": "???"}, {"code": ""}]) == [{"code": "US.AAPL"}]
    assert calls == [], "the store is never asked to replace the list"
    assert svc.last_watchlist_rejected_codes() == ["???", "<empty>"]
