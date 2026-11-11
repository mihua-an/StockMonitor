"""The Shioaji futures contract table (``reference/shioaji/futures_contracts.csv``): every dated month of every
futures category, written with the security master on its daily refresh (service/market/shioaji/maintenance.py) from
the broker's own contract list -- never a hand-kept list.

* Which stocks have 個股期貨: a category whose ``underlying_code`` is that stock (a stock may have several, e.g. a
  standard and a mini contract: listed largest ``unit`` first, the first is the one a stock's 期貨 subscribes).
* A category's months: its rows, earliest first; the first is the near month (近月). An expired month is not written,
  so the near month moves on by itself at the first refresh after an expiry.
* A month is named by its symbol (``TXF202612``, ``CDF202612``): that is the code Market Runtime, the background list
  and the WAL partitions know it by; ``code`` is the broker's own contract code (``TXFL6``), which the provider
  subscribes with and its callbacks carry.

The continuous contracts (``TXFR1``, ``TXFR2``) are not rows: TXFR1 is the 大盤 台指期 Quote, subscribed by its own
capability rule.
"""
from __future__ import annotations

import csv
import io
import logging
import threading
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

from service.platform.atomic_files import read_text_shared, write_bytes_atomic
from service.platform.failure_record import record_failure

_log = logging.getLogger(__name__)

FIELDS = ("code", "symbol", "category", "name", "underlying_code", "unit", "delivery_month", "delivery_date", "updated_at")
TXF = "TXF"
# The index futures a product page can hold, by category, with the name the App shows (decisions.md 商品的現貨／期貨與
# 月份): a product with no spot side; its months, 明細 and 五檔 are its own 訂閱偏好, like a stock's 期貨.
INDEX_FUTURES = {"TXF": "台指期", "MXF": "小台指"}


@dataclass(frozen=True)
class FuturesMonth:
    code: str
    symbol: str
    category: str
    name: str
    underlying_code: str
    unit: int
    delivery_month: str   # YYYYMM
    delivery_date: str    # YYYY-MM-DD


class FuturesTable:
    """One reading of the contract table."""

    def __init__(self, months: Iterable[FuturesMonth]) -> None:
        rows = sorted(months, key=lambda m: (m.category, m.delivery_month))
        self.by_symbol = {m.symbol: m for m in rows}
        self.by_code = {m.code: m for m in rows}
        self._months: dict[str, list[FuturesMonth]] = {}
        for month in rows:
            self._months.setdefault(month.category, []).append(month)
        self._of_stock: dict[str, list[str]] = {}
        for category, months in sorted(self._months.items(), key=lambda kv: (-kv[1][0].unit, kv[0])):
            underlying = months[0].underlying_code
            if underlying and category not in INDEX_FUTURES:
                self._of_stock.setdefault(underlying, []).append(category)

    def months(self, category: str) -> list[FuturesMonth]:
        """The category's months, near month first."""
        return list(self._months.get(str(category or "").upper(), ()))

    def near_month(self, category: str) -> FuturesMonth | None:
        months = self._months.get(str(category or "").upper())
        return months[0] if months else None

    def stock_categories(self, stock_code: str) -> list[str]:
        """The 個股期貨 categories of a stock, the one its 期貨 subscribes first."""
        return list(self._of_stock.get(str(stock_code or "").strip().upper(), ()))

    def stock_category(self, stock_code: str) -> str | None:
        categories = self.stock_categories(stock_code)
        return categories[0] if categories else None

    def product_category(self, code: str) -> str | None:
        """The futures category of a product page's product: an index future is its own category, a stock its
        個股期貨's; None for a product with no futures."""
        code = str(code or "").strip().upper()
        if code in INDEX_FUTURES:
            return code if code in self._months else None
        return self.stock_category(code)

    def symbols(self, category: str, chosen: Iterable[str]) -> list[str]:
        """The months to subscribe of a category: its near month always, then every chosen month (YYYYMM) still
        listed -- a chosen month that became the near month is the near month, never twice."""
        months = self.months(category)
        if not months:
            return []
        wanted = {str(m) for m in chosen}
        return [m.symbol for i, m in enumerate(months) if i == 0 or m.delivery_month in wanted]

    def as_dict(self) -> dict[str, Any]:
        """For the settings pages: every category's months, and the stocks with 個股期貨."""
        return {
            "categories": {category: {"name": months[0].name, "underlying_code": months[0].underlying_code,
                                      "months": [m.delivery_month for m in months]}
                           for category, months in self._months.items()},
            "stocks": dict(self._of_stock),
        }


_EMPTY = FuturesTable(())
_cache_lock = threading.Lock()
_cache: dict[Path, tuple[tuple[int, int], FuturesTable]] = {}


def _month_of(raw: Any) -> str:
    text = str(raw or "").strip().replace("/", "").replace("-", "")
    return text[:6] if len(text) >= 6 and text[:6].isdigit() else ""


def _date_of(raw: Any) -> str:
    text = str(raw or "").strip().replace("/", "-")
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:  # not an error: a contract without a readable delivery date is left out of the table (counted by the caller)
        return ""


def _fields(contract: Any) -> dict[str, Any]:
    """A contract's fields: Shioaji's info objects give them through dict(); a plain object through attributes."""
    to_dict = getattr(contract, "dict", None)
    if callable(to_dict):
        try:
            return dict(to_dict())
        except Exception as exc:
            record_failure(_log, "reading a Shioaji futures contract's fields", exc)
            return {}
    return dict(getattr(contract, "__dict__", {}) or {})


def rows_from_contracts(contracts: Iterable[Any], *, today: date) -> tuple[list[FuturesMonth], int]:
    """The dated, unexpired months of the broker's futures contracts, and how many contracts were left out for a
    missing field. The continuous contracts (R1/R2) are not months."""
    out: dict[str, FuturesMonth] = {}
    skipped = 0
    for contract in contracts:
        fields = _fields(contract)
        code = str(fields.get("code") or "").strip().upper()
        # Shioaji 1.7.2's futures info names the category `root` (TXF, CDF) and the contract size `contract_size`
        # (2000 a standard stock future, 100 a mini): its local cache ~/.shioaji/contracts-v2-1.7/TW-FUT-info, 11-01.
        category = str(fields.get("root") or "").strip().upper()
        month = _month_of(fields.get("delivery_month"))
        if code.endswith(("R1", "R2")):
            continue
        delivered = _date_of(fields.get("delivery_date"))
        if not (code and category and month and delivered):
            skipped += 1
            continue
        if delivered < today.isoformat():
            continue
        try:
            unit = int(float(fields.get("contract_size") or 0))
        except (TypeError, ValueError):  # not an error: an unreadable size sorts the category last among a stock's
            unit = 0
        # The month's name in Market Runtime, the background list and the WAL: <category><YYYYMM>.
        symbol = f"{category}{month}"
        out[symbol] = FuturesMonth(code=code, symbol=symbol, category=category,
                                   name=str(fields.get("name") or "").strip(),
                                   underlying_code=str(fields.get("underlying_code") or "").strip().upper(),
                                   unit=unit, delivery_month=month, delivery_date=delivered)
    return sorted(out.values(), key=lambda m: (m.category, m.delivery_month)), skipped


def write_table(path: Path, months: Iterable[FuturesMonth]) -> None:
    fh = io.StringIO(newline="")
    writer = csv.DictWriter(fh, fieldnames=FIELDS)
    writer.writeheader()
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for m in months:
        writer.writerow({**m.__dict__, "updated_at": stamp})
    write_bytes_atomic(path, fh.getvalue().encode("utf-8-sig"), durable=True)
    with _cache_lock:
        _cache.pop(path, None)


def load_table(path: Path) -> FuturesTable:
    """The table as written; empty while none has been (no futures can be subscribed then). Re-read only when the
    file changed. A damaged file raises: it is never taken as an empty table."""
    try:
        stat = path.stat()
    except FileNotFoundError:  # not an error: no refresh has written the table yet
        return _EMPTY
    signature = (int(stat.st_mtime_ns), int(stat.st_size))
    with _cache_lock:
        cached = _cache.get(path)
        if cached is not None and cached[0] == signature:
            return cached[1]
    reader = csv.DictReader(io.StringIO(read_text_shared(path, encoding="utf-8-sig")))
    missing = [name for name in FIELDS if name not in (reader.fieldnames or [])]
    if missing:
        raise ValueError(f"{path.name} is missing columns {missing}")
    months = []
    for line, row in enumerate(reader, start=2):
        try:
            months.append(FuturesMonth(code=row["code"].strip().upper(), symbol=row["symbol"].strip().upper(),
                                       category=row["category"].strip().upper(), name=row["name"].strip(),
                                       underlying_code=row["underlying_code"].strip().upper(), unit=int(row["unit"] or 0),
                                       delivery_month=row["delivery_month"].strip(), delivery_date=row["delivery_date"].strip()))
        except (AttributeError, ValueError) as exc:
            raise ValueError(f"{path.name} line {line} is damaged: {exc}") from exc
    table = FuturesTable(months)
    with _cache_lock:
        _cache[path] = (signature, table)
    return table


def default_path() -> Path:
    from service.market.storage.market_storage_layout import process_market_layout

    return process_market_layout().shioaji_futures_contracts


def current_table() -> FuturesTable:
    return load_table(default_path())


def update_from_api(api: Any, path: Path | None = None, *, today: date | None = None) -> dict[str, Any]:
    """Rewrite the table from the broker's futures contracts (the daily security-master refresh). Nothing listed:
    the table on disk stays (a failed listing never empties it)."""
    path = path or default_path()
    contracts = getattr(api, "contracts", None)
    if contracts is None:
        return {"ok": False, "error": "Shioaji contracts are not ready", "file": str(path)}
    # Shioaji 1.7.2 names the kind SecurityType.Futures (checked 2026-11-01). The api object comes only from the
    # provider, which has loaded the SDK: its enum is taken from there, never imported from this reference module.
    security_type = getattr(getattr(api, "SecurityType", None), "Futures", None)
    if security_type is None:
        import sys

        security_type = getattr(getattr(sys.modules.get("shioaji"), "SecurityType", None), "Futures", None)
    if security_type is None:
        return {"ok": False, "error": "the Shioaji SDK has no SecurityType.Futures", "file": str(path)}
    try:
        listed = list(contracts.list(security_type) or [])
    except Exception as exc:
        record_failure(_log, "listing Shioaji futures contracts", exc)
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:200], "file": str(path)}
    info = getattr(contracts, "info", None)
    detailed = []
    for contract in listed:
        try:
            detailed.append((info(contract) if callable(info) else None) or contract)
        except Exception as exc:
            record_failure(_log, "reading Shioaji futures contract info", exc)
            detailed.append(contract)
    months, skipped = rows_from_contracts(detailed, today=today or date.today())
    if not months:
        return {"ok": False, "error": "Shioaji listed no futures months", "listed": len(listed), "file": str(path)}
    write_table(path, months)
    if skipped:
        _log.warning("[FUTURES] %d futures contracts without a symbol, category or delivery month were left out", skipped)
    return {"ok": True, "count": len(months), "skipped": skipped, "file": str(path)}
