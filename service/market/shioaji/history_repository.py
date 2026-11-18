from __future__ import annotations

import logging
from datetime import date, datetime
from pathlib import Path
from threading import RLock
from typing import Any, Callable

import pandas as pd

from service.market.storage.market_storage_layout import MarketStorageLayout
from service.market.history.historical_work_coordinator import HistoricalWorkCoordinator
from service.market.history.historical_store import (
    HistoricalMinuteTrendReader, HistoricalStore, HistoricalSummaryReader,
)
from service.market.shioaji.restart_backfill import QUERY_PACER
from service.platform.api_call_log import api_call
from service.market.shared.session_identity_contract import iso_trading_date
from service.platform.failure_record import record_failure

logger = logging.getLogger(__name__)


class ShioajiHistoricalRepository:
    """Canonical historical market-data repository.

    Consumers never call ``api.ticks`` / ``api.kbars`` directly.  The repository
    resolves the Shioaji contract, normalizes the broker payload into the internal
    schema, and persists a local parquet cache.  Historical APIs are never used as
    a realtime polling source.
    """

    def __init__(
        self,
        api_provider: Callable[[], Any | None],
        *,
        layout: MarketStorageLayout,
        historical_root: str | Path,
    ) -> None:
        # Every path comes from the composition root: a repository built over a temporary
        # layout never creates or reads anything under the process's data root.
        self._api_provider = api_provider
        # ONE historical read boundary: the Rust Historical Materializer's store.
        # Nothing here reads or writes any other historical projection store.
        self.historical = HistoricalStore(historical_root)
        self.minute_trend_store = HistoricalMinuteTrendReader(self.historical)
        self.session_summary_store = HistoricalSummaryReader(self.historical)
        self._metrics_lock = RLock()
        self._work = HistoricalWorkCoordinator(name="HistoricalMarketDataWorker", max_workers=3, queue_size=128)
        self._metrics: dict[str, int] = {
            "history_fetch_count": 0,
            "history_fetch_rows": 0,
            "history_fetch_bytes": 0,
            "history_fetch_failures": 0,
        }


    def metrics(self) -> dict[str, Any]:
        """O(1) in-memory metrics; never waits on cache/history IO locks."""
        with self._metrics_lock:
            result: dict[str, Any] = dict(self._metrics)
        result["work"] = self._work.metrics()
        return result

    def lightweight_metrics(self) -> dict[str, Any]:
        """Health-safe counters only; never delegate through repository IO paths."""
        with self._metrics_lock:
            result: dict[str, Any] = dict(self._metrics)
        work = self._work.metrics()
        result["work"] = {
            key: work.get(key)
            for key in (
                "active", "queued", "inflight", "waiters", "started", "joined",
                "completed", "failed", "cancelled", "rejected", "parallel_peak",
                "worker_count", "worker_threads_alive", "accepting", "forced_abandon_count",
            )
        }
        return result

    def _metric_bump(self, name: str, amount: int = 1) -> None:
        with self._metrics_lock:
            self._metrics[name] = int(self._metrics.get(name, 0)) + int(amount)

    def freeze_historical_work(self) -> dict[str, Any]:
        return self._work.freeze_new_work(cancel_queued=True)

    def wait_historical_idle(self, timeout: float = 8.0) -> bool:
        return self._work.wait_for_idle(timeout)

    def shutdown_historical_work(self, timeout: float = 8.0) -> dict[str, Any]:
        return self._work.shutdown(timeout=timeout)

    @staticmethod
    def normalize_date(value: str | date | datetime) -> str:
        return iso_trading_date(value)

    @staticmethod
    def _safe_code(code: str) -> str:
        value = str(code or "").strip().upper()
        if not value or any(ch in value for ch in "\\/:*?\"<>|"):
            raise ValueError("invalid contract code")
        return value

    @staticmethod
    def _to_frame(payload: Any) -> pd.DataFrame:
        if payload is None:
            return pd.DataFrame()
        if isinstance(payload, pd.DataFrame):
            return payload.copy()
        native_dict = getattr(payload, "dict", None)
        if callable(native_dict):
            try:
                value = native_dict()
                if isinstance(value, dict):
                    return pd.DataFrame(value)
            except Exception:  # not an error: SDK payload conversion: that shape failed, the next shape is tried
                pass
        # Shioaji 1.7 returns a native ``Ticks(MappingMixin)`` object.  It has
        # items()/keys() but is neither a dict nor a pandas-style to_dict()
        # object; passing it straight to DataFrame iterates field names and can
        # silently produce an empty frame.
        items = getattr(payload, "items", None)
        if callable(items):
            try:
                return pd.DataFrame(dict(items()))
            except Exception:  # not an error: SDK payload conversion: that shape failed, the next shape is tried
                pass
        if hasattr(payload, "to_dict"):
            try:
                value = payload.to_dict()
                if isinstance(value, dict):
                    return pd.DataFrame(value)
            except Exception:  # not an error: SDK payload conversion: that shape failed, the next shape is tried
                pass
        if isinstance(payload, dict):
            return pd.DataFrame(payload)
        try:
            return pd.DataFrame(payload)
        except Exception as exc:
            record_failure(logger, "converting a Shioaji history payload to a frame", exc)
            return pd.DataFrame()

    @staticmethod
    def _column(df: pd.DataFrame, *names: str, default: Any = None) -> pd.Series:
        for name in names:
            if name in df.columns:
                return df[name]
        return pd.Series([default] * len(df), index=df.index)

    @classmethod
    def _normalize_kbars(cls, payload: Any, *, code: str, date_text: str) -> pd.DataFrame:
        raw = cls._to_frame(payload)
        if raw.empty:
            return pd.DataFrame(columns=["datetime", "code", "open", "high", "low", "close", "volume", "amount", "source"])
        df = pd.DataFrame(index=raw.index)
        parsed = pd.to_datetime(cls._column(raw, "ts", "datetime"), errors="coerce")
        # Shioaji may return naive exchange timestamps or timezone-aware values
        # depending on SDK version.  Normalize aware values to the market's
        # Asia/Taipei trading date before partitioning; naive values already
        # represent exchange local time.
        try:
            if getattr(parsed.dt, "tz", None) is not None:
                parsed = parsed.dt.tz_convert("Asia/Taipei")
        except Exception:  # not an error: timestamps without a timezone are already Taipei time
            pass
        df["datetime"] = parsed
        df["exchange_date"] = parsed.dt.strftime("%Y-%m-%d").fillna(date_text)
        df["exchange_time"] = parsed.dt.strftime("%H:%M:%S")
        df["code"] = code
        for name in ("open", "high", "low", "close", "volume", "amount"):
            # The SDK's Kbars fields are capitalized (Open, High, ...).
            df[name] = pd.to_numeric(cls._column(raw, name, name.capitalize()), errors="coerce")
        df["source"] = "shioaji_historical_kbars"
        return df.dropna(subset=["datetime"]).sort_values("datetime", kind="stable").reset_index(drop=True)

    def _api(self) -> Any:
        api = self._api_provider()
        if api is None:
            raise RuntimeError("Shioaji 尚未登入，且本機沒有此歷史快取")
        return api

    @staticmethod
    def _resolve_contract(api: Any, code: str) -> Any:
        contracts = getattr(api, "contracts", None)
        if contracts is None:
            raise RuntimeError("Shioaji contracts 尚未就緒")
        # Shioaji 1.7.2's ContractsApi.get resolves a stock, an index and a continuous future alike.
        contract = contracts.get(code)
        if contract is None:
            raise KeyError(f"Shioaji contract not found: {code}")
        return contract

    def fetch_broker_kbars_for_download(
        self,
        code: str,
        start: str | date | datetime,
        end: str | date | datetime | None = None,
    ) -> pd.DataFrame:
        """Fetch official Shioaji minute K-bars for an explicit download job.

        Called only by the daemon-owned Kbar download manager after its budget reservation; every other read here is
        the local historical store.
        """
        code_n = self._safe_code(code)
        start_text = self.normalize_date(start)
        end_text = self.normalize_date(end or start)
        if (datetime.strptime(end_text, "%Y-%m-%d") - datetime.strptime(start_text, "%Y-%m-%d")).days >= 30:
            raise ValueError("Shioaji kbars date range must be shorter than 30 days")
        key = f"broker-kbars-download:{code_n}:{start_text}:{end_text}"

        def _fetch() -> pd.DataFrame:
            try:
                api = self._api()
                contract = self._resolve_contract(api, code_n)
                kbars_api = getattr(api, "kbars", None)
                if not callable(kbars_api):
                    raise RuntimeError("Shioaji kbars API unavailable")
                # The one place this repository actually asks the broker for data: every other
                # read here is the local Rust-materialized HistoricalStore, which is not an API
                # call and must not appear in the API log.
                QUERY_PACER.wait()
                with api_call("shioaji", "kbars", reason="kbar_download_job", market="STK",
                              symbols=[code_n], request_id=key) as call:
                    call.detail["start"] = start_text
                    call.detail["end"] = end_text
                    payload = kbars_api(contract, start=start_text, end=end_text)
                frame = self._normalize_kbars(payload, code=code_n, date_text=start_text)
                self._metric_bump("history_fetch_count")
                self._metric_bump("history_fetch_rows", int(len(frame)))
                self._metric_bump("history_fetch_bytes", int(frame.memory_usage(index=True, deep=True).sum()))
                return frame
            except Exception:
                self._metric_bump("history_fetch_failures")
                raise

        return self._work.run(key, _fetch, timeout=90.0)

    def date_fingerprint(self, date_value: str | date | datetime) -> str:
        """The materialized STK content of a date (what the replay product list is built from)."""
        return self.historical.date_fingerprint("STK", self.normalize_date(date_value))

    def list_materialized_dates(self) -> list[str]:
        return self.historical.list_dates()

    def list_materialized_codes(self, date_value: str) -> list[str]:
        date_text = self.normalize_date(date_value)
        codes: set[str] = set()
        for market in ("STK", "FUT", "IDX"):
            codes.update(self.historical.list_codes(date_text, market))
        return sorted(codes)
