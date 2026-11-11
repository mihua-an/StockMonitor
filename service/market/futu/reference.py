"""Futu 昨收 (previous close) and name, from OpenD's market snapshot, as Market Runtime reference events.

Futu pushes quote rows -- the only push that carries ``prev_close_price`` -- during a US regular session only
(09:30-16:00 ET, 21:30 in Taipei). Before it (pre-market and the overnight session, all of Taiwan's daytime) a
subscribed stock streams trades, books and minute bars but no quote, so Market Runtime had no reference and the
screen showed no 昨收, 漲跌 or 漲跌幅. The reference is instrument data, not a quote: it is asked for
once per code and exchange-local trading date, and checked again on a slow cadence so a change on OpenD's side
(its day roll) reaches the partition too. Only a changed value is sent.

Crypto (CC) has no close. Its 昨收 is its price at the US regular close (16:00 New York) of the last US trading day
before its New York day, the same moment the US stocks' 昨收 is from, so the two moves compare (user 11-12). OpenD's
snapshot has no such field (its crypto prev_close_price is the price at Taipei 00:00), so it is read from the 1-minute
bar ending at 16:00 (OpenD labels a bar by its end), once per New York day: the value never changes.
"""
from __future__ import annotations

import logging
import time
from datetime import date as date_cls, datetime, time as time_of_day, timedelta, timezone
from typing import Any, Callable, Iterable

from config.market_holidays import futu_trading_day
from service.market.shared.native_values import derived_price_to_units
from service.market.shared.session_identity_contract import futu_partition_date, market_zone

logger = logging.getLogger(__name__)

SNAPSHOT_BATCH = 200          # OpenD takes up to 400 codes per get_market_snapshot
REFRESH_SECONDS = 600.0       # a code is asked again this often, whatever the last answer was
RETRY_SECONDS = 60.0          # after a failed snapshot call
# OpenD allows 60 snapshot calls per 30 s for the whole account. One call per this interval at most, whatever happens:
# an answer this code cannot use must never turn into a call on every worker cycle (asking again every 0.2 s
# for codes whose rows it could not use once exhausted the quota).
MIN_CALL_INTERVAL_SECONDS = 5.0
# Markets trading around the clock: their 昨收 is their price at the US regular close (module docstring).
CRYPTO_MARKETS = frozenset({"CC"})
US_REGULAR_CLOSE = "16:00:00"
# The 1-minute bars asked for: the ten minutes up to the close, the bar ending at it among them.
CRYPTO_BARS_FROM = "15:50:00"
# OpenD's snapshot moves to a new US day at that day's regular open. Before it (the overnight hours after midnight and
# the pre-market, 00:00-09:30 New York) `prev_close_price` is still the close of the day BEFORE the previous one, and
# the previous regular close is `last_price` -- the base Futu's own pre_change_val / overnight_change_val use. Read as
# 昨收, prev_close_price showed MU's 10-14 close 914.13 on 10-16's pre-market (+0.46%; Futu: 931.24, -1.53%).
US_REGULAR_OPEN_MINUTE = 9 * 60 + 30


def _market_of(code: str) -> str:
    return code.split(".", 1)[0].upper() if "." in code else "US"


class FutuReferencePublisher:
    def __init__(self, publish: Callable[[str, str, dict[str, Any]], bool], *,
                 now: Callable[[], datetime] | None = None, monotonic: Callable[[], float] = time.monotonic) -> None:
        # publish(code, trading_date, data) -> admitted
        self._publish = publish
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._monotonic = monotonic
        self._sent: dict[tuple[str, str], tuple[int, str]] = {}     # (code, date) -> (prev_close units, name)
        self._checked_at: dict[tuple[str, str], float] = {}   # (code, date) -> when last asked and answered
        self._pre_open: set[tuple[str, str]] = set()           # (code, date) read before the US regular open
        self._failed_at: float | None = None
        self._last_call_at: float | None = None
        self.published = 0
        self.calls = 0
        self.unusable = 0
        self.rejected = 0
        self.last_unusable: dict[str, Any] | None = None
        self.failures = 0
        # The current error (the last snapshot call failed) and the last failure with when it recovered.
        self.last_error = ""
        self.last_failure: dict[str, Any] | None = None

    def _trading_date(self, code: str) -> str:
        """The partition in progress (session_identity_contract.futu_partition_date, shared with the session spec)."""
        return futu_partition_date(_market_of(code), self._now()).isoformat()

    def _before_regular_open(self, code: str, date: str) -> bool:
        """Whether the regular open of the day ``date``'s partition trades for is still ahead (Sunday's partition
        trades for Monday, a holiday evening's for the day after): until then OpenD's snapshot still describes the
        session before it."""
        if _market_of(code) != "US":
            return False
        trading_day = date_cls.fromisoformat(date)
        while not futu_trading_day("US", trading_day):
            trading_day += timedelta(days=1)
        zone = market_zone("US")
        regular_open = datetime.combine(trading_day, time_of_day(US_REGULAR_OPEN_MINUTE // 60, US_REGULAR_OPEN_MINUTE % 60), tzinfo=zone)
        return self._now().astimezone(zone) < regular_open

    def _previous_close(self, code: str, date: str, row: dict[str, Any]) -> tuple[str, Any] | None:
        """The snapshot field holding ``date``'s 昨收, or None when the value already sent must stay."""
        if self._before_regular_open(code, date):
            self._pre_open.add((code, date))
            return "last_price", row.get("last_price")
        # Sent before the open, the previous regular close is already this date's 昨收; a snapshot that has not yet
        # moved to the new day just after 09:30 would replace it with the day before's.
        if (code, date) in self._pre_open and (code, date) in self._sent:
            return None
        return "prev_close_price", row.get("prev_close_price")

    def due(self, codes: Iterable[str]) -> list[str]:
        """Codes whose reference for today's trading date was never sent, or was last checked long enough ago."""
        now = self._monotonic()
        if self._failed_at is not None and now - self._failed_at < RETRY_SECONDS:
            return []
        if self._last_call_at is not None and now - self._last_call_at < MIN_CALL_INTERVAL_SECONDS:
            return []
        out = []
        for code in sorted({str(c).strip().upper() for c in codes if str(c).strip()}):
            if _market_of(code) in CRYPTO_MARKETS and (code, self._trading_date(code)) in self._sent:
                continue   # a past close: sent once, it never changes
            last = self._checked_at.get((code, self._trading_date(code)))
            if last is None or now - last >= REFRESH_SECONDS:
                out.append(code)
        return out

    def _forget_outside(self, codes: set[str]) -> None:
        """Keep only what a code still asked about needs: its current trading date's entries. A code that left the
        plan, or a date its exchange has moved past, is never asked about again."""
        current = {code: self._trading_date(code) for code in codes}
        for book in (self._sent, self._checked_at):
            for key in [key for key in book if current.get(key[0]) != key[1]]:
                del book[key]
        self._pre_open = {key for key in self._pre_open if current.get(key[0]) == key[1]}

    def _crypto_close_day(self, date: str) -> str:
        """The US trading day whose regular close is a crypto New York day's 昨收: the last one before it (a weekend's
        and Monday's are Friday's), as a US stock's 昨收 is the close before its own day."""
        day = date_cls.fromisoformat(date) - timedelta(days=1)
        while not futu_trading_day("US", day):
            day -= timedelta(days=1)
        return day.isoformat()

    def _stock_answer(self, row: dict[str, Any]) -> tuple[str, str, str, Any, dict[str, Any]] | None:
        """(code, date, field, value, row) of a snapshot row, or None when the value already sent must stay."""
        code = str(row.get("code") or "").strip().upper()
        date = self._trading_date(code)
        source = self._previous_close(code, date, row) if code else ("prev_close_price", row.get("prev_close_price"))
        return None if source is None else (code, date, source[0], source[1], row)

    def _crypto_answer(self, code: str, kline: Callable[[str, str, str], list[dict[str, Any]]]) -> tuple[str, str, str, Any, dict[str, Any]]:
        """(code, date, field, value, row): the close of the 1-minute bar ending at the US regular close."""
        date = self._trading_date(code)
        day = self._crypto_close_day(date)
        at = f"{day} {US_REGULAR_CLOSE}"
        rows = kline(code, f"{day} {CRYPTO_BARS_FROM}", at)
        row = next((r for r in rows if str(r.get("time_key") or "") == at), {"bars": [str(r.get("time_key")) for r in rows]})
        return code, date, f"close@{at}", row.get("close"), row

    def run(self, snapshot: Callable[[list[str]], list[dict[str, Any]]], codes: Iterable[str],
            kline: Callable[[str, str, str], list[dict[str, Any]]]) -> int:
        """Ask for the due codes' 昨收 and send what changed; returns how many references were sent. ``snapshot(codes)``
        is OpenD's market snapshot, ``kline(code, start, end)`` its 1-minute bars of one code (New York times)."""
        codes = {str(c).strip().upper() for c in codes if str(c).strip()}
        due = self.due(codes)[:SNAPSHOT_BATCH]
        sent = 0
        if due:
            self._forget_outside(codes)   # at most once per call interval, before this call adds today's entries
            stocks = [code for code in due if _market_of(code) not in CRYPTO_MARKETS]
            crypto = [code for code in due if _market_of(code) in CRYPTO_MARKETS]
            self._last_call_at = self._monotonic()
            try:
                answers: list[tuple[str, str, str, Any, dict[str, Any]] | None] = []
                if stocks:
                    self.calls += 1
                    answers += [self._stock_answer(row) for row in snapshot(stocks)]
                for code in crypto:
                    self.calls += 1
                    answers.append(self._crypto_answer(code, kline))
            except Exception as exc:
                self._failed_at = self._monotonic()
                self.failures += 1
                self.last_error = f"{type(exc).__name__}: {exc}"[:200]
                self.last_failure = {"error": self.last_error, "at": time.time(), "recovered_at": None}
                logger.warning(f"[FUTU REFERENCE] reading the 昨收 of {len(due)} codes failed: {self.last_error}")
                return sent
            self._failed_at = None
            if self.last_error:
                self.last_error = ""
                if self.last_failure is not None:
                    self.last_failure["recovered_at"] = time.time()
            checked = self._monotonic()
            # Every code asked is answered for the cadence, usable row or not.
            for code in due:
                self._checked_at[(code, self._trading_date(code))] = checked
            for answer in answers:
                if answer is None:
                    continue
                code, date, field, prev, row = answer
                try:
                    units = derived_price_to_units(prev)
                except (ValueError, OverflowError):  # not an error: counted as unusable with the row (unusable / last_unusable)
                    units = 0
                if not code or units <= 0:
                    self.unusable += 1
                    self.last_unusable = {"code": code, field: repr(prev)[:40], "keys": sorted(map(str, row))[:30]}
                    continue
                name = str(row.get("name") or "").strip()
                if self._sent.get((code, date)) == (units, name):
                    continue
                data: dict[str, Any] = {"prev_close": units}
                if name:
                    data["name"] = name
                if self._publish(code, date, data):
                    self._sent[(code, date)] = (units, name)
                    self.published += 1
                    sent += 1
                else:
                    self.rejected += 1
        return sent

    def snapshot_status(self) -> dict[str, Any]:
        return {"published": self.published, "calls": self.calls, "failures": self.failures, "unusable": self.unusable,
                "rejected": self.rejected, "last_error": self.last_error,
                "last_failure": dict(self.last_failure) if self.last_failure else None, "last_unusable": self.last_unusable,
                "codes": len({code for code, _ in self._sent})}
