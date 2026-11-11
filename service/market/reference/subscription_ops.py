"""The product pages and the 訂閱偏好, changed by batches of operations (``POST /api/subscriptions/ops``).

settings_api is their one writer (AGENTS.md section 4): 設定 → 訂閱管理 and every 商品頁設定 window send what they
changed, never the whole list, and each operation is applied to the list as it is now -- so two windows editing at
once both keep their changes, and the same field changed by both is the later one's (decisions.md
訂閱清單在兩個地方管理). There is no revision to send and no conflict to answer.

A batch ``{batch_id, client, ops}`` is applied under one lock: read the product pages (watch_pages.csv) and the
preferences, apply every operation, check the Shioaji streams the background list would then take, and only then
write both and save the background list they make, in one revision. A batch over the background share of the
Shioaji connections is refused whole (QUOTA_EXCEEDED, with the streams used and the limit) and nothing is written;
a batch that does not add streams is never refused for a list already over (a lowered limit). A batch id already
applied is answered with the state as it is, applied again never.

The operations (each one field or one membership; an operation that names something no longer there is skipped and
reported, the rest of the batch applies):

* ``page.add`` page_id, name, source, after -- an id already there is left as it is.
* ``page.remove`` page_id. ``page.rename`` page_id, name.
* ``page.order`` page_ids -- only the pages both the window and the list have are put in that order, in the places
  they hold; a page another window added keeps its place.
* ``item.add`` page_id, code, after_code -- a code already on the page is left where it is (a product's name and
  type are the product catalog's, never sent with it). ``item.remove`` page_id, code. ``item.order`` page_id, codes -- like page.order: one
  another window added keeps its place, one it removed does not come back.
* ``item.alert`` page_id, code, lower, upper -- per page and row, as the CSV keeps them.
* ``instrument.set`` source, market, code, field (trade, orderbook, futures, futures_trade, futures_orderbook), value.
  An index future (``shioaji`` / ``FUT`` / ``TXF``, ``MXF``) takes trade and orderbook: those of its months.
* ``instrument.month`` code (a stock, or an index future), month (YYYYMM), on -- the near month is always on.
* ``context.set`` field (taiex, txf), value. ``sector.set`` enabled, scope.

An instrument's preferences go with it: once it is on no product page and in neither holding, its entry is dropped
(added back, it starts from the defaults).
"""
from __future__ import annotations

import copy
import logging
import threading
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from config import subscription_preferences as prefs_schema
from config.config_revisions import ConfigRevisionStore
from service.market.reference import background_demand as bd
from service.market.reference.futures_contracts import INDEX_FUTURES
from service.market.reference.watch_page_service import WatchPageService, parse_optional_alert
from service.platform.failure_record import record_failure

_log = logging.getLogger(__name__)
_lock = threading.Lock()

PositionsProvider = Callable[[], Iterable[Mapping[str, Any]]]


class OpRefused(ValueError):
    """An operation that cannot apply as sent (a malformed field): the whole batch is refused, nothing written."""


def _text(op: Mapping[str, Any], name: str) -> str:
    value = str(op.get(name) or "").strip()
    if not value:
        raise OpRefused(f"{op.get('op')}: {name} is required")
    return value


def _bool(op: Mapping[str, Any], name: str) -> bool:
    value = op.get(name)
    if not isinstance(value, bool):
        raise OpRefused(f"{op.get('op')}: {name} must be a JSON boolean")
    return value


def reorder(current: list[Any], wanted: Iterable[Any], key: Callable[[Any], Any] = lambda x: x) -> list[Any]:
    """`current` with the members that are also in `wanted` put in `wanted`'s order, in the places they held; the
    others stay where they are."""
    wanted = [w for w in dict.fromkeys(wanted)]
    present = {key(x) for x in current}
    order = [w for w in wanted if w in present]
    rank = set(order)
    slots = iter(order)
    by_key = {key(x): x for x in current}
    return [by_key[next(slots)] if key(x) in rank else x for x in current]


def _insert_after(rows: list[Any], row: Any, after: Any, key: Callable[[Any], Any]) -> None:
    keys = [key(r) for r in rows]
    rows.insert(keys.index(after) + 1 if after in keys else len(rows), row)


def _page(pages: list[dict[str, Any]], page_id: str) -> dict[str, Any] | None:
    return next((p for p in pages if str(p.get("id")) == page_id), None)


def _entry(prefs: dict[str, Any], key: tuple[str, str, str], current_kinds: Mapping[tuple[str, str, str], list[str]]) -> dict[str, Any]:
    """The instrument's entry, created from what it is subscribed with now (its owners' kinds on the list), or the
    source's default when it is not listed."""
    for entry in prefs["instruments"]:
        if prefs_schema.instrument_key(entry) == key:
            return entry
    if key[:2] == ("shioaji", "FUT"):
        entry = {"source": key[0], "market": key[1], "code": key[2], **bd.INDEX_FUTURES_DEFAULT}
        prefs["instruments"].append(copy.deepcopy(entry))
        return prefs["instruments"][-1]
    kinds = current_kinds.get(key)
    if kinds is None:
        kinds = bd.STOCK_KINDS if key[0] == "shioaji" else bd.FUTU_WATCHLIST_KINDS
    entry = {"source": key[0], "market": key[1], "code": key[2], "trade": "trade" in kinds, "orderbook": "orderbook" in kinds}
    if key[:2] == ("shioaji", "STK"):
        entry["futures"] = {"on": False, "trade": True, "orderbook": True, "months": []}
    prefs["instruments"].append(entry)
    return entry


def _futures_settings(prefs: Mapping[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """(product code, the setting holding its chosen ``months``) of every product with futures months: a stock's
    個股期貨, an index future's own entry."""
    return [(e["code"], e["futures"] if "futures" in e else e) for e in prefs["instruments"]
            if "futures" in e or "months" in e]


def _near_month(table: Any, code: str) -> str | None:
    category = table.product_category(code)
    near = table.near_month(category) if category else None
    return near.delivery_month if near else None


def apply_ops(pages: list[dict[str, Any]], prefs: dict[str, Any], ops: Iterable[Mapping[str, Any]], *,
              table: Any, current_kinds: Mapping[tuple[str, str, str], list[str]]) -> list[dict[str, Any]]:
    """Apply `ops` to `pages` and `prefs` in place, in order; returns the operations skipped, with why."""
    skipped: list[dict[str, Any]] = []
    for index, op in enumerate(ops):
        if not isinstance(op, Mapping):
            raise OpRefused(f"operation {index} is not an object")
        kind = str(op.get("op") or "")

        def skip(reason: str) -> None:
            skipped.append({"index": index, "op": kind, "reason": reason})

        if kind == "page.add":
            page_id = _text(op, "page_id")
            if _page(pages, page_id) is None:
                source = str(op.get("source") or "shioaji").strip().lower()
                page = {"id": page_id, "name": _text(op, "name"), "source": source, "market": "us" if source == "futu" else "tw", "items": []}
                _insert_after(pages, page, str(op.get("after") or ""), lambda p: str(p.get("id")))
        elif kind == "page.remove":
            page_id = _text(op, "page_id")
            if _page(pages, page_id) is None:
                skip("PAGE_NOT_FOUND")
            pages[:] = [p for p in pages if str(p.get("id")) != page_id]
        elif kind == "page.rename":
            page = _page(pages, _text(op, "page_id"))
            if page is None:
                skip("PAGE_NOT_FOUND")
            else:
                page["name"] = _text(op, "name")
        elif kind == "page.order":
            pages[:] = reorder(pages, [str(x) for x in op.get("page_ids") or ()], key=lambda p: str(p.get("id")))
        elif kind in ("item.add", "item.remove", "item.order", "item.alert"):
            page = _page(pages, _text(op, "page_id"))
            if page is None:
                skip("PAGE_NOT_FOUND")
                continue
            items = page.setdefault("items", [])
            code_of = lambda row: str(row.get("code") or "").upper()   # noqa: E731
            if kind == "item.order":
                page["items"] = reorder(items, [str(x).upper() for x in op.get("codes") or ()], key=code_of)
                continue
            code = _text(op, "code").upper()
            row = next((r for r in items if code_of(r) == code), None)
            if kind == "item.add":
                if row is None:
                    _insert_after(items, {"code": code, "source": page.get("source")}, str(op.get("after_code") or "").upper(), code_of)
            elif kind == "item.remove":
                if row is None:
                    skip("ITEM_NOT_FOUND")
                page["items"] = [r for r in items if code_of(r) != code]
            elif row is None:
                skip("ITEM_NOT_FOUND")
            else:
                try:
                    row["lower_alert"] = parse_optional_alert(op.get("lower"), code=code, field="lower_alert")
                    row["upper_alert"] = parse_optional_alert(op.get("upper"), code=code, field="upper_alert")
                except ValueError as exc:   # not an error: a price that is not a number refuses the batch with its message
                    raise OpRefused(str(exc)) from exc
        elif kind == "instrument.set":
            key = (_text(op, "source").lower(), _text(op, "market").upper(), _text(op, "code").upper())
            field, value = _text(op, "field"), _bool(op, "value")
            entry = _entry(prefs, key, current_kinds)
            if field in ("trade", "orderbook"):
                entry[field] = value
            elif field in ("futures", "futures_trade", "futures_orderbook") and "futures" in entry:
                if field == "futures" and value and not table.stock_category(key[2]):
                    skip("NO_STOCK_FUTURES")
                    continue
                entry["futures"]["on" if field == "futures" else field.split("_", 1)[1]] = value
            else:
                raise OpRefused(f"instrument.set: {field!r} is not a field of {':'.join(key)}")
        elif kind == "instrument.month":
            code, month, on = _text(op, "code").upper(), _text(op, "month"), _bool(op, "on")
            if code in INDEX_FUTURES:
                setting = _entry(prefs, ("shioaji", "FUT", code), current_kinds)
            else:
                setting = _entry(prefs, ("shioaji", "STK", code), current_kinds).get("futures")
                if setting is None:
                    raise OpRefused(f"instrument.month: {code} has no futures setting")
            near = _near_month(table, code)
            if month == near:
                skip("NEAR_MONTH_ALWAYS_ON")
                continue
            if near is None or month not in {m.delivery_month for m in table.months(table.product_category(code))}:
                skip("MONTH_NOT_LISTED")
                continue
            months = set(setting["months"])
            (months.add if on else months.discard)(month)
            setting["months"] = sorted(months)
        elif kind == "context.set":
            field, value = _text(op, "field"), _bool(op, "value")
            if field in ("taiex", "txf"):
                prefs[field] = value
            else:
                raise OpRefused(f"context.set: {field!r} is not a 大盤 field")
        elif kind == "sector.set":
            enabled, scope = _bool(op, "enabled"), _text(op, "scope")
            if scope not in prefs_schema.SCOPES:
                raise OpRefused(f"sector.set: scope must be one of {list(prefs_schema.SCOPES)}")
            prefs["sector"] = {"enabled": enabled, "scope": scope}
        else:
            raise OpRefused(f"unknown operation {kind!r}")
    return skipped


def _drop_unlisted(prefs: dict[str, Any], kept: set[tuple[str, str, str]]) -> None:
    prefs["instruments"] = sorted((e for e in prefs["instruments"] if prefs_schema.instrument_key(e) in kept),
                                  key=prefs_schema.instrument_key)


def _page_key(page: Mapping[str, Any], item: Mapping[str, Any]) -> tuple[str, str, str] | None:
    source = str(page.get("source") or "").strip().lower()
    code = str(item.get("code") or "").strip().upper()
    if source == "shioaji" and code:
        return ("shioaji", "FUT" if code in bd.index_futures() else "STK", code)
    if source == "futu" and bd.futu_market(code):
        return ("futu", bd.futu_market(code), code)
    return None


def instrument_rows(pages: list[dict[str, Any]], prefs: Mapping[str, Any], items: list[dict[str, Any]],
                    owned: Mapping[str, list[dict[str, Any]]], table: Any, names: Callable[[str, str], str]) -> list[dict[str, Any]]:
    """Every instrument of the product pages and the holdings: the pages it is on, the other owners that keep it,
    its 明細／五檔 (its preference, else its owners' default -- what background_demand lists it with), whether it is
    on the background list now, and a Shioaji stock's 個股期貨 with the months the contract table lists."""
    entries = {prefs_schema.instrument_key(e): e for e in prefs.get("instruments") or ()}
    listed = {bd._key(i): i for i in items}
    rows: dict[tuple[str, str, str], dict[str, Any]] = {}

    def row(key: tuple[str, str, str]) -> dict[str, Any]:
        return rows.setdefault(key, {"source": key[0], "market": key[1], "code": key[2], "name": "", "pages": [], "owners": []})

    for page in pages:
        for item in page.get("items") or ():
            key = _page_key(page, item)
            if key is None:
                continue
            r = row(key)
            r["pages"].append(str(page.get("id")))
    for owner in ("holdings", "paper_holdings"):
        for item in owned.get(owner) or ():
            row(bd._key(item))["owners"].append(owner)
    for key, item in listed.items():
        if "paper_orders" in (item.get("owners") or ()) and key[:2] == ("shioaji", "STK"):
            row(key)["owners"].append("paper_orders")
    out = []
    for key, r in sorted(rows.items()):
        if r["pages"]:
            r["owners"].insert(0, "watchlist")
        entry = entries.get(key)
        if entry is not None:
            r["trade"], r["orderbook"] = bool(entry["trade"]), bool(entry["orderbook"])
        else:
            r["trade"] = True
            r["orderbook"] = key[0] == "shioaji" or bool({"holdings", "paper_holdings"} & set(r["owners"]))
        r["name"] = names(key[0], key[2])
        if key[:2] == ("shioaji", "FUT"):
            # An index future: the product is its months; 明細／五檔 above are those of every month subscribed.
            months = table.months(key[2])
            r["index_futures"] = {"months": list((entry or bd.INDEX_FUTURES_DEFAULT)["months"]),
                                  "months_listed": [m.delivery_month for m in months]}
            r["listed"] = any(bd._key(i)[1:] in {("FUT", m.symbol) for m in months} for i in items)
            out.append(r)
            continue
        r["listed"] = key in listed
        # 模擬掛單: B matches on its ticks and 五檔, which stay subscribed whatever the switches say.
        r["locked"] = "paper_orders" in r["owners"]
        categories = table.stock_categories(key[2]) if key[:2] == ("shioaji", "STK") else []
        if categories:
            setting = (entry or {}).get("futures") or {"on": False, "trade": True, "orderbook": True, "months": []}
            r["futures"] = {**setting, "category": categories[0], "name": table.months(categories[0])[0].name,
                            "months_listed": [m.delivery_month for m in table.months(categories[0])]}
        out.append(r)
    return out


def sector_rows(items: list[dict[str, Any]]) -> dict[str, Any]:
    """The 產業指數 listed now (code and name), and how many each scope lists: the stocks' own, or all."""
    from config import tw_industry_indexes

    names = {i.code: i.name for i in tw_industry_indexes.table().indexes}
    listed = [{"code": i["code"], "name": names.get(i["code"], i["code"])} for i in items
              if i.get("market") == "IDX" and "sector_index" in (i.get("owners") or ())]
    return {"listed": listed, "related": len(bd.sector_index_items(items)),
            "all": len([c for c in tw_industry_indexes.all_index_codes() if c != "IX0001"])}


def quota(items: list[dict[str, Any]], opend: Mapping[str, Any]) -> dict[str, Any]:
    """The streams the list takes, by part: Shioaji's against the background share of its connections (明細、五檔、
    指數、期貨), Futu's by OpenD's types (報價＋分時 two each, 明細, 五檔) against the background share of OpenD's quota
    (``opend``: the Futu provider's subscription_quota; unknown while OpenD is not connected), with 退訂中 -- what
    OpenD still holds outside the plan until its one-minute minimum is over."""
    from config import broker_connection_settings
    from service.market.shared.provider_contract import FUTU_CAPABILITIES, FUTU_LANE_KINDS, SHIOAJI_CAPABILITIES, SHIOAJI_LANE_KINDS

    costs = SHIOAJI_CAPABILITIES.kinds_by_market(SHIOAJI_LANE_KINDS)
    futu_costs = FUTU_CAPABILITIES.kinds_by_market(FUTU_LANE_KINDS)
    shioaji = {"trade": 0, "orderbook": 0, "index": 0, "futures": 0}
    futu = {"base": 0, "trade": 0, "orderbook": 0}
    for item in items:
        source, market, _code = bd._key(item)
        kinds = item.get("kinds") or bd.FULL_KINDS
        if source == "shioaji":
            n = {kind: costs.get(market, {}).get(kind, 0) for kind in kinds}
            part = {"STK": None, "IDX": "index", "FUT": "futures"}.get(market, "futures")
            if part is None:
                shioaji["trade"] += n.get("trade", 0)
                shioaji["orderbook"] += n.get("orderbook", 0)
            else:
                shioaji[part] += sum(n.values())
        elif source == "futu":
            for kind in kinds:
                futu["base" if kind == "quote" else kind] += futu_costs.get(market, {}).get(kind, 0)
    settings = broker_connection_settings.shioaji()
    known = bool(opend.get("known"))
    draining = [{"code": str(row.get("code") or ""), "lane": str(row.get("lane") or "")} for row in opend.get("draining") or ()]
    return {"shioaji": {**shioaji, "used": sum(shioaji.values()), "limit": bd.shioaji_background_capacity(),
                        "connections": int(settings["connections"]), "per_connection": int(settings["per_connection_limit"])},
            "futu": {**futu, "used": sum(futu.values()), "known": known,
                     "limit": bd.futu_background_capacity(int(opend["streams"])) if known else None,
                     "streams": int(opend["streams"]) if known else None,
                     "used_by_others": int(opend.get("used_by_others") or 0) if known else None,
                     "draining": len(draining), "draining_pairs": draining}}


def quota_over(candidate: list[dict[str, Any]], current: list[dict[str, Any]], opend: Mapping[str, Any]) -> dict[str, Any]:
    """Each source the candidate list takes more of than its background share allows, with the numbers and what to do.
    A list that does not add streams is never refused for being over already (a lowered limit, a smaller quota). Futu
    is checked against OpenD's quota only while OpenD has said it (decisions.md 富途的訂閱管理)."""
    over: dict[str, Any] = {}
    used, before, limit = bd.shioaji_streams(candidate), bd.shioaji_streams(current), bd.shioaji_background_capacity()
    if used > limit and used > before:
        over["shioaji"] = {"used": used, "limit": limit, "message": f"永豐訂閱會用到 {used} 個，背景清單上限 {limit} 個"}
    if opend.get("known"):
        streams = int(opend["streams"])
        used, before, limit = bd.futu_streams(candidate), bd.futu_streams(current), bd.futu_background_capacity(streams)
        if used > limit and used > before:
            over["futu"] = {"used": used, "limit": limit, "streams": streams,
                            "message": f"富途訂閱會用到 {used} 個，背景清單上限 {limit} 個（OpenD 額度 {streams} 個）；要更多請找富途調高額度"}
    return over


def opend_quota(read: Callable[[], Mapping[str, Any]] | None) -> dict[str, Any]:
    """The Futu provider's OpenD quota (GET /v1/futu/subscription-quota), or unknown: OpenD not connected, the source
    switched off or the provider not answering -- each recorded, and the Futu quota is then not checked on save."""
    if read is None:
        return {"known": False}
    try:
        answer = dict(read() or {})
    except Exception as exc:
        record_failure(_log, "reading the Futu provider's OpenD subscription quota", exc)
        return {"known": False, "error": f"{type(exc).__name__}: {exc}"[:200]}
    if answer.get("ok") is not True:
        _log.warning("Futu OpenD subscription quota unavailable: %s", answer.get("error") or answer)
        return {"known": False, "error": str(answer.get("error") or "UNAVAILABLE")}
    return answer


class SubscriptionState:
    """settings_api's handle on the product pages, the preferences and the background list they make."""

    def __init__(self, config_root: Path, watch_pages: Path, positions: Mapping[str, PositionsProvider],
                 catalog: Any,
                 futu_quota: Callable[[], Mapping[str, Any]] | None = None) -> None:
        """catalog: the product catalog (ProductCatalogService), the one owner of a product's name and type: the
        pages and rows a window draws take them from it as it is now.
        futu_quota(): the Futu provider's OpenD quota (GET /v1/futu/subscription-quota); None: not read (unknown)."""
        self.config_root = Path(config_root)
        self.pages = WatchPageService(watch_pages)
        # holdings / paper_holdings -> the ledger's positions now.
        self.positions = dict(positions)
        self.catalog = catalog
        self.futu_quota = futu_quota

    def _owned(self, pages: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        owned = {"watchlist": bd.watchlist_items_of(pages), "market_context": []}
        for owner, positions in self.positions.items():
            owned[owner] = bd.holdings_items(positions())
        return owned

    def _store(self) -> ConfigRevisionStore:
        return ConfigRevisionStore(self.config_root, prefs_schema.DOMAIN)

    def _view(self, pages: list[dict[str, Any]], prefs: dict[str, Any], items: list[dict[str, Any]],
              owned: Mapping[str, list[dict[str, Any]]], table: Any, opend: Mapping[str, Any]) -> dict[str, Any]:
        """What both settings screens draw, derived here once: every instrument of the pages and holdings with why it
        is listed and what it is subscribed with, the market context, the sector indexes and the quota."""
        return {
            "pages": self.catalog.with_metadata(pages),
            "preferences": prefs,
            "background": items,
            "instruments": instrument_rows(pages, prefs, items, owned, table,
                                           lambda source, code: self.catalog.metadata(source, code)["name"]),
            "sector_indexes": sector_rows(items),
            "quota": quota(items, opend),
            "futures": table.as_dict(),
            # The index futures a product page can hold, with the months the contract table lists.
            "index_futures": {code: {"name": name, "months": [m.delivery_month for m in table.months(code)]}
                              for code, name in INDEX_FUTURES.items() if table.months(code)},
        }

    def snapshot(self) -> dict[str, Any]:
        """Everything a settings window shows, as saved now (the preferences' revision is the state's revision)."""
        latest = self._store().latest()
        background = ConfigRevisionStore(self.config_root, bd.DOMAIN).latest() or {}
        items = list((background.get("values") or {}).get("items") or [])
        pages = self.pages.list_pages()
        prefs = prefs_schema.read((latest or {}).get("values") or prefs_schema.defaults())
        return {"ok": True, "revision": (latest or {}).get("revision"), "background_revision": background.get("revision"),
                **self._view(pages, prefs, items, self._owned(pages), bd._futures_table(), opend_quota(self.futu_quota))}

    def apply(self, batch: Mapping[str, Any], *, preview: bool = False) -> dict[str, Any]:
        """Apply a batch; with `preview`, nothing is written and the answer is the state the batch would make (the
        quota a window shows before it saves, from the same composition the save uses)."""
        batch_id = str(batch.get("batch_id") or "").strip()
        ops = batch.get("ops")
        if not isinstance(ops, list) or (not preview and (not batch_id or not ops)):
            return {"ok": False, "error": "INVALID_BATCH", "message": "batch_id and a non-empty ops list are required"}
        # Read before the lock (it asks the Futu provider): the batch is checked against what OpenD says now.
        opend = opend_quota(self.futu_quota)
        with _lock:
            store = self._store()
            latest = store.latest()
            prefs = prefs_schema.read((latest or {}).get("values") or prefs_schema.defaults())
            try:
                pages = self.pages.list_pages()
            except ValueError as exc:
                # A file that cannot be read is never overwritten: it is fixed (or restored) first.
                record_failure(_log, "reading watch_pages.csv for a subscriptions batch", exc)
                return {"ok": False, "error": "WATCH_PAGES_UNREADABLE", "message": f"商品頁檔案無法讀取，沒有寫入：{exc}"}
            if not preview and batch_id in prefs["batches"]:
                return {**self.snapshot(), "duplicate": True, "skipped": []}
            background = ConfigRevisionStore(self.config_root, bd.DOMAIN).latest() or {}
            current = list((background.get("values") or {}).get("items") or [])
            table = bd._futures_table()
            current_kinds = {bd._key(item): list(item.get("kinds") or bd.FULL_KINDS) for item in current}
            try:
                skipped = apply_ops(pages, prefs, ops, table=table, current_kinds=current_kinds)
            except OpRefused as exc:   # not an error: a malformed operation is the batch's refusal, nothing written
                return {"ok": False, "error": "INVALID_OPERATION", "message": str(exc)}
            owned = self._owned(pages)
            _drop_unlisted(prefs, {bd._key(item) for raw in owned.values() for item in raw})
            if not preview:
                prefs["batches"] = (prefs["batches"] + [batch_id])[-prefs_schema.MAX_BATCHES:]
            problems = prefs_schema.validate(prefs)
            if problems:
                return {"ok": False, "error": "INVALID_PREFERENCES", "problems": problems}
            from config.source_settings import source_enabled

            candidate = bd.compose(current, owned, prefs, table, enabled=source_enabled)
            over = quota_over(candidate, current, opend)
            if preview:
                return {"ok": True, "preview": True, "skipped": skipped, "quota_exceeded": bool(over), "quota_over": over,
                        **self._view(pages, prefs, candidate, owned, table, opend)}
            if over:
                return {"ok": False, "error": "QUOTA_EXCEEDED", "quota_over": over,
                        "message": "；".join(row["message"] for row in over.values())}
            self.pages.save_pages(pages)
            store.save(prefs, expected_revision=(latest or {}).get("revision"), source=f"subscriptions:{batch.get('client') or 'ui'}",
                       summary=f"batch {batch_id}: {len(ops)} operations", activate=True, validator=prefs_schema.validate)
            saved = bd.replace_owners(self.config_root, owned, summary=f"subscriptions batch {batch_id}", prefs=prefs)
            if not saved.get("ok"):
                _log.error("background list not saved after subscriptions batch %s: %s", batch_id, saved)
            return {**self.snapshot(), "skipped": skipped, "background_saved": saved}

    def follow_futures_table(self) -> dict[str, Any]:
        """The futures contract table was rewritten (the daily refresh): months that expired leave the preferences,
        and every owner is listed again, so the near months move on."""
        with _lock:
            store = self._store()
            latest = store.latest()
            prefs = prefs_schema.read((latest or {}).get("values") or prefs_schema.defaults())
            table = bd._futures_table()
            changed = False
            for code, setting in _futures_settings(prefs):
                listed = {m.delivery_month for m in table.months(table.product_category(code) or "")}
                months = [m for m in setting["months"] if m in listed]
                if months != setting["months"]:
                    setting["months"], changed = months, True
            if changed and latest is not None:
                store.save(prefs, expected_revision=latest.get("revision"), source="subscriptions:futures_contracts",
                           summary="expired futures months", activate=True, validator=prefs_schema.validate)
            return bd.replace_owners(self.config_root, self._owned(self.pages.list_pages()), summary="futures contract table", prefs=prefs)
