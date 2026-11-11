from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _clean_value(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "item"):
        try:
            value = value.item()
        except Exception:  # not an error: an SDK scalar whose item() fails is kept as is and cleaned below
            pass
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _records(frame: Any) -> list[dict[str, Any]]:
    if frame is None:
        return []
    if isinstance(frame, list):
        return [{str(k): _clean_value(v) for k, v in row.items()} for row in frame if isinstance(row, dict)]
    if isinstance(frame, dict):
        return [{str(k): _clean_value(v) for k, v in frame.items()}]
    try:
        return [{str(k): _clean_value(v) for k, v in row.items()} for row in frame.to_dict("records")]
    except Exception as exc:
        record_failure(_failure_log, "converting the Futu security frame to rows", exc)
        return []


def _complete_as_of(rows: list[dict[str, Any]]) -> str:
    """When the master was last fetched in full: the oldest of each (market, type) group's newest ``updated_at``.

    Every fetched row carries the time of its fetch and a group a refresh could not fetch keeps its rows (and their
    times) from before, so the file itself records which groups are current: a partial refresh never reads back as
    today's complete one."""
    newest: dict[tuple[str, str], str] = {}
    for row in rows:
        key = (str(row.get("market") or "").lower(), str(row.get("type") or "").lower())
        newest[key] = max(newest.get(key, ""), str(row.get("updated_at") or ""))
    return min(newest.values(), default="")


# A refresh that came back partial is retried the same day, backing off from 5 minutes up to the 30 minutes of a
# refresh that failed outright.
_PARTIAL_RETRY_SECONDS = (300.0, 600.0, 1200.0, 1800.0)


class FutuSecurityMasterLifecycle:
    """Own OpenD security-master refresh state and reconciliation.

    ``updated_at`` is when the master was last fetched in FULL (``_complete_as_of``); ``refresh_due`` compares it with
    today, so a group that failed is fetched again the same day (after ``retry_after``)."""

    def __init__(
        self,
        *,
        path: Path,
        lock: threading.RLock,
        catalog: Any,
        sdk_provider: Callable[[], Any],
        call: Callable[..., Any],
        worker_alive: Callable[[], bool],
        wake: Callable[[], None],
    ) -> None:
        self.path = Path(path)
        self._lock = lock
        self._catalog = catalog
        self._sdk_provider = sdk_provider
        self._call = call
        self._worker_alive = worker_alive
        self._wake = wake
        self.rows: list[dict[str, Any]] = []
        self.codes: set[str] = set()
        self.market_counts: dict[str, int] = {"us": 0, "cc": 0}
        self.updated_at = ""
        self.error = ""
        self._groups_of: list[dict[str, Any]] | None = None
        self._groups: set[tuple[str, str]] = set()
        self.retry_after = 0.0
        self.cc_attempted_day = ""
        self.refresh_requested = False
        self.refresh_in_progress = False
        self.refresh_done = threading.Event()
        self.refresh_result: dict[str, Any] = {}
        self._partial_failures = 0

    def rows_snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self.rows]

    def known_codes_view(self) -> set[str]:
        """The known codes for reading only: the held set, replaced whole on a refresh and never changed in place."""
        with self._lock:
            return self.codes

    def known_codes(self) -> set[str]:
        with self._lock:
            return set(self.codes or {str(row.get("code") or "").upper() for row in self.rows})

    # A source file that is not there is not an empty security master. read_security_master()
    # returns [] for both, so a fresh install or a failed refresh would look like a
    # successful load of zero securities: error stayed None, count stayed 0, and callers could
    # not tell the two apart. Worse, the empty result then overwrote whatever was already
    # loaded. Report it, and keep the last known good rows.
    SOURCE_MISSING = "SECURITY_MASTER_NOT_FOUND"

    def load(self) -> list[dict[str, Any]]:
        source = getattr(self._catalog, "security_master_path", None)
        if source is not None and not Path(source).exists():
            with self._lock:
                self.error = self.SOURCE_MISSING
                return [dict(row) for row in self.rows]
        try:
            rows = self._catalog.read_security_master()
        except Exception as exc:
            record_failure(_failure_log, "reading the Futu security master", exc)
            with self._lock:
                self.error = str(exc)
            return []
        counts = {"us": 0, "cc": 0}
        for row in rows:
            market = str(row.get("market") or "").lower()
            if market in counts:
                counts[market] += 1
        with self._lock:
            self.error = "" if self.error == self.SOURCE_MISSING else self.error
            self.rows = rows
            self.codes = {str(row.get("code") or "").upper() for row in rows}
            self.market_counts = counts
            self.updated_at = _complete_as_of(rows)
            if counts.get("cc", 0) > 0:
                self.cc_attempted_day = self.updated_at[:10]
        return rows

    @property
    def _recovery(self):
        """The refetch of this master as one recorded recovery: open while refreshes fail or come back
        partial, finished by a complete one."""
        recovery = self.__dict__.get("_refetch_recovery")
        if recovery is None:
            from service.platform.remediation import Recovery

            recovery = Recovery(component="futu_security_master", mechanism_id="provider.metadata_refetch")
            self.__dict__["_refetch_recovery"] = recovery
        return recovery

    def refresh_due(self) -> bool:
        if time.monotonic() < self.retry_after:
            return False
        if not self.path.exists() or not self.rows:
            return True
        updated_day = str(self.updated_at or "")[:10]
        if updated_day != datetime.now(timezone.utc).date().isoformat():
            return True
        with self._lock:
            # Asked five times a second over tens of thousands of rows, which only change when replaced whole.
            if self._groups_of is not self.rows:
                self._groups_of = self.rows
                self._groups = {(str(row.get("market") or "").lower(), str(row.get("type") or "").lower()) for row in self.rows}
            if not {("us", "stock"), ("us", "etf")} <= self._groups:
                return True   # a group never fetched (a partial first refresh): the master is not complete
            has_crypto = int(self.market_counts.get("cc", 0)) > 0
        return False if has_crypto else self.cc_attempted_day != updated_day

    def refresh_if_needed(self, context: Any) -> dict[str, Any]:
        with self._lock:
            requested = self.refresh_requested
            self.refresh_requested = False
        if not requested and not self.refresh_due():
            return {"ok": True, "skipped": True, "count": len(self.rows)}
        with self._lock:
            self.refresh_in_progress = True
            self.refresh_done.clear()
        try:
            sdk = self._sdk_provider()
            markets = getattr(sdk, "Market")
            security_type = getattr(sdk, "SecurityType")
            updated_at = _utc_now()
            today = updated_at[:10]
            with self._lock:
                self.cc_attempted_day = today
                existing_rows = [dict(row) for row in self.rows]
            existing_by_group: dict[tuple[str, str], list[dict[str, Any]]] = {}
            for row in existing_rows:
                key = (str(row.get("market") or "").lower(), str(row.get("type") or "").lower())
                existing_by_group.setdefault(key, []).append(row)
            by_code: dict[str, dict[str, Any]] = {}
            requests = [
                (getattr(markets, "US"), getattr(security_type, "STOCK"), "us", "stock"),
                (getattr(markets, "US"), getattr(security_type, "ETF"), "us", "etf"),
            ]
            cc_supported = hasattr(markets, "CC") and hasattr(security_type, "CRYPTO")
            if cc_supported:
                requests.append((getattr(markets, "CC"), getattr(security_type, "CRYPTO"), "cc", "crypto"))
            warnings: list[str] = []

            def preserve_group(market_label: str, type_label: str) -> int:
                preserved = 0
                for old in existing_by_group.get((market_label, type_label), []):
                    code = str(old.get("code") or "").strip().upper()
                    if code:
                        by_code[code] = old
                        preserved += 1
                return preserved

            # Groups this refresh could not fetch and will try again (a call that failed or came back empty); a group
            # the SDK does not offer is kept as well but is not retried -- no retry can fetch it.
            failed_groups: list[str] = []
            if not cc_supported:
                preserved = preserve_group("cc", "crypto")
                warnings.append(f"cc/crypto: SDK unsupported; preserved={preserved}")
            for market, kind, market_label, type_label in requests:
                try:
                    source_rows = _records(self._call(context, "get_stock_basicinfo", market, kind))
                except Exception as exc:
                    record_failure(_failure_log, f"fetching the Futu {market_label}/{type_label} security master group", exc)
                    preserved = preserve_group(market_label, type_label)
                    warnings.append(f"{market_label}/{type_label}: {exc}; preserved={preserved}")
                    failed_groups.append(f"{market_label}/{type_label}")
                    continue
                fetched = 0
                for row in source_rows:
                    code = str(row.get("code") or "").strip().upper()
                    if not code or bool(row.get("delisting")):
                        continue
                    fetched += 1
                    by_code[code] = {
                        "code": code,
                        "name": str(row.get("name") or code).strip(),
                        "market": market_label,
                        "type": type_label,
                        "exchange_type": str(row.get("exchange_type") or ""),
                        "lot_size": row.get("lot_size") or "",
                        "listing_date": row.get("listing_date") or "",
                        "stock_id": row.get("stock_id") or "",
                        "delisting": False,
                        "source": "moomoo_get_stock_basicinfo",
                        "updated_at": updated_at,
                    }
                if fetched == 0:
                    preserved = preserve_group(market_label, type_label)
                    warnings.append(f"{market_label}/{type_label}: empty response; preserved={preserved}")
                    failed_groups.append(f"{market_label}/{type_label}")
            rows = sorted(by_code.values(), key=lambda row: (row["market"], row["type"], row["code"]))
            if not rows:
                raise RuntimeError("Moomoo OpenD 未回傳 US/CC 商品")
            self._catalog.write_security_master(rows)
            # The product catalog's owner (app_api) rebuilds from it now, not at the next start. Committed above:
            # the notice's result is reported, never turned into a failed refresh.
            from service.market.reference import security_master_feed

            notice = security_master_feed.publish_written("futu", self.path)
            with self._lock:
                self.rows = rows
                self.codes = {str(row.get("code") or "").upper() for row in rows}
                self.market_counts = {
                    "us": sum(1 for row in rows if row.get("market") == "us"),
                    "cc": sum(1 for row in rows if row.get("market") == "cc"),
                }
                if failed_groups:
                    # Not complete as of now: the failed groups keep their older time, and are retried today.
                    retry_seconds = _PARTIAL_RETRY_SECONDS[min(self._partial_failures, len(_PARTIAL_RETRY_SECONDS) - 1)]
                    self._partial_failures += 1
                    # A group with no earlier rows is absent from `rows`, so the file alone could read as complete.
                    self.updated_at = min(self.updated_at, _complete_as_of(rows))
                    self.error = f"partial refresh: {', '.join(failed_groups)} not fetched"
                    self.retry_after = time.monotonic() + retry_seconds
                else:
                    self._partial_failures = 0
                    self.updated_at = updated_at
                    self.error = ""
                    self.retry_after = 0.0
            # Which groups this refresh actually fetched and which it kept from before: a kept group is
            # stated, never passed off as fresh.
            preserved_groups = [w.split(":", 1)[0] for w in warnings]
            result = {
                "ok": True,
                "count": len(rows),
                "updated_at": updated_at,
                "file": str(self.path),
                "source": "moomoo_get_stock_basicinfo",
                "markets": dict(self.market_counts),
                "coverage": "PARTIAL" if preserved_groups else "COMPLETE",
                "preserved_groups": preserved_groups,
                "retry_groups": failed_groups,
                "complete_as_of": self.updated_at or None,
                "warnings": warnings,
                "notice": notice,
            }
            if preserved_groups:
                self._recovery.failed("futu_master_partial", detail={"preserved_groups": preserved_groups})
            else:
                self._recovery.finish("succeeded", detail={"rows": len(rows)})
        except Exception as exc:
            with self._lock:
                self.error = str(exc)
                self.retry_after = time.monotonic() + 1800.0
            result = {
                "ok": False,
                "count": len(self.rows),
                "file": str(self.path),
                "error": str(exc),
                "coverage": "STALE" if self.path.exists() else "ABSENT",
                "preserved_existing": self.path.exists(),
            }
            self._recovery.failed("futu_master_failed", detail={"error": str(exc)[:300], "retry_seconds": 1800.0})
        with self._lock:
            self.refresh_result = dict(result)
            self.refresh_in_progress = False
        self.refresh_done.set()
        return result

    def ensure_current(self, timeout: float = 30.0) -> dict[str, Any]:
        with self._lock:
            if not self.refresh_due():
                return {
                    "ok": True,
                    "skipped": True,
                    "count": len(self.rows),
                    "updated_at": self.updated_at or None,
                    "file": str(self.path),
                }
        return self.refresh(timeout=timeout)

    def refresh(self, timeout: float = 30.0) -> dict[str, Any]:
        with self._lock:
            if not self._worker_alive():
                return {"ok": False, "error": "Moomoo worker 尚未啟動"}
            already_running = self.refresh_in_progress
            if not already_running:
                self.refresh_done.clear()
                self.refresh_requested = True
        if not already_running:
            self._wake()
        if not self.refresh_done.wait(max(0.1, float(timeout))):
            return {
                "ok": False,
                "error": "更新 Moomoo 商品資料逾時",
                "count": len(self.rows),
                "preserved_existing": self.path.exists(),
            }
        with self._lock:
            return dict(self.refresh_result)

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "count": len(self.rows),
                "markets": dict(self.market_counts),
                "updated_at": self.updated_at or None,
                "last_error": self.error or None,
                "retry_after_seconds": max(0, round(self.retry_after - time.monotonic())),
            }
