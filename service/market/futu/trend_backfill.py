"""Today's trend before a late join, for Futu. A code that joins the subscription plan while this provider runs (the
user added it, a view opened it) only receives RT_DATA minute bars from the subscription on, so the 個股走勢 began
mid-day with nothing before it. Its earlier 分時 is read once from OpenD (get_rt_data, the same rows as the push) and
admitted as backfill minute bars (callback.publish_minute_backfill): Rust B keeps a backfill bar strictly before the
cut-off, where the live stream takes over (accum.rs).

Only a code that is new to the plan is read. The first plan this provider receives is what was already subscribed
before it started (an App restart re-sends the same plan): none of its codes is a late join, and none is read.

Recorded as provider.futu_trend_backfill (late_join): not an error when the user added the instrument, one operation
per code, succeeded with the minutes published or failed.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from service.market.shared.session_identity_contract import futu_partition_date
from service.platform import remediation

logger = logging.getLogger(__name__)

BATCH = 10                      # codes read per cycle at most (one get_rt_data call each)
RETRY_SECONDS = 60.0            # after a failed read of a code
# OpenD paces high-frequency reads (get_rt_data among them); one cycle's reads at most this often, whatever happens, so
# a code whose read keeps failing never turns into a call on every 0.2 s worker cycle.
MIN_CALL_INTERVAL_SECONDS = 2.0


def _market_of(code: str) -> str:
    return code.split(".", 1)[0].upper() if "." in code else "US"


def _normalized(codes: Iterable[str]) -> set[str]:
    return {str(c).strip().upper() for c in codes if str(c).strip()}


class FutuTrendBackfill:
    """Reads the earlier 分時 of each code that newly joined the plan, once, and publishes it as backfill minute bars."""

    def __init__(self, publish: Callable[[str, Any, int], tuple[int, int]], *,
                 now: Callable[[], datetime] | None = None, monotonic: Callable[[], float] = time.monotonic,
                 clock_ns: Callable[[], int] = time.time_ns) -> None:
        # publish(code, rows, cutoff_ns) -> (published, skipped)
        self._publish = publish
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._monotonic = monotonic
        self._clock_ns = clock_ns
        # The plan is replaced from the plan receiver's thread; the reads run on the OpenD worker.
        self._lock = threading.Lock()
        self._planned: set[str] | None = None     # the plan's codes; None until the first plan arrives
        self._pending: set[str] = set()           # codes that joined the plan and are not backfilled yet
        self._failed_at: dict[str, float] = {}    # code -> when its read last failed
        self._last_call_at: float | None = None
        self.calls = 0
        self.filled = 0
        self.published = 0
        self.skipped = 0
        self.failures = 0
        self.last_error = ""
        self.last_failure: dict[str, Any] | None = None

    def plan_replaced(self, codes: Iterable[str]) -> None:
        """The subscription plan's codes, each time the plan is replaced. A code added to it is to be backfilled; one
        dropped from it is no longer (added again later, it is a new join)."""
        codes = _normalized(codes)
        with self._lock:
            if self._planned is not None:
                self._pending |= codes - self._planned
            self._pending &= codes
            for code in [code for code in self._failed_at if code not in self._pending]:
                self._failed_at.pop(code, None)
            self._planned = codes

    def due(self, subscribed: Iterable[str]) -> list[str]:
        """The newly-joined codes OpenD now pushes 分時 for, whose last failed read has backed off."""
        subscribed = _normalized(subscribed)
        now = self._monotonic()
        with self._lock:
            if self._last_call_at is not None and now - self._last_call_at < MIN_CALL_INTERVAL_SECONDS:
                return []
            return sorted(code for code in self._pending & subscribed
                          if code not in self._failed_at or now - self._failed_at[code] >= RETRY_SECONDS)

    def run(self, fetch: Callable[[str], Any], subscribed: Iterable[str]) -> int:
        """Read the due codes' earlier 分時 and publish it; returns how many minutes were published. ``subscribed`` is
        the codes whose RT_DATA OpenD has confirmed; ``fetch(code)`` is OpenD's get_rt_data for one code (its today
        分時 rows)."""
        due = self.due(subscribed)[:BATCH]
        if not due:
            return 0
        with self._lock:
            self._last_call_at = self._monotonic()
        # The live stream owns everything from now on: the backfill fills only the minutes before this instant.
        cutoff_ns = self._clock_ns()
        sent = 0
        for code in due:
            market = _market_of(code)
            operation = remediation.emitter().begin(
                component="futu_trend_backfill", mechanism_id="provider.futu_trend_backfill", trigger_reason="late_join",
                identity={"source": "futu", "market": market, "code": code,
                          "trading_date": futu_partition_date(market, self._now()).isoformat()})
            try:
                self.calls += 1
                rows = fetch(code)
                published, skipped = self._publish(code, rows, cutoff_ns)
            except Exception as exc:
                with self._lock:
                    if code in self._pending:
                        self._failed_at[code] = self._monotonic()
                self.failures += 1
                self.last_error = f"{type(exc).__name__}: {exc}"[:200]
                self.last_failure = {"code": code, "error": self.last_error, "at": time.time()}
                logger.warning(f"[FUTU TREND BACKFILL] reading the 分時 of {code} failed: {self.last_error}")
                operation.finish("failed", detail={"error": self.last_error})
                continue
            with self._lock:
                self._pending.discard(code)
                self._failed_at.pop(code, None)
            self.filled += 1
            self.published += published
            self.skipped += skipped
            sent += published
            operation.finish("succeeded", detail={"published": published, "skipped": skipped, "cutoff_ns": cutoff_ns})
        return sent

    def snapshot_status(self) -> dict[str, Any]:
        with self._lock:
            pending = len(self._pending)
        return {"filled": self.filled, "published": self.published, "skipped": self.skipped, "calls": self.calls,
                "failures": self.failures, "last_error": self.last_error,
                "last_failure": dict(self.last_failure) if self.last_failure else None,
                "pending": pending}
