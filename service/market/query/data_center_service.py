from __future__ import annotations

from collections import defaultdict
from typing import Any, Callable, Mapping
import logging

from config import tw_industry_indexes
from service.platform.failure_record import record_failure
from service.platform.model_storage_layout import day_tick_complete

_failure_log = logging.getLogger(__name__)


# A date's categories, in the order 資料中心 lists them (user 10-28): 加權指數, 期貨指數 (its 日盤 / 夜盤 below it),
# 產業指數 (config/tw_industry_indexes.json), 上市股票, 上櫃股票. "other" holds what none of them is (an index outside the
# table, a stock the security master does not list) and is listed only when the date has any.
CATEGORY_ORDER = ("taiex", "futures", "industry", "tse", "otc", "other")
TAIEX_CODE = "TAIEX"
FUTURES_SESSIONS = ("DAY", "NIGHT")


def as_count(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:  # not an error: counter coercion: a non-numeric value counts as 0 by contract
        return 0


def as_text(value: Any) -> str:
    return str(value or "")


def _security_master_markets() -> dict[str, str]:
    """code -> "tse" / "otc" from the Shioaji security master; {} when it cannot be read (recorded): every stock then
    falls under "other" for that answer."""
    from service.market.reference.security_master_service import SecurityMasterService
    from service.market.storage.market_storage_layout import process_market_layout

    try:
        master = SecurityMasterService(process_market_layout().shioaji_security_master).load_master()
    except Exception as exc:
        record_failure(_failure_log, "reading the security master for 資料中心's 上市／上櫃", exc)
        return {}
    return {code: str(info.market or "").strip().lower() for code, info in master.items()}


def _materialization_status(market: str, trading_date: str, session: str = "") -> dict[str, Any]:
    from service.market.shared.materialization_ledger import intent_or_job_status

    return intent_or_job_status("shioaji", market, trading_date, session=session)


class DataCenterService:
    """Read-only coverage center over what the Rust Historical Materializer produced.

    - ``historical_evidence_catalog``: ``HistoricalEvidenceCatalog``, the materialized partitions as each date's index
      (totals.json, written by Rust B) lists them: identities, records per lane, disk use; every session in it carries
      a canonical session. No partition manifest or event file is opened here.
    """

    def __init__(self, historical_evidence_catalog: Any, *,
                 stock_markets: Callable[[], Mapping[str, str]] | None = None,
                 materialization_status: Callable[..., dict[str, Any]] | None = None,
                 day_complete: Callable[[str], bool | None] | None = None):
        self.metadata = historical_evidence_catalog
        # A stock's listing (code -> "tse" / "otc", the security master) and the materialization ledger's state of one
        # session: what a date's categories read besides the catalog. A date's 完整 is its daily summary's verdict.
        self.stock_markets = stock_markets or _security_master_markets
        self.materialization_status = materialization_status or _materialization_status
        self.day_complete = day_complete or day_tick_complete

    def dates(self) -> dict[str, Any]:
        """The listed dates with each day's record counts and disk use, all read from the dates' indexes (one file per
        market and date); it computes no completeness: a date's 完整 is its daily summary's verdict."""
        raw = self.metadata.raw_part_identities()
        industry_indexes = frozenset(tw_industry_indexes.all_index_codes())
        by_date: dict[str, dict[str, Any]] = {}
        for row in raw:
            date_text = as_text(row.get("trading_date"))[:10]
            if not date_text:
                continue
            item = by_date.setdefault(date_text, {
                "date": date_text,
                "raw_rows": 0,
                "raw_parts": 0,
                "stock_streams": set(),
                "futures_streams": set(),
                "kinds": defaultdict(int),
                "storage": {},
            })
            item["raw_rows"] += as_count(row.get("row_count"))
            item["raw_parts"] += as_count(row.get("part_count"))
            kind = as_text(row.get("kind"))
            item["kinds"][kind] += as_count(row.get("row_count"))
            # 每日資料總覽: how many records of each kind the day holds and how much disk its raw data takes, for
            # every market and all markets together (user 10-13: a day is judged by 筆數 and 空間), and the records of
            # its industry indexes (產業筆數, user 10-28: the sector indexes of config/tw_industry_indexes.json).
            # A partition's size covers all its lanes: counted once.
            partition = (as_text(row.get("market")).upper(), as_text(row.get("logical_code")), as_text(row.get("actual_contract")),
                         as_text(row.get("session")))
            for scope in ("ALL", partition[0]):
                usage = item["storage"].setdefault(scope, {"products": set(), "rows": defaultdict(int), "industry_index_rows": 0,
                                                           "bytes": 0, "partitions": set()})
                usage["products"].add(partition[:2])
                usage["rows"][kind] += as_count(row.get("row_count"))
                if partition[0] == "IDX" and partition[1] in industry_indexes:
                    usage["industry_index_rows"] += as_count(row.get("row_count"))
                if partition not in usage["partitions"]:
                    usage["partitions"].add(partition)
                    usage["bytes"] += as_count(row.get("partition_bytes"))
            ident = (as_text(row.get("logical_code")), as_text(row.get("session")))
            if as_text(row.get("market")).upper() == "STK":
                item["stock_streams"].add(ident)
            elif as_text(row.get("market")).upper() == "FUT":
                item["futures_streams"].add(ident)

        items = []
        for date_text in sorted(by_date, reverse=True):
            row = by_date[date_text]
            items.append({
                "date": date_text,
                "raw_rows": row["raw_rows"],
                "raw_parts": row["raw_parts"],
                "stock_streams": len(row["stock_streams"]),
                "futures_streams": len(row["futures_streams"]),
                "kinds": dict(row["kinds"]),
                "storage": {scope: {"products": len(usage["products"]), "rows": dict(usage["rows"]),
                                    "industry_index_rows": usage["industry_index_rows"], "bytes": usage["bytes"]}
                            for scope, usage in row["storage"].items()},
                # 完整 (user 10-28): every stock's ticks reconcile; None while the day has no summary (not known).
                "complete": self.day_complete(date_text),
            })
        return {"ok": True, "items": items, "count": len(items), "source": "historical_evidence_catalog"}

    def date_categories(self, trading_date: str) -> dict[str, Any]:
        """One date by category (資料中心's expanded date, user 10-28): per category its products, records of each
        kind and disk use, all from the date's indexes; its 物化結果 -- how many of its products' partitions are
        complete / repaired (prints filled from the broker's history, the book of the gap lost: not complete, user
        11-06) / gap_detected (``completeness``) -- and the materialization ledger's state of the session that holds it
        while it is still being materialized (STK for 上市／上櫃, IDX for 加權／產業, FUT per 日盤／夜盤). Futures carry
        their two sessions as ``sessions``."""
        date_text = as_text(trading_date)[:10]
        raw = self.metadata.raw_part_identities(trading_date=date_text)
        industry = frozenset(tw_industry_indexes.all_index_codes())
        stock_markets = self.stock_markets() if any(as_text(r.get("market")).upper() == "STK" for r in raw) else {}

        def category_of(market: str, code: str) -> str:
            if market == "IDX":
                return "taiex" if code == TAIEX_CODE else "industry" if code in industry else "other"
            if market == "FUT":
                return "futures"
            if market == "STK" and stock_markets.get(code) in {"tse", "otc"}:
                return stock_markets[code]
            return "other"

        def usage() -> dict[str, Any]:
            return {"products": set(), "rows": defaultdict(int), "bytes": 0, "partitions": set(), "completeness": {}}

        groups: dict[str, dict[str, Any]] = defaultdict(usage)
        sessions: dict[str, dict[str, Any]] = defaultdict(usage)
        for row in raw:
            market = as_text(row.get("market")).upper()
            session = as_text(row.get("session")).upper()
            if market == "FUT" and session not in FUTURES_SESSIONS:
                continue   # CLOSED: an out-of-session storage bucket, not a trading session
            code = as_text(row.get("logical_code")).upper()
            partition = (market, code, as_text(row.get("actual_contract")).upper(), session)
            targets = [groups[category_of(market, code)]] + ([sessions[session]] if market == "FUT" else [])
            for target in targets:
                target["completeness"][(market, code, session)] = as_text(row.get("completeness")) or "gap_detected"
                target["products"].add((market, code))
                target["rows"][as_text(row.get("kind"))] += as_count(row.get("row_count"))
                if partition not in target["partitions"]:
                    target["partitions"].add(partition)
                    target["bytes"] += as_count(row.get("partition_bytes"))

        def view(item: dict[str, Any]) -> dict[str, Any]:
            counts = {state: 0 for state in ("complete", "repaired", "gap_detected")}
            for state in item["completeness"].values():
                counts[state if state in counts else "gap_detected"] += 1
            return {"products": len(item["products"]), "rows": {kind: item["rows"].get(kind, 0) for kind in ("tick", "bidask", "quote")},
                    "bytes": item["bytes"], "completeness": counts}

        status_of = {market: self.materialization_status(market, date_text) for market in ("STK", "IDX")}
        session_status = {session: self.materialization_status("FUT", date_text, session) for session in FUTURES_SESSIONS}
        closing = {"taiex": status_of["IDX"], "industry": status_of["IDX"], "tse": status_of["STK"], "otc": status_of["STK"]}
        categories = []
        for key in CATEGORY_ORDER:
            if key not in groups:
                continue
            item = {"id": key, **view(groups[key]), "materialization": closing.get(key)}
            if key == "futures":
                item["sessions"] = [{"id": session, **view(sessions[session]), "materialization": session_status[session]}
                                    for session in FUTURES_SESSIONS if session in sessions]
            categories.append(item)
        return {"ok": True, "trading_date": date_text, "categories": categories}
