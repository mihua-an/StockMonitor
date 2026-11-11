from __future__ import annotations

import logging
import math
import threading
import time
from datetime import datetime
from typing import Any, Callable, Mapping

from service.market.shared.callback_queue import CallbackQueueMeter
from service.market.shared.native_values import DEFAULT_PRICE_SCALE
from service.market.shared.provider import ProviderThinCallbackAdapter
from service.market.shared.session_identity_contract import market_zone
from service.market.shared.rust_live import RustEventSink, RustLiveEvent, sdk_payload
from service.market.shared.provider_fields import (
    InvalidField, NoPriceYet, OptionalFields, present, quote_price, required_volume,
)
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


def _rows(value: Any) -> list[dict[str, Any]]:
    """The rows of one push as the SDK decodes it (``parse_rsp_pb``): a list of row dicts, or one dict (a book)."""
    if isinstance(value, (list, tuple)):
        return [sdk_payload(row) for row in value]
    return [sdk_payload(value)]


def _first(row: Mapping[str, Any], *names: str) -> tuple[str, Any]:
    """The first of `names` the row carries (name, value); (names[0], None) when it carries none."""
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            return name, value
    return names[0], None


def _market_zone(market: str):
    """Exchange zone of a Futu market (single contract: session_identity_contract)."""
    return market_zone(market)


def _exchange_time(kind: str, row: Mapping[str, Any], market: str) -> tuple[int, str]:
    """(ns, time_quality). Without a parseable exchange time the answer is (0, "missing"): the row is refused and
    counted, never filed by arrival time, where the wall clock would choose its trading date and minute."""
    exchange_ns = _exchange_ns(row, 0, market)
    if exchange_ns <= 0:
        return 0, "missing"
    if kind == "minute_bar" and market in _END_LABELED_BAR_MARKETS:
        exchange_ns -= _MINUTE_NS
    return exchange_ns, "exchange"


_MINUTE_NS = 60_000_000_000
# Markets whose RT_DATA minute bar OpenD labels with the minute it ENDS: a US bar "09:30" holds the prints of
# 09:29:00-09:29:59 (WAL of 2026-11-09: each US.ASX bar equals the previous minute's ticker sum to within 0.1%,
# none matches its own minute, and the 04:00 bar first arrives at 03:59:01). The event is stamped with the minute it
# covers, so Market Runtime files it there. A crypto bar reads the minute in progress (01:19 at 01:19:11, New
# York), so CC is not in the set; HK / SH / SZ are not subscribed and have not been observed.
_END_LABELED_BAR_MARKETS = frozenset({"US"})


def _cached_book(kind: str, row: Mapping[str, Any]) -> bool:
    """An order book OpenD replays from its cache: both sides' svr_recv_time empty. Qot_UpdateOrderBook.proto says
    the receive time is zero for cached data, such as the first push after subscribing or a server restart; the next
    push carries the exchange-fed book with its time."""
    return kind == "orderbook" and not row.get("svr_recv_time_bid") and not row.get("svr_recv_time_ask")


def _parse_ns(raw: Any, market: str) -> int:
    # OpenD's times carry no zone: they are on the market's clock (config/market_timezones.json). For crypto that is
    # US Eastern -- observed at 13:19 Taipei (05:19 UTC): CC.BTCUSD ticker / quote / order book / RT_DATA all read 01:19.
    try:
        parsed = datetime.fromisoformat(str(raw).strip().replace("Z", "+00:00"))
    except ValueError:  # not an error: a time text that is not ISO is 0 (missing) by contract; the caller rejects a 0 timestamp
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_market_zone(market))
    return int(parsed.timestamp() * 1_000_000_000)


def _exchange_ns(row: Mapping[str, Any], arrival_ns: int, market: str) -> int:
    # One field per OpenD handler, in the shapes the SDK really delivers (moomoo 10.10, quote_query.py):
    #   StockQuoteHandlerBase -> data_date "YYYY-MM-DD" + data_time "HH:MM:SS" (OpenD's updateTime split in two),
    #   TickerHandlerBase     -> time "YYYY-MM-DD HH:MM:SS.fff",
    #   RTDataHandlerBase     -> time_key "YYYY-MM-DD HH:MM:SS",
    #   OrderBookHandlerBase  -> svr_recv_time_bid / svr_recv_time_ask (the Futu server's receive time of each side;
    #                            OpenD gives a book no other time, and "" for a side that has not updated).
    # `time_key` can be missing (bars would take arrival time). Refusing rows without a time, the quote's bare
    # "HH:MM:SS" and the book's unlisted fields refused EVERY Futu quote and order book (157k rows in one evening:
    # no 昨收 / 總量 / 買賣報價 for any US stock) -- the earlier tests fed the shapes this code assumed, not the SDK's.
    date_part, time_part = row.get("data_date"), row.get("data_time")
    if date_part and time_part:
        return _parse_ns(f"{date_part} {time_part}", market) or arrival_ns
    book_times = [_parse_ns(row.get(key), market) for key in ("svr_recv_time_bid", "svr_recv_time_ask") if row.get(key)]
    if book_times:
        return max(book_times) or arrival_ns
    raw = time_part or row.get("time_key") or row.get("time") or row.get("update_time") or row.get("timestamp")
    if not raw:
        return arrival_ns
    return _parse_ns(raw, market) or arrival_ns


# OpenD stamps a quote with its last-update second and a minute bar with its minute: a label that files the event,
# not the moment it happened. Said on the event (flags.time_label) so Market Runtime does not measure 交易所延遲 from
# it; a ticker's time and an order book's server-receive time are the event's own.
_LABEL_TIMED = frozenset({"quote", "minute_bar"})
_TIME_LABEL = {"time_label": True}


class FutuThinCallbackAdapter(ProviderThinCallbackAdapter):
    """Decode OpenD callbacks and directly admit immutable events to Rust."""

    HANDLERS = (
        ("StockQuoteHandlerBase", "quote"),
        ("RTDataHandlerBase", "minute_bar"),
        ("TickerHandlerBase", "trade"),
        ("OrderBookHandlerBase", "orderbook"),
    )

    def __init__(
        self, sink: RustEventSink, *, generation: Callable[[], int],
        observe: Callable[[str, str, str], None] | None = None,
    ) -> None:
        super().__init__("futu")
        self._sink = sink
        # Health-facing lane evidence only (code, kind); never market state.
        self._observe = observe
        self._generation = generation
        self._sequences: dict[tuple[str, str], int] = {}
        # Sequence allocation and the publish it numbers are one step, as in the Shioaji adapter: OpenD may
        # dispatch handlers concurrently, and a read-increment-write without it can repeat or reorder.
        self._publish_lock = threading.Lock()
        self._rejected = 0
        self._missing_exchange_time = 0
        # Optional fields left out as invalid, by field (a missing one is simply not reported).
        self._fields = OptionalFields()
        self._last_rejection: dict[str, Any] | None = None
        # Quotes dropped because the market has no price yet (current price 0, NoPriceYet), by field, and the last
        # one: not errors, so apart from the rejections -- the same counting as the Shioaji adapter's unpriced_quotes.
        self._unpriced_quotes: dict[str, int] = {}
        self._unpriced_quote_last: dict[str, Any] | None = None
        # Order books OpenD replayed from its cache (no receive time, see _cached_book) and the last one: not errors.
        self._cached_books = 0
        self._cached_book_last: dict[str, Any] | None = None
        # Rejections by kind.reason: what decides when a repeat is written to the log (_record_rejection).
        self._rejected_by: dict[str, int] = {}
        # How far the SDK callback queue is behind, and the backlog verdict (OpenD queues pushes without bound).
        self._queue = CallbackQueueMeter("futu", log=_failure_log)

    def _record_rejection(self, kind: str, ret_code: Any, data: Any) -> None:
        key = f"{kind}.{ret_code}"
        with self._publish_lock:
            self._rejected += 1
            self._last_rejection = {"kind": kind, "ret_code": ret_code, "message": str(data)[:200]}
            count = self._rejected_by.get(key, 0) + 1
            self._rejected_by[key] = count
        # Written on the 1st, 10th, 100th ... rejection of a kind.reason, so a broken feed cannot flood the log.
        if count == 1 or math.log10(count).is_integer():
            _failure_log.warning("[FUTU] %s row rejected (%s): %s (%d so far)", kind, ret_code, str(data)[:200], count)

    def _book_side(self, values: Any) -> list[dict[str, Any]]:
        """Book levels with a readable price and size; a level without one is left out and counted."""
        result: list[dict[str, Any]] = []
        for value in (values if isinstance(values, (list, tuple)) else ())[:10]:
            if isinstance(value, Mapping):
                price, volume = value.get("price"), value.get("volume") or value.get("vol")
            elif isinstance(value, (list, tuple)) and len(value) >= 2:
                price, volume = value[0], value[1]
            else:
                continue
            level_price = self._fields.price("book_price", price, scale=DEFAULT_PRICE_SCALE, derived=True)
            # Shares, fractional allowed (OpenD hpVolume): never truncated.
            level_volume = self._fields.volume("book_volume", volume)
            if not level_price or level_price <= 0 or level_volume is None:
                if price not in (None, "") or volume not in (None, ""):
                    self._fields.invalid["book_level"] += 1
                continue
            result.append({"price": level_price, "volume": level_volume})
        return result

    def _publish(self, kind: str, raw: Any) -> dict[str, Any]:
        # One bad row (NaN, a non-numeric level) must not raise out of the loop: the rest of the batch would be lost, the
        # lane already marked alive, and nothing would count the loss. Each row stands alone.
        accepted, rejected = 0, {}
        for row in _rows(raw):
            try:
                reason = self._publish_row(kind, row)
            except Exception as exc:
                record_failure(_failure_log, f"decoding a Futu {kind} row", exc)
                self._record_rejection(kind, "decode_error", f"{type(exc).__name__}: {exc}")
                reason = "decode_error"
            if reason is None:
                accepted += 1
            else:
                rejected[reason] = rejected.get(reason, 0) + 1
        return {"accepted": accepted, "rejected": sum(rejected.values()), "rejected_by_reason": rejected}

    def _event_data(self, kind: str, row: Mapping[str, Any]) -> dict[str, Any]:
        """The event payload: required fields checked (InvalidField), optional ones left out when unknown."""
        f = self._fields

        def price(*names: str) -> int | None:
            name, value = _first(row, *names)
            return f.price(name, value, scale=DEFAULT_PRICE_SCALE, derived=True)

        def number(*names: str) -> float | None:
            name, value = _first(row, *names)
            return f.number(name, value)

        def volume(*names: str) -> float | None:
            name, value = _first(row, *names)
            return f.volume(name, value)

        if kind == "trade":
            direction = str(row.get("ticker_direction") or row.get("direction") or "").upper()
            name, raw_price = _first(row, "price", "cur_price", "last_price")
            # A decimal quantity (US fractional shares): int() turned 0.25 into 0.
            size_name, raw_size = _first(row, "volume", "qty")
            trade_price = f.price(name, raw_price, scale=DEFAULT_PRICE_SCALE, derived=True)
            if not trade_price or trade_price <= 0:
                raise InvalidField(name, raw_price)
            return present({"price": trade_price,
                            "volume": required_volume(size_name, raw_size),
                            # Only a real cumulative figure: a ticker row has none, and its own size posing as one made
                            # Market Runtime drop every trade smaller than the previous.
                            "total_volume": volume("total_volume"),
                            "side": 1 if direction in {"BUY", "UP"} else (-1 if direction in {"SELL", "DOWN"} else 0),
                            "trade_id": str(row.get("sequence") or row.get("ticker_id") or ""),
                            # OpenD's TickerType (AUTO_MATCH, ODD_LOT, AVERAGE_PRICE...) as it came: Market Runtime
                            # decides at ingest which ones set no 現價 (Engine::classify_print).
                            "condition": str(row.get("type") or "").strip().upper() or None,
                            # No open / high / low: the day range is the quote's regular-session figures alone (user
                            # 11-02, docs/decisions.md); a print is 現價.
                            "average": price("avg_price", "average_price"),
                            "total_amount": number("turnover", "amount"),
                            "amount": number("turnover", "amount")})
        if kind == "orderbook":
            return {"bids": self._book_side(row.get("Bid") or row.get("bid") or row.get("bids")),
                    "asks": self._book_side(row.get("Ask") or row.get("ask") or row.get("asks"))}
        if kind == "minute_bar":
            name, raw_close = _first(row, "close", "cur_price", "last_price")
            close = f.price(name, raw_close, scale=DEFAULT_PRICE_SCALE, derived=True)
            if not close or close <= 0:
                raise InvalidField(name, raw_close)
            size_name, raw_size = _first(row, "volume")
            return present({"open": price("open", "open_price"), "high": price("high", "high_price"),
                            "low": price("low", "low_price"), "close": close,
                            "average": price("avg_price", "average_price"),
                            "volume": required_volume(size_name, raw_size), "amount": number("turnover", "amount")})
        name, raw_current = _first(row, "last_price", "cur_price", "price")
        current = quote_price(name, raw_current, scale=DEFAULT_PRICE_SCALE, derived=True)
        # No 昨收: FutuReferencePublisher's Reference event is its one source (reference.py, D01-02).
        return present({"current": current,
                        "open": price("open_price", "open"), "high": price("high_price", "high"),
                        "low": price("low_price", "low"), "total_volume": volume("volume", "total_volume"),
                        "total_amount": number("turnover", "amount"), "status": str(row.get("market_state") or "live"),
                        "average": price("avg_price", "average_price")})

    def _publish_row(self, kind: str, row: Mapping[str, Any]) -> str | None:
        """None when the row entered the Rust sink; otherwise why it did not."""
        # A row names its own instrument; one without a code is refused, never attributed to a guessed product.
        code = str(row.get("code") or "").strip().upper()
        if not code:
            self._record_rejection(kind, "missing_code", row)
            return "missing_code"
        market = code.split(".", 1)[0] if "." in code else "US"
        key = (code, kind)
        arrival_ns = time.time_ns()
        if _cached_book(kind, row):
            # not an error: OpenD's cached replay names no time, so no partition; dropped and counted (cached_books).
            with self._publish_lock:
                self._cached_books += 1
                self._cached_book_last = {"code": code, "at_ns": arrival_ns}
            return "cached_book"
        exchange_ns, time_quality = _exchange_time(kind, row, market)
        if exchange_ns <= 0:
            # Real OpenD rows always carry one; a renamed field or a format change must show up, not guess a date.
            self._record_rejection(kind, "missing_exchange_time", code)
            self._missing_exchange_time += 1
            return "missing_exchange_time"
        try:
            data = self._event_data(kind, row)
        except NoPriceYet as exc:
            # not an error: nothing to show yet -- dropped and counted (unpriced_quotes), never a rejection.
            with self._publish_lock:
                self._unpriced_quotes[exc.field] = self._unpriced_quotes.get(exc.field, 0) + 1
                self._unpriced_quote_last = {"kind": kind, "code": code, "field": exc.field,
                                             "value": repr(exc.value)[:80]}
            return "no_price_yet"
        except InvalidField as exc:
            # A required field missing or unreadable: the row is rejected, never published as 0.
            self._record_rejection(kind, f"invalid_{exc.field}", code)
            return f"invalid_{exc.field}"
        with self._publish_lock:
            sequence = self._sequences.get(key, 0) + 1
            self._sequences[key] = sequence
            if kind == "trade" and not data["trade_id"]:
                data["trade_id"] = str(sequence)
            accepted = self._sink.publish(RustLiveEvent(
                source="futu", market=market, code=code, generation=max(0, int(self._generation())),
                sequence=sequence, event_type=kind, exchange_ts_ns=exchange_ns, arrival_ns=arrival_ns, data=data,
                time_quality=time_quality, flags=_TIME_LABEL if kind in _LABEL_TIMED else {},
            ))
        if not accepted:
            self._record_rejection(kind, "rust_rejected", code)
            return "rust_rejected"
        if self._observe is not None:
            # Lane evidence only for a row that decoded and was admitted.
            self._observe(code, kind)
        return None

    def publish_reference(self, code: str, trading_date: str, data: Mapping[str, Any]) -> bool:
        """One reference event (昨收, name) for ``code``'s ``trading_date`` partition (service/market/futu/reference.py).

        It is instrument data asked of OpenD, not a print: stamped with the time it was read, like Shioaji's."""
        code = str(code).strip().upper()
        market = code.split(".", 1)[0] if "." in code else "US"
        now_ns = time.time_ns()
        with self._publish_lock:
            key = (code, "reference")
            sequence = self._sequences.get(key, 0) + 1
            self._sequences[key] = sequence
            accepted = bool(self._sink.publish(RustLiveEvent(
                source="futu", market=market, code=code,
                generation=max(0, int(self._generation())), sequence=sequence, event_type="reference",
                exchange_ts_ns=now_ns, arrival_ns=now_ns, data=dict(data), time_quality="backend_clock",
                describes_trading_date=str(trading_date),
            )))
        return accepted

    def install(self, context: Any, sdk: Any) -> int:
        if self._installed:
            return 0
        installed = 0
        ret_ok = getattr(sdk, "RET_OK", 0)
        ret_error = getattr(sdk, "RET_ERROR", -1)
        owner = self
        for base_name, kind in self.HANDLERS:
            base = getattr(sdk, base_name, None)
            if base is None:
                continue

            class Handler(base):  # type: ignore[misc, valid-type]
                _market_kind = kind

                def on_recv_rsp(self, rsp_pb):
                    # The SDK's own decode (protobuf to row dicts) and nothing more. The base on_recv_rsp builds a
                    # pandas DataFrame of every push (62 columns for a quote) that this adapter would only turn back
                    # into dicts: milliseconds a push on the SDK's one callback thread, slower than OpenD pushes at
                    # the US open, so the SDK's unbounded queue grows and every event arrives later than the last.
                    started = time.perf_counter()
                    try:
                        ret_code, data = self.parse_rsp_pb(rsp_pb)
                        if ret_code == ret_ok:
                            owner._publish(self._market_kind, data)
                        else:
                            owner._record_rejection(self._market_kind, ret_code, data)
                    except Exception as exc:
                        # The SDK would only write this to its own file log: counted here like any other bad row.
                        record_failure(_failure_log, f"decoding a Futu {self._market_kind} push", exc)
                        owner._record_rejection(self._market_kind, "decode_error", f"{type(exc).__name__}: {exc}")
                        return ret_error, str(exc)
                    finally:
                        owner._queue.handled(time.perf_counter() - started)
                    return ret_code, data

            context.set_handler(Handler())
            installed += 1
        # The SDK offers no public read of this queue; it is replaced with the context, so it is read through the context.
        self._queue.attach(lambda: context._callback_executor.queue.qsize())
        self._mark_installed()
        return installed

    def snapshot(self) -> dict[str, Any]:
        return {**super().snapshot(), "rejected": self._rejected, "missing_exchange_time": self._missing_exchange_time,
                "invalid_optional_fields": self._fields.snapshot(),
                "last_rejection": dict(self._last_rejection) if self._last_rejection else None,
                "callback_queue": self._queue.snapshot(), **self._unpriced_snapshot()}

    def callback_backlog(self) -> dict[str, Any] | None:
        """The open callback backlog episode (the SDK queue staying deep), or None."""
        return self._queue.backlog()

    def _unpriced_snapshot(self) -> dict[str, Any]:
        with self._publish_lock:
            return {"unpriced_quotes": dict(self._unpriced_quotes),
                    "unpriced_quote_last": dict(self._unpriced_quote_last) if self._unpriced_quote_last else None,
                    "cached_books": self._cached_books,
                    "cached_book_last": dict(self._cached_book_last) if self._cached_book_last else None,
                    "rejections_by_reason": dict(self._rejected_by)}
