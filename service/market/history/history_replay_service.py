from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
from threading import RLock
import time
from typing import Any, Callable

import pandas as pd


from service.market.history.repository_contract import MarketHistoryRepository
from service.market.history.historical_store import ORDERBOOK_LANE
from service.market.history.index_day import day_reference_price, index_day
from service.market.history.technical_history import TechnicalHistoryReader, valid_code, valid_scope
from service.platform.model_storage_layout import process_kbar_root
from service.market.shared.market_value_policy import resolve_market_move
from service.market.reference import sector_indexes
from service.market.shared.partition_evidence import PartitionEvidence
import logging
from service.platform.failure_record import record_failure


_failure_log = logging.getLogger(__name__)


# Dates whose product list (and summaries) the replay keeps; older ones are rebuilt when viewed again.
LIST_CACHE_DATES = 16

class HistoryReplayService:
    """Cross-domain, read-only replay composition for one date/code session.

    Market history comes through ``MarketHistoryRepository``; analysis data
    comes from model stores; account markers come through an injected read
    provider.  This composition layer owns none of those domain truths.
    Playback methods only slice the assembled in-memory session and never call
    a provider SDK per cursor step.
    """

    def __init__(
        self,
        repository_provider: Callable[[], MarketHistoryRepository | None],
        *,
        code_provider: Callable[[], list[str]] | None = None,
        metadata_provider: Callable[[str], Any | None] | None = None,
    ) -> None:
        self.repository_provider = repository_provider
        self.code_provider = code_provider
        self.metadata_provider = metadata_provider
        self._stock_summaries: dict[tuple[str, str], dict[str, Any]] = {}
        # date -> (store fingerprint, rows), most recently used last, at most LIST_CACHE_DATES dates (unbounded, these
        # would grow with every date viewed and outlive a later materialization of the date).
        self._stock_lists: OrderedDict[str, tuple[str, list[dict[str, Any]]]] = OrderedDict()
        self._technical_reader: TechnicalHistoryReader | None = None
        self._lock = RLock()
        self._timing: dict[str, Any] = {"product_list_total_ms": 0.0, "session_load_total_ms": 0.0, "product_list_count": 0, "selection_tests": 0, "identity_mismatch_count": 0, "data_lookup_failures": 0}

    @staticmethod
    def _date(value: str) -> str:
        return datetime.strptime(str(value), "%Y-%m-%d").strftime("%Y-%m-%d")

    def _repository(self) -> MarketHistoryRepository:
        repo = self.repository_provider()
        if repo is None:
            raise RuntimeError("Shioaji historical repository 尚未就緒")
        return repo

    @staticmethod
    def _optional_number(value: Any) -> float | None:
        try:
            if value in (None, ""):
                return None
            parsed = float(value)
            return None if pd.isna(parsed) else parsed
        except (TypeError, ValueError):  # not an error: value coercion: a non-numeric value is None (missing) by contract
            return None

    @staticmethod
    def _is_stock_replay_code(value: Any) -> bool:
        """Keep reference/index/futures products out of the stock sidebar.

        TAIEX and TXF remain available through their dedicated overlay session
        endpoints; they are not selectable stock replay products.
        """
        code = str(value or "").strip().upper()
        if not code or code in {"TAIEX", "TXF", "TXFR1"}:
            return False
        return not code.startswith(("TXF", "MXF", "TMF"))

    @staticmethod
    def _local_stock_dates(repo: MarketHistoryRepository) -> list[str]:
        """Dates that own replayable STK Tick/TradeDetail facts.

        Index/futures-only dates and synthetic weekdays are not stock replay
        sessions. Production history reads are local-only, so exposing those
        dates merely creates a watch-universe page whose charts can never load.
        """
        try:
            return sorted(repo.historical.list_dates("STK"), reverse=True)
        except Exception as exc:
            record_failure(_failure_log, "listing historical STK dates", exc)
            return []

    def list_dates(self) -> list[str]:
        """The days 歷史回放 can open: the materialized ones, and those Market Runtime recorded and has not materialized
        yet, which it plays from its own WAL (replay_feed.rs recorded_partition). Read each time: a day appears when it
        has traded and becomes a materialized one with no restart of this service."""
        repo = self.repository_provider()
        if repo is None:
            return []
        materialized = self._local_stock_dates(repo)
        recorded = PartitionEvidence().traded_dates("shioaji", "STK", "DAY", excluding=materialized)
        return sorted({*materialized, *recorded}, reverse=True)

    def get_pair_indexes(self, date_text: str, code: str) -> dict[str, Any]:
        """帳務 配對回放's 走勢資訊: the day's stored TAIEX and the stock's 產業指數 (sector_indexes.py owns that link),
        each as minute points with its 昨收. A day not stored yet has no points here: the renderer reads Market
        Runtime's IDX view of the same codes instead (as 歷史回放 reads the TAIEX)."""
        date_text, code = self._date(date_text), str(code or "").strip().upper()
        if not code:
            raise ValueError("code is required")
        repo = self._repository()
        link = sector_indexes.stock_industry_index(code, self.metadata_provider(code) if self.metadata_provider else None)
        index = link.get("index") or None
        industry = {"code": index["code"] if index else "", "name": index["name"] if index else "",
                    "reason": "" if index else "NO_INDUSTRY_INDEX"}
        return {
            "date": date_text, "code": code,
            "market": {"code": "TAIEX", "name": "加權", "reason": "", **index_day(repo, date_text, "TAIEX")},
            "industry": {**industry, **(index_day(repo, date_text, index["code"]) if index else {"points": [], "prev_close": None})},
        }

    def _technical(self) -> TechnicalHistoryReader:
        with self._lock:
            if self._technical_reader is None:
                self._technical_reader = TechnicalHistoryReader(process_kbar_root())
            return self._technical_reader

    def get_kline(self, code: str, market: str = "STK", session: str = "DAY", resolution: str = "day", before: str | None = None,
                  limit: int | None = None) -> dict[str, Any]:
        """技術分析's history: a page of one product's local minute days (`minute`) or daily bars (`day`) strictly before
        `before`. Days this machine does not hold are simply not in the answer."""
        normalized = str(code or "").strip().upper()
        scope = str(market or "").strip().upper(), str(session or "").strip().upper()
        if resolution not in {"minute", "day"}:
            raise ValueError("invalid resolution")
        if not valid_code(normalized) or not valid_scope(*scope):
            raise ValueError("invalid code")
        anchor = self._date(before) if before else None
        reader = self._technical()
        return (reader.minute_days(*scope, normalized, anchor, limit) if resolution == "minute"
                else reader.daily_bars(*scope, normalized, anchor, limit))

    def list_stocks(self, date_text: str, *, include_summaries: bool = True) -> list[dict[str, Any]]:
        """List locally available replay products with compact chart summaries.

        Durable identity metadata decides which products exist. Locally persisted
        formal trades supply the exact OHLC/volume summary used by the sidebar and
        daily/weekly/monthly K-line endpoint; minute trend is a local fallback.
        """
        started = time.perf_counter()
        date_text = self._date(date_text)
        repo = self._repository()
        fingerprint = self._date_fingerprint(repo, date_text)
        if include_summaries:
            with self._lock:
                cached = self._stock_lists.get(date_text)
                if cached is not None and cached[0] == fingerprint:
                    self._stock_lists.move_to_end(date_text)
                    return [dict(item) for item in cached[1]]
                if cached is not None:
                    self._forget_date_locked(date_text)
        rows: list[dict[str, Any]] = []
        by_code: dict[str, dict[str, Any]] = {}
        try:
            indexed_codes = [
                {"logical_code": row.get("logical_code"), "part_count": row.get("event_count")}
                for row in repo.historical.list_partitions("STK", date_text)
            ]
        except Exception as exc:
            record_failure(_failure_log, "listing the indexed partitions of a date", exc)
            indexed_codes = []
        for indexed in indexed_codes:
            code = str(indexed.get("logical_code") or "").upper()
            if not self._is_stock_replay_code(code):
                continue
            current = by_code.setdefault(code, {
                "code": code, "name": "", "rows": 0, "open": None, "high": None, "low": None, "close": None,
                "prev_close": None, "change": None, "change_pct": None, "cached": True, "source": "raw_tick_index",
                "has_trade_detail": True, "has_tick": True, "has_bidask": False, "sessions": ["DAY"], "actual_contracts": [],
                "first_timestamp": None, "last_timestamp": None,
            })
            current["rows"] = int(indexed.get("part_count") or 0)
        # TradeDetail identities normally cover the replayable stock universe.
        # Raw catalog discovery performs several additional SQLite queries, so
        # reserve it for older/tick-only dates that have no materialized index.
        cached_codes = [] if by_code else repo.list_materialized_codes(date_text)
        for code in cached_codes:
            code = str(code).upper()
            if not self._is_stock_replay_code(code):
                continue
            current = by_code.setdefault(code, {
                "code": code, "name": "", "rows": 0, "open": None, "high": None, "low": None, "close": None,
                "prev_close": None, "change": None, "change_pct": None, "cached": True, "source": "raw_partition_manifest",
                "has_trade_detail": False, "has_tick": True, "has_bidask": False, "sessions": [], "actual_contracts": [],
                "first_timestamp": None, "last_timestamp": None,
            })
            current["has_tick"] = True
        # BidAsk parts live in the canonical evidence hierarchy. The metadata
        # catalog is its authority; scanning the retired stream_dir layout made
        # existing books appear absent in the product list.
        try:
            bidask_codes = [] if by_code else [
                {"logical_code": row.get("logical_code")}
                for row in repo.historical.list_partitions("STK", date_text)
                if ORDERBOOK_LANE in (row.get("lane_report") or {})
            ]
        except Exception as exc:
            record_failure(_failure_log, "listing the order-book partitions of a date", exc)
            bidask_codes = []
        for identity in bidask_codes:
            code = str(identity.get("logical_code") or "").upper()
            if not self._is_stock_replay_code(code):
                continue
            current = by_code.setdefault(code, {
                "code": code, "name": "", "rows": 0, "open": None, "high": None, "low": None, "close": None,
                "prev_close": None, "change": None, "change_pct": None, "cached": True, "source": "raw_partition_manifest",
                "has_trade_detail": False, "has_tick": False, "has_bidask": True, "sessions": [], "actual_contracts": [],
                "first_timestamp": None, "last_timestamp": None,
            })
            current["has_bidask"] = True
        # If there is no local market data for this date, expose the watch universe
        # as lazy targets without scanning or remote API calls.
        if not by_code:
            for code in sorted(set(list(self.code_provider() or []) if self.code_provider else [])):
                if not self._is_stock_replay_code(code):
                    continue
                by_code[str(code)] = {"code": str(code), "name": "", "rows": 0, "open": None, "high": None, "low": None, "close": None, "prev_close": None, "change": None, "change_pct": None, "cached": False, "source": "watch_universe", "has_trade_detail": False, "has_tick": False, "has_bidask": False, "sessions": [], "actual_contracts": [], "first_timestamp": None, "last_timestamp": None}
        date_projection: dict[str, dict[str, Any]] = {}
        if include_summaries:
            try:
                date_projection = {
                    str(row.get("logical_code") or "").upper(): dict(row)
                    for row in repo.session_summary_store.list_date(market="STK", trading_date=date_text, session="DAY")
                }
            except Exception as exc:
                record_failure(_failure_log, "reading the date projection", exc)
        for code, item in sorted(by_code.items()):
            # Only products backed by local data are summarized.  Watch-universe
            # placeholders remain index-only so an empty date cannot fan out into
            # dozens of disk reads.  A summary is cached with the date list and is
            # invalidated together with replay data after repair/materialization.
            summary: dict[str, Any] = dict(date_projection.get(code) or {}) if include_summaries and item.get("cached") else {}
            if include_summaries and summary:
                item.update(summary)
                close = self._optional_number(item.get("close"))
                previous_close = self._optional_number(item.get("prev_close"))
                reference_source = "SESSION_SUMMARY" if previous_close is not None else "UNAVAILABLE"
                item["change_reference_source"] = reference_source if previous_close is not None else "UNAVAILABLE"
                move = resolve_market_move(current=close, prev_close=previous_close)
                if move.price_change is not None:
                    item["change"] = move.price_change
                    item["change_pct"] = move.pct_change
                item["summary_state"] = "READY"
            elif include_summaries and item.get("cached"):
                item["summary_state"] = "SOURCE_EMPTY"
            meta = self.metadata_provider(code) if self.metadata_provider else None
            item["name"] = getattr(meta, "name", "") if meta else item.get("name", "")
            rows.append(item)
        if include_summaries:
            with self._lock:
                for item in rows:
                    summary_code = str(item.get("code") or "").upper()
                    if summary_code:
                        self._stock_summaries[(date_text, summary_code)] = dict(item)
                self._stock_lists[date_text] = (fingerprint, [dict(item) for item in rows])
                self._stock_lists.move_to_end(date_text)
                while len(self._stock_lists) > LIST_CACHE_DATES:
                    self._forget_date_locked(next(iter(self._stock_lists)))
        elapsed = (time.perf_counter() - started) * 1000.0
        timing_key = "product_list_total_ms" if include_summaries else "product_index_total_ms"
        self._timing.update({timing_key: round(elapsed, 3), "product_list_count": len(rows)})
        return rows

    def _forget_date_locked(self, date_text: str) -> None:
        """Drop one date's product list and summaries (stale, or evicted to keep the cache bounded)."""
        self._stock_lists.pop(date_text, None)
        for key in [key for key in self._stock_summaries if key[0] == date_text]:
            self._stock_summaries.pop(key, None)

    @staticmethod
    def _date_fingerprint(repo: MarketHistoryRepository, date_text: str) -> str:
        try:
            return str(repo.date_fingerprint(date_text))
        except Exception as exc:
            record_failure(_failure_log, "reading the date fingerprint", exc)
            return ""

    def get_reference_tick_session(self, date_text: str) -> dict[str, Any]:
        """The materialized full-session minute closes of a replay overlay (B's minute trend; none when the date is
        not materialized). Historical futures identity is the materialized partition's, never today's current-contract
        mapping."""
        normalized = self._date(date_text)
        market, code = "FUT", "TXFR1"
        repo = self._repository()
        # The day session's 參考價 (the materialized summary's comparison price): the baseline the replay overlay
        # draws this series from, as the stock is drawn from its own 昨收.
        reference_price = day_reference_price(repo, market, code, normalized)
        try:
            # FUT FULL is the business day: the night before it plus its day. With no session the
            # store returned the date's DAY and the NIGHT that opens that evening (the next trading date's).
            local = repo.minute_trend_store.load_date(market=market, trading_date=normalized, logical_code=code,
                                                      session="FULL")
        except Exception as exc:
            record_failure(_failure_log, "reading the minute trend store", exc)
            local = pd.DataFrame()
        if local is not None and not local.empty:
            df = local.copy()
            df["minute_timestamp"] = pd.to_datetime(df.get("minute_timestamp"), errors="coerce")
            df["price"] = pd.to_numeric(df.get("price"), errors="coerce")
            df = df.dropna(subset=["minute_timestamp", "price"]).sort_values(["minute_timestamp", "ingest_sequence"], kind="stable")
            points = []
            for _, row in df.iterrows():
                stamp = row["minute_timestamp"]
                avg = pd.to_numeric(pd.Series([row.get("average_price")]), errors="coerce").iloc[0]
                points.append({
                    "datetime": stamp.isoformat(), "timestamp": stamp.isoformat(), "time": stamp.strftime("%H:%M:%S"),
                    "price": float(row["price"]), "average_price": None if pd.isna(avg) else float(avg),
                    "source_tick_timestamp": str(row.get("source_tick_timestamp") or ""),
                    "actual_contract": str(row.get("actual_contract") or ""),
                    "source": "local_minute_trend_materialized",
                })
            actual = str(df.iloc[-1].get("actual_contract") or "") if not df.empty else ""
            return {
                "date": normalized, "code": code, "actual_contract": actual, "count": len(points), "points": points,
                "reference_price": reference_price, "source": "local_minute_trend_materialized",
            }
        return {"date": normalized, "code": code, "count": 0, "points": [], "reference_price": reference_price, "source": None}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "timing": dict(self._timing),
            }
