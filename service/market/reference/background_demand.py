"""The background list, composed from its owners (user decision).

Rust A is the one subscription-demand owner: it plans what each provider subscribes from the background list
(settings_api's versioned ``background`` domain, which A reloads when its active revision changes), the views open
in windows, the workspace and the focus. A provider only executes that plan. The instruments that must stay
subscribed whatever is on screen reach A through the background list, each tagged with the owners that want it:

* ``watchlist``      -- the product pages (``data/preferences/watch_pages.csv``, Shioaji and Futu pages alike);
* ``holdings``       -- the actual account's positions, TW and US (settings_api follows the ledger's positions feed:
                        the same process serves the account, so no window has to be open for holdings to stay
                        subscribed);
* ``paper_holdings`` -- the paper wallet's positions, the same way (the 模擬庫存 product pages);
* ``paper_orders``   -- every stock with a 模擬下單 order not finished: Rust B matches it on the durable stream, so its
                        ticks and 五檔 must keep coming whatever the screens show (service/account/paper_orders.py);
* ``market_context`` -- 加權指數 and 台指期 as 設定 → 訂閱管理 → 大盤 says (the dashboard header shows them);
* ``sector_index``   -- the 產業指數 (service/market/reference/sector_indexes.py, user 10-19): the indexes of every
                        Shioaji stock the product pages and the two holdings keep, or all of them, or none, as
                        訂閱管理 → 產業指數 says; derived, recomputed with every save.

What each instrument of the product pages and the two holdings is subscribed with follows its 訂閱偏好
(config/subscription_preferences.py): its 明細 (trade) and 五檔 (orderbook), and a Shioaji stock's 個股期貨 months
(futures_contracts.py). An instrument with both off is not listed by these owners (未訂閱). The paper orders always
take both: B matches on them.

``replace_owner`` swaps one owner's instruments and saves a new revision (activated on save, like any background
save) only when the list changes; an instrument leaves the list when its last owner lets go. The provider does not
keep these owner sets itself or subscribe their union beside A's plan -- that made two authorities, a quota A could not see
and a status that did not match what was subscribed. The list is written only by these owners: settings_api's generic
config route does not replace it (api/routes/config_routes.py).
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Iterable, Mapping

from config.config_revisions import ConfigRevisionStore, RevisionConflict
from service.market.reference.sector_indexes import sector_index_items
from service.platform.failure_record import record_failure

_log = logging.getLogger(__name__)

DOMAIN = "background"
OWNERS = ("watchlist", "holdings", "paper_holdings", "paper_orders", "market_context", "sector_index")
# The owners whose instruments follow the 訂閱偏好.
PREFERRED_OWNERS = ("watchlist", "holdings", "paper_holdings")
FULL_KINDS = ["quote", "trade", "orderbook"]
# A Shioaji stock has no quote stream: its 明細 (Tick) and 五檔 (BidAsk).
STOCK_KINDS = ["trade", "orderbook"]
# Futu product-page instruments never took the order book (FutuCapabilities.watchlist_lanes): quote and ticker only.
FUTU_WATCHLIST_KINDS = ["quote", "trade"]
TAIEX = {"source": "shioaji", "market": "IDX", "code": "TAIEX", "kinds": ["quote"]}
# 台指期 on the dashboard: the continuous near month's Quote.
TXFR1 = {"source": "shioaji", "market": "FUT", "code": "TXFR1", "kinds": ["quote"]}
# A (native/market_runtime/src/demand.rs view_reserve_percent) keeps 20% of a provider's streams for what the user is
# looking at; the background list may take the rest (tests/test_subscription_ops.py holds the two to the same number).
BACKGROUND_SHARE_PERCENT = 80
_SAVE_ATTEMPTS = 5
_lock = threading.Lock()


# An index future on a product page without an entry: its near month with 明細 and 五檔, like a stock's default.
INDEX_FUTURES_DEFAULT: dict[str, Any] = {"trade": True, "orderbook": True, "months": []}


def index_futures() -> frozenset[str]:
    """The index futures a product page can hold (futures_contracts.INDEX_FUTURES)."""
    from service.market.reference.futures_contracts import INDEX_FUTURES

    return frozenset(INDEX_FUTURES)


def _key(item: Mapping[str, Any]) -> tuple[str, str, str]:
    return (str(item.get("source") or "").strip().lower(), str(item.get("market") or "").strip().upper(),
            str(item.get("code") or "").strip().upper())


def futu_market(code: str) -> str:
    """A Futu code names its market: US.AAPL -> US, HK.00700 -> HK, CC.BTCUSD -> CC."""
    return code.split(".", 1)[0].upper() if "." in code else ""


def watchlist_items(watch_pages: Path) -> list[dict[str, Any]]:
    """Every product-page instrument, with its source and market."""
    from service.market.reference.watch_page_service import WatchPageService

    if not watch_pages.exists():
        return []
    return watchlist_items_of(WatchPageService(watch_pages).list_pages())


def watchlist_items_of(pages: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The instruments of these product pages (WatchPageService.list_pages), each once."""
    out: dict[tuple[str, str, str], dict[str, Any]] = {}
    for page in pages:
        source = str(page.get("source") or "").strip().lower()
        for row in page.get("items") or ():
            code = str(row.get("code") or "").strip().upper()
            if source == "shioaji" and code in index_futures():
                # An index future (台指期、小台指) is a product with only months: preferred_items lists them.
                item = {"source": "shioaji", "market": "FUT", "code": code, "kinds": STOCK_KINDS}
            elif source == "shioaji" and code:
                item = {"source": "shioaji", "market": "STK", "code": code, "kinds": STOCK_KINDS}
            elif source == "futu" and futu_market(code):
                item = {"source": "futu", "market": futu_market(code), "code": code, "kinds": FUTU_WATCHLIST_KINDS}
            else:
                continue
            out.setdefault(_key(item), item)
    return list(out.values())


US_MARKETS = {"美股", "US", "USA"}


def holdings_items(positions: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The ledger's positions as instruments: a TW position is a Shioaji stock, a US one a Futu US code."""
    out: dict[tuple[str, str, str], dict[str, Any]] = {}
    for position in positions:
        code = str(position.get("code") or "").strip().upper()
        if not code:
            continue
        if str(position.get("market") or "").strip().upper() in US_MARKETS:
            futu_code = code if "." in code else f"US.{code}"
            item = {"source": "futu", "market": futu_market(futu_code), "code": futu_code, "kinds": FULL_KINDS}
        else:
            item = {"source": "shioaji", "market": "STK", "code": code, "kinds": STOCK_KINDS}
        out[_key(item)] = item
    return [out[k] for k in sorted(out)]


def paper_order_items(codes: Iterable[str]) -> list[dict[str, Any]]:
    """The codes of the working paper orders as Shioaji stocks with their ticks and 五檔."""
    return [{"source": "shioaji", "market": "STK", "code": str(code).strip().upper(), "kinds": STOCK_KINDS}
            for code in sorted({str(c).strip().upper() for c in codes if str(c).strip()})]


def _futures_table():
    """Today's futures contract table. One that cannot be read lists no futures month (recorded): the stocks, indexes
    and TXFR1 are listed whatever happened to it."""
    from service.market.reference import futures_contracts

    try:
        return futures_contracts.current_table()
    except Exception as exc:
        record_failure(_log, "reading the futures contract table for the background list", exc)
        return futures_contracts.FuturesTable(())


def futures_items(table: Any, category: str | None, setting: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The months of one futures category to list: the near month and the chosen ones, with the 明細／五檔 chosen."""
    kinds = [k for k in STOCK_KINDS if setting.get(k)]
    if not category or not kinds or not setting.get("on"):
        return []
    return [{"source": "shioaji", "market": "FUT", "code": symbol, "kinds": kinds} for symbol in table.symbols(category, setting.get("months") or ())]


def preferred_items(owned: Iterable[Mapping[str, Any]], prefs: Mapping[str, Any], table: Any) -> list[dict[str, Any]]:
    """An owner's instruments as their 訂閱偏好 say: an instrument with an entry takes its 明細／五檔 (a Futu one keeps
    its quote) and brings its 個股期貨 months; one with both off is left out; one without an entry keeps its owner's
    default kinds."""
    from config.subscription_preferences import instrument_key

    entries = {instrument_key(entry): entry for entry in prefs.get("instruments") or ()}
    out: list[dict[str, Any]] = []
    for item in owned:
        key = _key(item)
        entry = entries.get(key)
        if key[:2] == ("shioaji", "FUT") and key[2] in index_futures():
            # The product is its months: never listed itself (there is no plain TXF to subscribe).
            out.extend(futures_items(table, table.product_category(key[2]), {"on": True, **(entry or INDEX_FUTURES_DEFAULT)}))
            continue
        if entry is None:
            out.append(dict(item))
            continue
        kinds = (["quote"] if key[0] == "futu" else []) + [k for k in STOCK_KINDS if entry.get(k)]
        if kinds:
            out.append({**dict(item), "kinds": kinds})
        if "futures" in entry:
            out.extend(futures_items(table, table.stock_category(key[2]), entry["futures"]))
    return out


def market_context_items(prefs: Mapping[str, Any], table: Any) -> list[dict[str, Any]]:
    """訂閱管理 → 大盤: 加權指數 and 台指期's TXFR1 Quote (期貨走勢). TXF's months are the TXF product's."""
    items = [dict(TAIEX)] if prefs.get("taiex") else []
    if prefs.get("txf"):
        items.append(dict(TXFR1))
    return items


def sector_items(items: Iterable[Mapping[str, Any]], prefs: Mapping[str, Any]) -> list[dict[str, Any]]:
    """訂閱管理 → 產業指數: none, the indexes of the stocks listed, or every one."""
    from config import tw_industry_indexes

    sector = prefs.get("sector") or {}
    if not sector.get("enabled"):
        return []
    if sector.get("scope") == "all":
        return [{"source": "shioaji", "market": "IDX", "code": code, "kinds": ["quote"]}
                for code in tw_industry_indexes.all_index_codes() if code != "IX0001"]
    return sector_index_items(items)


def merge(items: Iterable[Mapping[str, Any]], owner: str, owned: Iterable[Mapping[str, Any]],
          enabled: Any = lambda source: True) -> list[dict[str, Any]]:
    """The list after `owner` holds exactly `owned`: its claim leaves every other instrument, an instrument with no
    owner left leaves the list. Each owner's claim -- the kinds it wants -- is kept per owner (`claims`), and the
    instrument's kinds are their union, so one owner's change (五檔 off) is never held back by the kinds another owner
    claimed earlier. `owners` is the claims' owners (what Market Runtime shows). Items of a disabled source are not
    listed (settings_api refuses them)."""
    if owner not in OWNERS:
        raise ValueError(f"unknown background owner {owner!r}")
    claims: dict[tuple[str, str, str], dict[str, list[str]]] = {}
    for item in items:
        kept = {o: list(kinds) for o, kinds in (item.get("claims") or {}).items() if o != owner and o in OWNERS}
        if kept:
            claims[_key(item)] = kept
    for item in owned:
        key = _key(item)
        if not all(key) or not enabled(key[0]):
            continue
        claims.setdefault(key, {})[owner] = list(item.get("kinds") or FULL_KINDS)
    merged = []
    for key in sorted(claims):
        by_owner = dict(sorted(claims[key].items()))
        wanted = {kind for kinds in by_owner.values() for kind in kinds}
        merged.append({"source": key[0], "market": key[1], "code": key[2], "kinds": [k for k in FULL_KINDS if k in wanted],
                       "owners": list(by_owner), "claims": by_owner})
    return merged


def compose(current: Iterable[Mapping[str, Any]], owned: Mapping[str, Iterable[Mapping[str, Any]]],
            prefs: Mapping[str, Any], table: Any, enabled: Any = lambda source: True) -> list[dict[str, Any]]:
    """The list after each owner of `owned` holds its instruments -- a preferred owner's as its 訂閱偏好 say, the
    market context as 大盤 says (its value is ignored: it is derived from the preferences) -- and the sector indexes
    follow the stocks listed then."""
    items = list(current)
    for owner, raw in owned.items():
        if owner == "market_context":
            raw = market_context_items(prefs, table)
        elif owner in PREFERRED_OWNERS:
            raw = preferred_items(raw, prefs, table)
        items = merge(items, owner, raw, enabled=enabled)
    return merge(items, "sector_index", sector_items(items, prefs), enabled=enabled)


def shioaji_streams(items: Iterable[Mapping[str, Any]]) -> int:
    """The Shioaji streams a list takes: each instrument the streams of its kinds in its market (the same capability
    the provider registers with A as its stream budget)."""
    from service.market.shared.provider_contract import SHIOAJI_CAPABILITIES, SHIOAJI_LANE_KINDS

    costs = SHIOAJI_CAPABILITIES.kinds_by_market(SHIOAJI_LANE_KINDS)
    return sum(sum(costs.get(market, {}).get(kind, 0) for kind in item.get("kinds") or FULL_KINDS)
               for item in items for (source, market, _code) in [_key(item)] if source == "shioaji")


def futu_streams(items: Iterable[Mapping[str, Any]]) -> int:
    """The OpenD subscriptions a list takes: each instrument the subscriptions of its kinds in its market (報價 two --
    QUOTE and RT_DATA --, 明細 and 五檔 one each; the capability the Futu provider registers with A)."""
    from service.market.shared.provider_contract import FUTU_CAPABILITIES, FUTU_LANE_KINDS

    costs = FUTU_CAPABILITIES.kinds_by_market(FUTU_LANE_KINDS)
    return sum(sum(costs.get(market, {}).get(kind, 0) for kind in item.get("kinds") or FULL_KINDS)
               for item in items for (source, market, _code) in [_key(item)] if source == "futu")


def futu_background_capacity(streams: int) -> int:
    """The OpenD subscriptions the background list may take of ``streams`` (OpenD's quota for this connection), less
    the share A keeps for views."""
    return int(streams) * BACKGROUND_SHARE_PERCENT // 100


def shioaji_background_capacity() -> int:
    """The streams the background list may take: every connection's together, less the share A keeps for views."""
    from config import broker_connection_settings

    settings = broker_connection_settings.shioaji()
    return int(settings["connections"]) * int(settings["per_connection_limit"]) * BACKGROUND_SHARE_PERCENT // 100


def save_list(config_root: Path, build: Any, *, source: str, summary: str) -> dict[str, Any]:
    """Save a new active background revision of ``build(current items)``, retried on a concurrent save; an unchanged
    list saves none."""
    from config.background_list import validate_background

    store = ConfigRevisionStore(config_root, DOMAIN)
    with _lock:
        for _ in range(_SAVE_ATTEMPTS):
            latest = store.latest()
            current = list(((latest or {}).get("values") or {}).get("items") or [])
            items = build(current)
            if latest is not None and items == current:
                return {"ok": True, "changed": False, "revision": latest.get("revision"), "items": len(items)}
            try:
                doc = store.save({"items": items}, expected_revision=(latest or {}).get("revision"), source=source,
                                 summary=summary, activate=True, validator=validate_background)
            except RevisionConflict:  # not an error: another owner saved in between: merged into that revision on the next pass
                continue
            return {"ok": True, "changed": True, "revision": doc["revision"], "items": len(items)}
    return {"ok": False, "error": "REVISION_CONFLICT", "message": f"background list kept changing; {source} not saved"}


def items_in_effect(config_root: Path, start: Any, end: Any) -> list[dict[str, Any]]:
    """Every instrument the background list held at some moment in [start, end) (aware datetimes): each save of this
    domain activates its revision (save_list), so a revision was in effect from its creation until the next one's.
    Each instrument once, as the latest of those revisions listed it."""
    from datetime import datetime

    store = ConfigRevisionStore(config_root, DOMAIN)
    committed = sorted(store.history(limit=1_000_000), key=lambda r: int(r["revision"]))
    spans = [(row, datetime.fromisoformat(str(row["created_at"])),
              datetime.fromisoformat(str(committed[n + 1]["created_at"])) if n + 1 < len(committed) else None)
             for n, row in enumerate(committed)]
    out: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row, since, until in spans:
        if since >= end or (until is not None and until <= start):
            continue
        for item in ((store.get(int(row["revision"])) or {}).get("values") or {}).get("items") or ():
            out[_key(item)] = dict(item)
    return [out[k] for k in sorted(out)]


def replace_owners(config_root: Path, owned: Mapping[str, Iterable[Mapping[str, Any]]], *, summary: str,
                   prefs: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """One active background revision in which each owner of `owned` holds its instruments (compose)."""
    from config import subscription_preferences
    from config.source_settings import source_enabled

    owned = {owner: list(raw) for owner, raw in owned.items()}
    prefs = subscription_preferences.active(config_root) if prefs is None else prefs
    table = _futures_table()
    return save_list(config_root, lambda current: compose(current, owned, prefs, table, enabled=source_enabled),
                     source=f"background:{'+'.join(owned)}", summary=summary)


def replace_owner(config_root: Path, owner: str, owned: Iterable[Mapping[str, Any]], *, summary: str) -> dict[str, Any]:
    """Save a new active background revision in which `owner` holds exactly `owned`. Unchanged: no new revision."""
    return replace_owners(config_root, {owner: owned}, summary=summary)


def refresh_fixed_owners(config_root: Path, watch_pages: Path) -> dict[str, Any]:
    """The owners settings_api can read itself: the product pages and the market context (startup, a futures
    contract table refresh, which moves the near months on)."""
    return replace_owners(config_root, {"market_context": (), "watchlist": watchlist_items(watch_pages)},
                          summary="product pages and market context")
