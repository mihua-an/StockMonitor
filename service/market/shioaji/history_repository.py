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
from service.market.shared.volume import wire as _volume_wire
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

    @staticmethod
    def _parse_timestamp_series(values: Any) -> pd.Series:
        """Parse mixed historical/recorder timestamp schemas without data loss.

        Pandas infers one format from the first non-null value when ``format``
        is omitted.  A recorder partition can legitimately mix microsecond
        timestamps with close-capture rows such as ``13:30:00``; in that case
        the latter silently become ``NaT`` and a repair readback looks short.
        ``format='mixed'`` is available on current pandas; the fallback keeps
        the repository usable on older bundled versions.
        """
        try:
            return pd.to_datetime(values, errors="coerce", format="mixed")
        except (TypeError, ValueError):  # not an error: an older pandas without format=mixed: parsed below without it
            parsed = pd.to_datetime(values, errors="coerce")
            if parsed.isna().any():
                text = pd.Series(values, index=getattr(values, "index", None), dtype="object")
                fallback = pd.to_datetime(text.astype(str), errors="coerce")
                parsed = parsed.fillna(fallback)
            return parsed

    @classmethod
    def normalize_ticks(cls, payload: Any, *, code: str, date_text: str) -> pd.DataFrame:
        """A broker tick payload as this repository's tick frame (datetime as Taipei wall time, price, volume, ...)."""
        return cls._normalize_ticks(payload, code=code, date_text=date_text)

    @classmethod
    def _normalize_ticks(cls, payload: Any, *, code: str, date_text: str) -> pd.DataFrame:
        raw = cls._to_frame(payload)
        if raw.empty:
            return pd.DataFrame(columns=[
                "datetime", "exchange_date", "exchange_time", "code", "price",
                "volume", "total_volume", "tick_type", "simtrade",
            ])
        df = pd.DataFrame(index=raw.index)
        ts = cls._column(raw, "ts", "datetime", "time")
        parsed = cls._parse_timestamp_series(ts)
        if parsed.isna().all() and "time" in raw.columns:
            parsed = pd.to_datetime(date_text + " " + raw["time"].astype(str), errors="coerce")
        df["datetime"] = parsed
        df["exchange_date"] = parsed.dt.strftime("%Y-%m-%d").fillna(date_text)
        df["exchange_time"] = parsed.dt.strftime("%H:%M:%S.%f").str.rstrip("0").str.rstrip(".")
        df["code"] = code
        df["price"] = pd.to_numeric(cls._column(raw, "close", "price"), errors="coerce")
        # Volumes are decimal quantities everywhere (service.market.shared.volume): float64, never int64-truncated.
        df["volume"] = pd.to_numeric(cls._column(raw, "volume"), errors="coerce").fillna(0).astype("float64")
        cumulative = pd.to_numeric(cls._column(raw, "total_volume", "volume_acc"), errors="coerce")
        if cumulative.isna().all():
            cumulative = df["volume"].cumsum()
        df["total_volume"] = cumulative.ffill().fillna(0).astype("float64")
        df["tick_type"] = pd.to_numeric(cls._column(raw, "tick_type"), errors="coerce").fillna(0).astype("int64")
        simtrade = cls._column(raw, "simtrade", default=pd.NA).astype("object")
        flags = pd.to_numeric(cls._column(raw, "flags", default=pd.NA), errors="coerce")
        df["simtrade"] = simtrade
        df["flags"] = flags
        has_explicit = simtrade.notna()
        has_flags = flags.notna()
        encoded = ~has_explicit & has_flags
        if encoded.any():
            df.loc[encoded, "simtrade"] = flags.loc[encoded].astype("int64").map(lambda value: bool(value & 1))
        historical_trade_contract = ~has_explicit & ~has_flags
        if historical_trade_contract.any():
            # api.ticks(AllDay) is documented as historical tick-by-tick trades,
            # rather than the streaming TickSTKv1 callback envelope.  Record the
            # source-specific evidence explicitly instead of globally treating a
            # missing simtrade field as a formal trade.
            df.loc[historical_trade_contract, "simtrade"] = False
        return df.dropna(subset=["datetime", "price"]).sort_values("datetime", kind="stable").reset_index(drop=True)

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

    def fetch_broker_ticks_for_repair(
        self,
        code: str,
        date_value: str | date | datetime,
    ) -> pd.DataFrame:
        """Fetch official broker Tick history for an explicit repair job only.

        Normal history reads deliberately remain local-only.  Keeping broker IO
        behind this loudly named method prevents a renderer refresh from turning
        into Shioaji polling or competing with realtime callbacks.
        """
        code_n = self._safe_code(code)
        date_text = self.normalize_date(date_value)
        key = f"broker-repair-ticks:{code_n}:{date_text}"

        def _fetch() -> pd.DataFrame:
            try:
                api = self._api()
                contract = self._resolve_contract(api, code_n)
                ticks_api = getattr(api, "ticks", None)
                if not callable(ticks_api):
                    raise RuntimeError("Shioaji ticks API unavailable")
                payload = ticks_api(contract, date=date_text)
                frame = self._normalize_ticks(payload, code=code_n, date_text=date_text)
                self._metric_bump("history_fetch_count")
                self._metric_bump("history_fetch_rows", int(len(frame)))
                self._metric_bump("history_fetch_bytes", int(frame.memory_usage(index=True, deep=True).sum()))
                return frame
            except Exception:
                self._metric_bump("history_fetch_failures")
                raise

        return self._work.run(key, _fetch, timeout=45.0)

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

    def fetch_broker_final_volume_for_repair(
        self,
        code: str,
        date_value: str | date | datetime,
    ) -> dict[str, Any] | None:
        """Read an independent broker snapshot total for one closed stock date.

        Snapshot has no historical-date argument.  The result is usable only when
        its own timestamp resolves to the requested trading date; callers must
        reject stale/current-day mismatches.
        """
        code_n = self._safe_code(code)
        date_text = self.normalize_date(date_value)
        key = f"broker-repair-final-volume:{code_n}:{date_text}"

        def _value(row: Any, name: str) -> Any:
            if isinstance(row, dict):
                return row.get(name)
            return getattr(row, name, None)

        def _fetch() -> dict[str, Any] | None:
            api = self._api()
            contract = self._resolve_contract(api, code_n)
            snapshots = getattr(api, "snapshots", None)
            if not callable(snapshots):
                return None
            payload = snapshots([contract])
            if payload is None:
                return None
            if isinstance(payload, (list, tuple)):
                row = payload[0] if payload else None
            else:
                try:
                    row = payload.iloc[0] if isinstance(payload, pd.DataFrame) and not payload.empty else payload
                except Exception:  # not an error: a payload that is not a frame is read as the row itself
                    row = payload
            if row is None:
                return None
            total = pd.to_numeric(pd.Series([_value(row, "total_volume")]), errors="coerce").iloc[0]
            stamp_value = _value(row, "ts") or _value(row, "datetime")
            stamp = pd.to_datetime(stamp_value, errors="coerce")
            if pd.isna(total) or pd.isna(stamp):
                return None
            observed_date = stamp.date().isoformat()
            observed_code = str(_value(row, "code") or code_n).strip().upper()
            confidence = (
                "BROKER_SNAPSHOT_MATCHED_TRADING_DATE"
                if observed_date == date_text and observed_code == code_n and int(total) >= 0
                else "IDENTITY_MISMATCH"
            )
            return {
                "code": observed_code,
                "trading_date": observed_date,
                "requested_trading_date": date_text,
                "observed_at": stamp.isoformat(),
                "total_volume": _volume_wire(total),
                "source": "SHIOAJI_SNAPSHOT_TOTAL_VOLUME",
                "confidence": confidence,
            }

        return self._work.run(key, _fetch, timeout=15.0)

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
