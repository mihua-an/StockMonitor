"""The product pages and 訂閱偏好 written by batches of operations (service/market/reference/subscription_ops.py),
the background list they make, and the provider plans that follow its kinds (docs/system-architecture/06 section 2)."""
from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from config import storage_settings, subscription_preferences
from config.config_revisions import ConfigRevisionStore
from service.market.reference import background_demand as bd
from service.market.reference import futures_contracts as fc
from service.market.reference.subscription_ops import SubscriptionState, reorder
from service.market.reference.watch_page_service import WatchPageService

ROOT = Path(__file__).resolve().parents[1]


def month(category: str, ym: str, underlying: str = "", unit: int = 2000) -> fc.FuturesMonth:
    return fc.FuturesMonth(code=f"{category}{ym[-2:]}X", symbol=f"{category}{ym}", category=category, name=category,
                           underlying_code=underlying, unit=unit, delivery_month=ym, delivery_date=f"{ym[:4]}-{ym[4:]}-15")


TABLE = fc.FuturesTable([month("TXF", "202611"), month("TXF", "202612"), month("TXF", "202701"),
                         month("CDF", "202611", "2330"), month("CDF", "202612", "2330"), month("QFF", "202611", "2330", unit=100)])


class FakeCatalog:
    """The product catalog's two reads SubscriptionState uses (ProductCatalogService.metadata / with_metadata)."""

    def __init__(self, names: dict[tuple[str, str], str]) -> None:
        self.names = names

    def metadata(self, source: str, code: str) -> dict[str, str]:
        return {"name": self.names.get((source, code), ""), "industry_name": "", "market": "", "type": ""}

    def with_metadata(self, pages):
        return [{**page, "items": [{**item, **self.metadata(item.get("source") or page.get("source"), item["code"])}
                                   for item in page.get("items") or ()]} for page in pages]


@pytest.fixture
def state(tmp_path, monkeypatch):
    monkeypatch.setattr("config.source_settings.source_enabled", lambda source: True)
    monkeypatch.setattr(bd, "_futures_table", lambda: TABLE)
    monkeypatch.setattr("service.market.reference.sector_indexes._master", lambda: {})
    monkeypatch.setattr("config.broker_connection_settings.shioaji",
                        lambda config_root=None: {"connections": 1, "per_connection_limit": 20, "revision": None})
    pages = tmp_path / "watch_pages.csv"
    WatchPageService(pages).save_pages([
        {"id": "p1", "name": "台股", "source": "shioaji", "items": [{"code": "2330"}, {"code": "2317"}]},
        {"id": "p2", "name": "美股", "source": "futu", "items": [{"code": "US.AAPL"}]},
    ])
    holdings: list[dict] = []
    return SimpleNamespace(state=SubscriptionState(tmp_path / "config", pages, {"holdings": lambda: holdings,
                                                                                "paper_holdings": lambda: []},
                                                     catalog=FakeCatalog({("shioaji", "2603"): "長榮"})),
                           holdings=holdings, config=tmp_path / "config", pages=pages)


def items_of(s) -> dict[str, dict]:
    latest = ConfigRevisionStore(s.config, "background").latest()
    return {i["code"]: i for i in latest["values"]["items"]}


def page_codes(result, page_id="p1"):
    return [i["code"] for i in next(p for p in result["pages"] if p["id"] == page_id)["items"]]


def ops(batch_id, *operations):
    return {"batch_id": batch_id, "client": "test", "ops": list(operations)}


# ------------------------------------------------------------------ last-writer per field, never a whole overwrite
def test_two_windows_adding_to_one_page_both_keep_their_items(state):
    a = state.state.apply(ops("a", {"op": "item.add", "page_id": "p1", "code": "2454", "after_code": "2317"},
                              {"op": "item.add", "page_id": "p1", "code": "2603", "after_code": "2454"}))
    assert a["ok"]
    # Window B loaded the page before A saved, and adds 2603 (also A's) and 3008.
    b = state.state.apply(ops("b", {"op": "item.add", "page_id": "p1", "code": "2603", "after_code": "2317"},
                              {"op": "item.add", "page_id": "p1", "code": "3008", "after_code": "2603"}))
    assert page_codes(b) == ["2330", "2317", "2454", "2603", "3008"]


def test_an_order_sorts_only_what_both_have_and_never_brings_back_a_removed_item():
    assert reorder(["A", "B", "N", "C"], ["C", "B", "A", "GONE"]) == ["C", "B", "N", "A"]
    assert reorder([], ["A"]) == []


def test_a_batch_sent_twice_is_applied_once_and_a_bad_one_writes_nothing(state):
    first = state.state.apply(ops("same", {"op": "item.remove", "page_id": "p1", "code": "2317"}))
    revision = first["revision"]
    again = state.state.apply(ops("same", {"op": "item.add", "page_id": "p1", "code": "2317"}))
    assert again["duplicate"] and again["revision"] == revision and page_codes(again) == ["2330"]
    bad = state.state.apply(ops("bad", {"op": "item.add", "page_id": "p1", "code": "1101"}, {"op": "nope"}))
    assert bad["error"] == "INVALID_OPERATION"
    assert page_codes(state.state.snapshot()) == ["2330"], "the batch's first operation was not written either"
    skipped = state.state.apply(ops("skip", {"op": "item.alert", "page_id": "p1", "code": "9999", "lower": "1", "upper": ""}))
    assert skipped["ok"] and skipped["skipped"] == [{"index": 0, "op": "item.alert", "reason": "ITEM_NOT_FOUND"}]


def test_a_damaged_page_file_is_refused_never_overwritten(state):
    state.pages.write_bytes(b"pgid,name\r\na,b\r\n")
    refused = state.state.apply(ops("x", {"op": "page.rename", "page_id": "p1", "name": "x"}))
    assert refused["error"] == "WATCH_PAGES_UNREADABLE"
    assert state.pages.read_bytes() == b"pgid,name\r\na,b\r\n"


# ------------------------------------------------------------------ preferences reach the background list
def test_the_detail_and_book_switches_set_each_instruments_kinds(state):
    state.state.apply(ops("1", {"op": "instrument.set", "source": "shioaji", "market": "STK", "code": "2330", "field": "orderbook", "value": False},
                          {"op": "instrument.set", "source": "shioaji", "market": "STK", "code": "2317", "field": "trade", "value": False},
                          {"op": "instrument.set", "source": "shioaji", "market": "STK", "code": "2317", "field": "orderbook", "value": False},
                          {"op": "instrument.set", "source": "futu", "market": "US", "code": "US.AAPL", "field": "trade", "value": False}))
    items = items_of(state)
    assert items["2330"]["kinds"] == ["trade"]
    assert "2317" not in items, "both off: on its page, not subscribed (未訂閱)"
    assert items["US.AAPL"]["kinds"] == ["quote"], "Futu keeps its 報價＋分時"
    # A holding takes the same one setting.
    state.holdings.append({"market": "台股", "code": "2330"})
    state.state.apply(ops("2", {"op": "page.rename", "page_id": "p1", "name": "台股2"}))
    assert items_of(state)["2330"]["owners"] == ["holdings", "watchlist"] and items_of(state)["2330"]["kinds"] == ["trade"]


def test_the_odd_lots_switch_lists_the_product_pages_stocks_odd_lots_as_spare(state):
    # User 11-14: the product pages' stocks keep their 盤中零股 from before the open, only into the room left.
    def odd(items):
        return {code[4:]: i for code, i in ((f"{i['market']}:{i['code']}", i) for i in items.values()) if code.startswith("ODD:")}

    latest = lambda: {f"{i['market']}:{i['code']}": i for i in ConfigRevisionStore(state.config, "background").latest()["values"]["items"]}
    assert state.state.snapshot()["preferences"]["odd_lots"] is False, "off by default"
    used_before = state.state.apply(ops("0", {"op": "page.rename", "page_id": "p1", "name": "x"}))["quota"]["shioaji"]["used"]
    result = state.state.apply(ops("1", {"op": "odd_lots.set", "value": True}))
    assert result["ok"] and result["preferences"]["odd_lots"] is True
    items = latest()
    assert sorted(k for k in items if k.startswith("ODD:")) == ["ODD:2317", "ODD:2330"], "the Shioaji page's stocks, no Futu"
    assert items["ODD:2330"]["spare"] is True and items["ODD:2330"]["kinds"] == ["trade", "orderbook"]
    assert items["ODD:2330"]["owners"] == ["odd_lots"] and "spare" not in items["STK:2330"]
    quota = result["quota"]["shioaji"]
    assert quota["used"] == used_before and quota["spare"] == {"instruments": 2, "streams": 4}, "never against the share"
    # A paper order's own odd-lot claim makes it no spare: B matches on it.
    bd.replace_owner(state.config, "paper_orders", bd.paper_order_items([("2330", True)]), summary="t")
    assert "spare" not in latest()["ODD:2330"] and latest()["ODD:2330"]["owners"] == ["odd_lots", "paper_orders"]
    bd.replace_owner(state.config, "paper_orders", [], summary="t")
    # Off: the odd lots leave the list.
    state.state.apply(ops("2", {"op": "odd_lots.set", "value": False}))
    assert not any(k.startswith("ODD:") for k in latest())
    refused = state.state.apply(ops("3", {"op": "odd_lots.set", "value": "yes"}))
    assert refused["ok"] is False


def test_a_switch_holds_for_a_stock_several_owners_keep(state):
    # 2330 on a page and in the holdings, both claiming 明細＋五檔; then 五檔 off: no owner's earlier claim keeps it.
    state.holdings.append({"market": "台股", "code": "2330"})
    state.state.apply(ops("1", {"op": "page.rename", "page_id": "p1", "name": "x"}))
    assert items_of(state)["2330"]["claims"] == {"holdings": ["trade", "orderbook"], "watchlist": ["trade", "orderbook"]}
    state.state.apply(ops("2", {"op": "instrument.set", "source": "shioaji", "market": "STK", "code": "2330", "field": "orderbook", "value": False}))
    assert items_of(state)["2330"]["kinds"] == ["trade"]
    from service.market.reference import background_demand as bd_module

    # The paper orders' own claim still brings the book back: B matches on it.
    bd_module.replace_owner(state.config, "paper_orders", bd_module.paper_order_items([("2330", False)]), summary="t")
    assert items_of(state)["2330"]["kinds"] == ["trade", "orderbook"]


def test_stock_futures_list_the_near_month_and_the_chosen_ones(state):
    result = state.state.apply(ops("1", {"op": "instrument.set", "source": "shioaji", "market": "STK", "code": "2330", "field": "futures", "value": True},
                                   {"op": "instrument.month", "code": "2330", "month": "202612", "on": True},
                                   {"op": "instrument.month", "code": "2330", "month": "202611", "on": False}))
    assert result["skipped"] == [{"index": 2, "op": "instrument.month", "reason": "NEAR_MONTH_ALWAYS_ON"}]
    items = items_of(state)
    assert items["CDF202611"]["kinds"] == ["trade", "orderbook"] and "CDF202612" in items, "the standard contract (largest unit) first"
    assert "QFF202611" not in items
    refused = state.state.apply(ops("2", {"op": "instrument.set", "source": "shioaji", "market": "STK", "code": "2317", "field": "futures", "value": True}))
    assert refused["skipped"][0]["reason"] == "NO_STOCK_FUTURES"


def test_the_market_context_is_taiex_and_txfr1_only(state):
    state.state.apply(ops("1", {"op": "page.rename", "page_id": "p1", "name": "x"}))
    items = items_of(state)
    assert items["TXFR1"]["kinds"] == ["quote"] and items["TAIEX"]["kinds"] == ["quote"]
    assert not any(code.startswith("TXF2") for code in items), "TXF's months are the TXF product's, not 大盤's"
    state.state.apply(ops("2", {"op": "context.set", "field": "txf", "value": False}, {"op": "context.set", "field": "taiex", "value": False}))
    assert not {"TXFR1", "TAIEX"} & set(items_of(state))
    refused = state.state.apply(ops("3", {"op": "context.set", "field": "txf_trade", "value": True}))
    assert refused["error"] == "INVALID_OPERATION", "大盤 has no TXF 明細／五檔 any more"


def test_an_index_future_on_a_page_lists_its_months_as_its_own_setting_says(state):
    state.state.apply(ops("1", {"op": "item.add", "page_id": "p1", "code": "TXF"}))
    items = items_of(state)
    assert items["TXF202611"]["kinds"] == ["trade", "orderbook"] and items["TXF202611"]["owners"] == ["watchlist"]
    assert "TXF" not in items and "TXF202612" not in items, "the product itself is never listed, only its near month"
    state.state.apply(ops("2", {"op": "instrument.set", "source": "shioaji", "market": "FUT", "code": "TXF", "field": "orderbook", "value": False},
                          {"op": "instrument.month", "code": "TXF", "month": "202701", "on": True}))
    items = items_of(state)
    assert items["TXF202611"]["kinds"] == ["trade"] and items["TXF202701"]["kinds"] == ["trade"] and "TXF202612" not in items
    rows = {r["code"]: r for r in state.state.snapshot()["instruments"]}
    assert rows["TXF"]["market"] == "FUT" and rows["TXF"]["orderbook"] is False and rows["TXF"]["listed"]
    assert rows["TXF"]["index_futures"] == {"months": ["202701"], "months_listed": ["202611", "202612", "202701"]}
    assert "futures" not in rows["TXF"]
    assert state.state.snapshot()["index_futures"] == {"TXF": {"name": "台指期", "months": ["202611", "202612", "202701"]}}
    refused = state.state.apply(ops("3", {"op": "instrument.set", "source": "shioaji", "market": "FUT", "code": "TXF", "field": "futures", "value": True}))
    assert refused["error"] == "INVALID_OPERATION", "an index future has no 個股期貨 switch"
    state.state.apply(ops("4", {"op": "item.remove", "page_id": "p1", "code": "TXF"}))
    assert not any(code.startswith("TXF2") for code in items_of(state))
    assert [e["code"] for e in state.state.snapshot()["preferences"]["instruments"]] == [], "its setting left with it"


def test_preferences_leave_with_their_instrument(state):
    state.state.apply(ops("1", {"op": "instrument.set", "source": "shioaji", "market": "STK", "code": "2317", "field": "orderbook", "value": False}))
    state.state.apply(ops("2", {"op": "item.remove", "page_id": "p1", "code": "2317"}))
    prefs = state.state.snapshot()["preferences"]
    assert [e["code"] for e in prefs["instruments"]] == [], "added back, 2317 starts from the defaults"


def test_expired_months_leave_the_preferences_when_the_table_moves_on(state, monkeypatch):
    state.state.apply(ops("1", {"op": "item.add", "page_id": "p1", "code": "TXF"},
                          {"op": "instrument.month", "code": "TXF", "month": "202612", "on": True}))
    later = fc.FuturesTable([month("TXF", "202612"), month("TXF", "202701")])
    monkeypatch.setattr(bd, "_futures_table", lambda: later)
    assert state.state.follow_futures_table()["ok"]
    txf = lambda: next(e for e in state.state.snapshot()["preferences"]["instruments"] if e["code"] == "TXF")  # noqa: E731
    assert txf()["months"] == ["202612"]
    monkeypatch.setattr(bd, "_futures_table", lambda: fc.FuturesTable([month("TXF", "202701")]))
    state.state.follow_futures_table()
    assert txf()["months"] == [], "202612 expired"
    assert "TXF202701" in items_of(state), "the near month moved on"


def test_a_saved_txf_of_the_old_shape_is_read_as_its_txfr1_switch():
    saved = {**subscription_preferences.defaults(), "txf": {"on": False, "trade": True, "orderbook": False, "months": []}}
    read = subscription_preferences.read(saved)
    assert read["txf"] is False and subscription_preferences.validate(read) == []


# ------------------------------------------------------------------ quota
def test_a_batch_past_the_background_share_is_refused_whole(state):
    # 1 connection x 20 x 80% = 16 streams. Listed now: 2330, 2317 (2 each), TAIEX, TXFR1 = 6.
    adds = [{"op": "item.add", "page_id": "p1", "code": str(1101 + i)} for i in range(6)]
    refused = state.state.apply(ops("big", *adds))
    assert refused["error"] == "QUOTA_EXCEEDED" and set(refused["quota_over"]) == {"shioaji"}
    assert (refused["quota_over"]["shioaji"]["used"], refused["quota_over"]["shioaji"]["limit"]) == (18, 16)
    assert page_codes(state.state.snapshot()) == ["2330", "2317"], "nothing written"
    # Turning a book off makes room for one more: allowed.
    ok = state.state.apply(ops("fit", *adds[:5]))
    assert ok["ok"] and ok["quota"]["shioaji"]["used"] == 16


def _futu_state(state, opend):
    return SubscriptionState(state.config, state.pages, {"holdings": lambda: state.holdings, "paper_holdings": lambda: []},
                             catalog=FakeCatalog({}), futu_quota=lambda: opend)


def test_futu_is_checked_against_the_background_share_of_opend_quota_by_type(state):
    # OpenD says 10 for this connection: the list may take 8. US.AAPL (報價＋分時＋明細) takes 3 now.
    opend = {"ok": True, "known": True, "streams": 10, "total": 12, "used_by_others": 2, "held": 3,
             "draining": [{"code": "US.TSLA", "lane": "QUOTE"}, {"code": "US.TSLA", "lane": "RT_DATA"}], "waiting": []}
    s = _futu_state(state, opend)
    assert s.apply(ops("list", {"op": "page.rename", "page_id": "p2", "name": "美股"}))["ok"]
    futu = s.snapshot()["quota"]["futu"]
    assert (futu["base"], futu["trade"], futu["orderbook"], futu["used"]) == (2, 1, 0, 3)
    assert (futu["known"], futu["limit"], futu["streams"], futu["used_by_others"], futu["draining"]) == (True, 8, 10, 2, 2)
    adds = [{"op": "item.add", "page_id": "p2", "code": code} for code in ("US.NVDA", "US.TSM")]
    preview = s.apply({"ops": adds}, preview=True)
    assert preview["quota_exceeded"] and preview["quota_over"]["futu"]["used"] == 9 and preview["quota"]["futu"]["used"] == 9
    refused = s.apply(ops("futu-big", *adds))
    assert refused["error"] == "QUOTA_EXCEEDED" and "富途訂閱會用到 9 個" in refused["message"] and "找富途調高額度" in refused["message"]
    assert page_codes(s.snapshot(), "p2") == ["US.AAPL"], "nothing written"
    assert s.apply(ops("futu-fit", adds[0]))["ok"], "US.NVDA fits: 6 of 8"


def test_futu_is_not_checked_while_opend_has_not_said_its_quota(state):
    s = _futu_state(state, {"ok": False, "error": "FUTU_PROVIDER_UNAVAILABLE"})
    assert s.apply(ops("list", {"op": "page.rename", "page_id": "p2", "name": "美股"}))["ok"]
    futu = s.snapshot()["quota"]["futu"]
    assert futu["known"] is False and futu["limit"] is None and futu["used"] == 3
    adds = [{"op": "item.add", "page_id": "p2", "code": f"US.S{i}"} for i in range(5)]
    assert s.apply(ops("futu-unknown", *adds))["ok"], "no quota to check against: not refused on a guess"


def test_a_preview_answers_the_quota_and_rows_without_writing(state):
    before = state.state.snapshot()
    preview = state.state.apply({"ops": [{"op": "instrument.set", "source": "shioaji", "market": "STK", "code": "2330",
                                          "field": "orderbook", "value": False},
                                         {"op": "item.add", "page_id": "p1", "code": "2454"}]}, preview=True)
    assert preview["ok"] and preview["preview"]
    shioaji = preview["quota"]["shioaji"]
    assert (shioaji["trade"], shioaji["orderbook"], shioaji["index"], shioaji["futures"]) == (3, 2, 1, 1)
    rows = {r["code"]: r for r in preview["instruments"]}
    assert rows["2330"]["orderbook"] is False and rows["2454"]["pages"] == ["p1"]
    after = state.state.snapshot()
    assert after["revision"] == before["revision"] and page_codes(after) == ["2330", "2317"], "nothing written"
    assert state.state.apply({"ops": [{"op": "item.add", "page_id": "p1", "code": str(1101 + i)} for i in range(8)]},
                             preview=True)["quota_exceeded"]


def test_the_rows_say_why_each_instrument_is_listed_and_its_futures(state):
    state.holdings.append({"market": "台股", "code": "2603"})
    state.holdings.append({"market": "美股", "code": "NOK"})
    rows = {r["code"]: r for r in state.state.snapshot()["instruments"]}
    assert rows["2330"]["owners"] == ["watchlist"] and rows["2330"]["futures"]["category"] == "CDF"
    assert rows["2330"]["futures"]["months_listed"] == ["202611", "202612"] and "futures" not in rows["2317"]
    assert rows["2603"]["owners"] == ["holdings"] and rows["2603"]["pages"] == []
    assert rows["US.AAPL"]["orderbook"] is False and rows["US.NOK"]["orderbook"] is True, "a Futu holding keeps its book"


def test_the_background_share_is_the_one_a_keeps_for_views():
    source = (ROOT / "native/market_runtime/src/demand.rs").read_text(encoding="utf-8")
    reserve = int(re.search(r"view_reserve_percent: (\d+), next_generation", source).group(1))
    assert bd.BACKGROUND_SHARE_PERCENT == 100 - reserve


def test_the_preferences_are_validated_whole():
    assert subscription_preferences.validate(subscription_preferences.defaults()) == []
    bad = {**subscription_preferences.defaults(), "txf": "yes", "instruments": [
        {"source": "shioaji", "market": "FUT", "code": "TXF", "trade": True, "orderbook": True, "months": ["2026-12"]},
        {"source": "shioaji", "market": "FUT", "code": "CDF", "trade": True, "orderbook": True, "months": []}]}
    problems = subscription_preferences.validate(bad)
    assert {"TXF", "FUTURES_MONTHS", "INSTRUMENT"} <= {p["code"] for p in problems}
    assert any("CDF is not an index future" in p["message"] for p in problems)
    futu_futures = {**subscription_preferences.defaults(), "instruments": [
        {"source": "futu", "market": "US", "code": "US.AAPL", "trade": True, "orderbook": False,
         "futures": {"on": True, "trade": True, "orderbook": True, "months": []}}]}
    assert subscription_preferences.validate(futu_futures), "only a Shioaji stock has 個股期貨"


# ------------------------------------------------------------------ futures contract table
def test_the_table_keeps_dated_unexpired_months_by_symbol():
    # The fields of Shioaji 1.7.2's futures info (its dict(), as in ~/.shioaji/contracts-v2-1.7/TW-FUT-info).
    class Info:
        def __init__(self, **fields):
            self.fields = {"contract_size": 2000.0, "name": "臺股期貨", "underlying_code": "IX0001", **fields}

        def dict(self):
            return self.fields

    months, skipped = fc.rows_from_contracts([
        Info(code="TXFR1", root="TXF", delivery_month="202611", delivery_date="2026-11-18"),
        Info(code="TXFK6", root="TXF", delivery_month="202611", delivery_date="2026-11-18"),
        Info(code="TXFJ6", root="TXF", delivery_month="202610", delivery_date="2026-10-21"),
        Info(code="CDFK6", root="CDF", delivery_month="202611", delivery_date="2026-11-18", underlying_code="2330"),
        Info(code="", root="X", delivery_month="", delivery_date=""),
    ], today=date(2026, 11, 1))
    assert {m.symbol: m.code for m in months}["TXF202611"] == "TXFK6", "named <root><YYYYMM>, subscribed by its code"
    assert [m.symbol for m in months] == ["CDF202611", "TXF202611"] and skipped == 1
    table = fc.FuturesTable(months)
    assert table.stock_category("2330") == "CDF" and table.symbols("TXF", ["202612"]) == ["TXF202611"]


def test_the_table_file_round_trips_and_a_damaged_one_is_never_empty(tmp_path):
    path = tmp_path / "futures_contracts.csv"
    assert fc.load_table(path).by_symbol == {}, "not written yet"
    fc.write_table(path, TABLE.by_symbol.values())
    assert set(fc.load_table(path).by_symbol) == set(TABLE.by_symbol)
    path.write_text("code,symbol\nX,Y\n", encoding="utf-8")
    with pytest.raises(ValueError):
        fc.load_table(path)


# ------------------------------------------------------------------ providers follow the kinds
def test_shioaji_subscribes_only_the_lanes_of_the_kinds_planned():
    from service.market.shioaji.subscriptions import ShioajiSubscriptionManager

    manager = ShioajiSubscriptionManager(subscription_limit=10, futures_table=lambda: TABLE)
    refused = manager.replace_plan([{"market": "STK", "code": "2330", "kinds": ["trade"]},
                                    {"market": "FUT", "code": "TXF202612", "kinds": ["trade", "orderbook"]},
                                    {"market": "FUT", "code": "TXF209912", "kinds": ["trade"]},
                                    {"market": "FUT", "code": "TXFR1", "kinds": ["quote"]},
                                    {"market": "STK", "code": "2317", "kinds": ["quote"]}])
    assert refused == {("FUT", "TXF209912"): "UNSUPPORTED_INSTRUMENT", ("STK", "2317"): "UNSUPPORTED_KINDS"}
    keys = sorted(i.key for i in manager.desired_identities())
    assert keys == ["FUT:TXF202612:BidAsk", "FUT:TXF202612:Tick", "FUT:TXFR1:Quote", "STK:2330:Tick:regular"]


def test_futu_takes_its_ticker_and_book_as_the_kinds_say():
    from service.market.futu.subscriptions import FutuSubscriptionManager

    manager = FutuSubscriptionManager.__new__(FutuSubscriptionManager)
    import threading
    from service.market.shared.provider_contract import FUTU_CAPABILITIES

    manager.capabilities, manager._lock, manager._plan, manager._market_of = FUTU_CAPABILITIES, threading.Lock(), {}, {}
    manager.replace_plan([{"market": "US", "code": "US.AAPL", "kinds": ["quote"]},
                          {"market": "US", "code": "US.TSM", "kinds": ["quote", "orderbook"]}])
    assert manager.planned() == {("US", "US.AAPL"): ("QUOTE", "RT_DATA"), ("US", "US.TSM"): ("QUOTE", "RT_DATA", "ORDER_BOOK")}


def test_a_futures_tick_is_published_under_its_month_symbol_with_the_reference_it_states():
    from service.market.shioaji.callback import ShioajiThinCallbackAdapter

    published = []
    owner = SimpleNamespace(price_scale=10000, _session_generation=1, TXF_CODE="TXFR1",
                            subscription_manager=SimpleNamespace(futures_table=lambda: TABLE),
                            event_sink=SimpleNamespace(publish=lambda e: published.append(e) or True),
                            delivery_evidence=SimpleNamespace(observe=lambda *a, **k: None), note_market_event=lambda m: None,
                            _int_value=lambda v: int(v or 0))
    adapter = ShioajiThinCallbackAdapter(owner)
    # 2026-11-02 15:30 Taipei: the night session that opened that day.
    tick = SimpleNamespace(code="TXF12X", datetime=datetime(2026, 11, 2, 15, 30), close=23000, volume=2, total_volume=10,
                           tick_type=1, price_chg=10, simtrade=False)
    adapter.on_futures_tick(None, tick)
    assert len(published) == 1
    event = published[0]
    assert (event.market, event.code) == ("FUT", "TXF202612")
    assert event.exchange_ts_ns == int(datetime(2026, 11, 2, 15, 30, tzinfo=ZoneInfo("Asia/Taipei")).timestamp() * 1_000_000_000)
    # The tick names no partition: Market Runtime files it (a NIGHT opened that day) by this time, and writes the 昨收
    # it states (close - price_chg) as a Reference of that partition.
    assert not {"trading_date", "session"} & set(event.as_dict())
    assert event.data["stated_prev_close"] == (23000 - 10) * 10000
    adapter.on_futures_tick(None, SimpleNamespace(**{**tick.__dict__, "code": "UNKNOWN"}))
    assert len(published) == 1 and adapter.invalid_required == {"futures.tick.code": 1}


# ------------------------------------------------------------------ 資料儲存 → 要儲存哪些
def test_the_kept_categories_are_shioajis_and_named_whole():
    keep = {c: True for c in storage_settings.CATEGORIES}
    values = {"sources": {"shioaji": {"persist": True, "retention_days": 3, "keep": keep}, "futu": {"persist": False, "retention_days": None}}}
    assert storage_settings.validate_retention(values) == []
    values["sources"]["shioaji"]["keep"] = {"index": True}
    assert storage_settings.validate_retention(values)[0]["code"] == "KEEP"
    values["sources"]["shioaji"]["keep"] = keep
    values["sources"]["futu"]["keep"] = keep
    assert storage_settings.validate_retention(values)[0]["code"] == "KEEP"
    rust = (ROOT / "native/market_runtime/src/storage.rs").read_text(encoding="utf-8")
    assert re.findall(r'\(Category::\w+, "(\w+)"\)', rust) == list(storage_settings.CATEGORIES), "the same names in A"
