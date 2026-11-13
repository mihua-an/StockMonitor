"""訂閱偏好 (設定 → 訂閱管理 and 商品頁設定, user 11-01): what each instrument of the product pages and holdings is
subscribed with, the market context and the sector indexes. One settings_api domain, ``subscriptions``, active on
save, written only by the batch operations of ``POST /api/subscriptions/ops``
(service/market/reference/subscription_ops.py) -- never replaced whole through the generic config route.

One setting per instrument, shared by every product page it is on (decisions.md 訂閱清單在兩個地方管理):

* ``instruments``: only the instruments whose setting is not the default. ``trade`` = 明細 (Shioaji Tick, Futu
  TICKER), ``orderbook`` = 五檔 (Shioaji BidAsk, Futu ORDER_BOOK); both off is allowed (the row is 未訂閱). A Shioaji
  stock may have ``futures``: its 個股期貨 (``on``), the 明細／五檔 of every month subscribed, and the months chosen
  beside the near month, which is always subscribed while ``on`` (YYYYMM; futures_contracts.py). An index future on a
  product page (``shioaji`` / ``FUT`` / ``TXF`` or ``MXF``, futures_contracts.INDEX_FUTURES) is a product with only a
  futures side: its ``trade`` / ``orderbook`` are those of every month subscribed, and ``months`` the months chosen
  beside the near month, which is always subscribed.
* ``taiex``: 加權指數. ``txf``: 台指期 TXFR1's Quote (the dashboard's 期貨走勢); its months are the TXF product's.
* ``sector``: 產業指數 -- ``enabled``, and ``scope`` ``related`` (the indexes of the stocks listed) or ``all``.
* ``odd_lots``: the product pages' Shioaji stocks keep their 盤中零股 subscribed before the open (user 11-14), only
  into the streams every other demand leaves (background_demand.py owner ``odd_lots``, spare).
* ``batches``: the ids of the last applied batches, so a batch sent twice is applied once.

An instrument without an entry takes its owner's default (background_demand.py): 明細 and 五檔 on for a Shioaji stock;
a Futu product page's product 明細 only, a Futu holding both.
"""
from __future__ import annotations

import copy
from typing import Any

DOMAIN = "subscriptions"
SCOPES = ("related", "all")
MAX_BATCHES = 100
MAX_INSTRUMENTS = 4000
DEFAULTS: dict[str, Any] = {
    "instruments": [],
    "taiex": True,
    "txf": True,
    "sector": {"enabled": True, "scope": "related"},
    "odd_lots": False,
    "batches": [],
}


def defaults() -> dict[str, Any]:
    return copy.deepcopy(DEFAULTS)


def read(values: dict[str, Any]) -> dict[str, Any]:
    """Saved preferences as this program reads them. ``txf`` was once ``{on, trade, orderbook, months}`` with the
    TXF months on the 大盤 setting; the name is kept (AGENTS.md 0.3, a saved setting never disappears) and only its
    ``on`` -- the TXFR1 Quote -- is read: the months are the TXF product's now. A revision saved before ``odd_lots``
    existed has it off, its default."""
    out = copy.deepcopy(values)
    out.setdefault("odd_lots", DEFAULTS["odd_lots"])
    if isinstance(out.get("txf"), dict):
        out["txf"] = bool(out["txf"].get("on"))
    return out


def index_futures_codes() -> frozenset[str]:
    from service.market.reference.futures_contracts import INDEX_FUTURES

    return frozenset(INDEX_FUTURES)


def _problem(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **extra}


def _months_problem(months: Any) -> str | None:
    if not isinstance(months, list):
        return "months must be a list"
    if any(not (isinstance(m, str) and len(m) == 6 and m.isdigit()) for m in months):
        return "months must be YYYYMM strings"
    if len(set(months)) != len(months) or months != sorted(months):
        return "months must be sorted, none twice"
    return None


def _futures_problems(futures: Any, where: str) -> list[dict[str, Any]]:
    if not isinstance(futures, dict) or set(futures) != {"on", "trade", "orderbook", "months"}:
        return [_problem("FUTURES", f"{where} must be {{on, trade, orderbook, months}}")]
    problems = [_problem("FUTURES", f"{where}.{name} must be a JSON boolean") for name in ("on", "trade", "orderbook")
                if not isinstance(futures.get(name), bool)]
    months = _months_problem(futures.get("months"))
    if months:
        problems.append(_problem("FUTURES_MONTHS", f"{where}: {months}"))
    return problems


def instrument_key(entry: dict[str, Any]) -> tuple[str, str, str]:
    return (str(entry.get("source") or "").strip().lower(), str(entry.get("market") or "").strip().upper(),
            str(entry.get("code") or "").strip().upper())


def validate(values: dict[str, Any]) -> list[dict[str, Any]]:
    values = values or {}
    problems: list[dict[str, Any]] = []
    unknown = sorted(set(values) - set(DEFAULTS))
    if unknown:
        problems.append(_problem("UNKNOWN_FIELD", f"unknown field {unknown[0]!r}"))
    instruments = values.get("instruments")
    if not isinstance(instruments, list) or len(instruments) > MAX_INSTRUMENTS:
        problems.append(_problem("INSTRUMENTS", f"instruments must be a list of at most {MAX_INSTRUMENTS}"))
        instruments = []
    seen: set[tuple[str, str, str]] = set()
    for i, entry in enumerate(instruments):
        if not isinstance(entry, dict):
            problems.append(_problem("INSTRUMENT", "an instrument must be an object", index=i))
            continue
        key = instrument_key(entry)
        if not all(key) or key != (entry.get("source"), entry.get("market"), entry.get("code")):
            problems.append(_problem("INSTRUMENT", "source (lower case), market and code (upper case) are required", index=i))
        if key in seen:
            problems.append(_problem("DUPLICATE_INSTRUMENT", f"{':'.join(key)} listed twice", index=i))
        seen.add(key)
        index_future = key[:2] == ("shioaji", "FUT")
        if index_future and key[2] not in index_futures_codes():
            problems.append(_problem("INSTRUMENT", f"{key[2]} is not an index future a product page can hold", index=i))
        allowed = ({"source", "market", "code", "trade", "orderbook"}
                   | ({"futures"} if key[:2] == ("shioaji", "STK") else set()) | ({"months"} if index_future else set()))
        if not set(entry) <= allowed or (index_future and "months" not in entry):
            problems.append(_problem("INSTRUMENT", f"an instrument holds only {sorted(allowed)}", index=i))
        for name in ("trade", "orderbook"):
            if not isinstance(entry.get(name), bool):
                problems.append(_problem("INSTRUMENT", f"{name} must be a JSON boolean", index=i))
        if "futures" in entry:
            problems.extend({**p, "index": i} for p in _futures_problems(entry["futures"], "futures"))
        if index_future and "months" in entry:
            months = _months_problem(entry["months"])
            if months:
                problems.append(_problem("FUTURES_MONTHS", f"months: {months}", index=i))
    if not isinstance(values.get("taiex"), bool):
        problems.append(_problem("TAIEX", "taiex must be a JSON boolean"))
    if not isinstance(values.get("txf"), bool):
        problems.append(_problem("TXF", "txf must be a JSON boolean"))
    if not isinstance(values.get("odd_lots", DEFAULTS["odd_lots"]), bool):
        problems.append(_problem("ODD_LOTS", "odd_lots must be a JSON boolean"))
    sector = values.get("sector")
    if (not isinstance(sector, dict) or set(sector) != {"enabled", "scope"} or not isinstance(sector.get("enabled"), bool)
            or sector.get("scope") not in SCOPES):
        problems.append(_problem("SECTOR", f"sector must be {{enabled: boolean, scope: one of {list(SCOPES)}}}"))
    batches = values.get("batches")
    if (not isinstance(batches, list) or len(batches) > MAX_BATCHES
            or any(not isinstance(b, str) or not b for b in batches)):
        problems.append(_problem("BATCHES", f"batches must be a list of at most {MAX_BATCHES} batch ids"))
    return problems


def active(config_root: Any = None) -> dict[str, Any]:
    """The latest saved preferences (the domain is active on save), the defaults before any. A store that cannot be
    read raises (config_revisions.StoreUnreadable): it is never read as the defaults."""
    from config.config_revisions import ConfigRevisionStore
    from service.platform.project_root import CONFIG_ROOT

    latest = ConfigRevisionStore(config_root or CONFIG_ROOT, DOMAIN).latest()
    return read((latest or {}).get("values") or DEFAULTS)
