from __future__ import annotations

import logging
import math
import time
import threading
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Any

from service.market.shared.provider import ProviderThinCallbackAdapter
from service.platform.failure_record import record_failure
from service.market.shared.rust_live import RustLiveEvent
from service.market.shioaji.subscriptions import ODD_MARKET, wal_instrument
from service.market.shared.dataflow_health import DataFlowStage, dataflow_health_ledger
from service.market.shared.market_trade_semantics import shioaji_tick_side
from service.market.shared.native_values import exchange_timestamp_ns, fixed_price_5, price_to_units

from service.market.shared.volume import to_volume
from service.market.shared.provider_fields import (
    InvalidField, NoPriceYet, OptionalFields, present, quote_price, required_price, required_volume,
)

logger = logging.getLogger(__name__)

# Callback lane name (the dataflow-health pulse lane) -> the subscription stream
# identity that lane feeds.  Mirrors StreamIdentity.key in
# service/market/shioaji/subscriptions.py so lane evidence and subscription
# state describe the same lane under the same key.
_EVIDENCE_STREAMS = {
    "stk.tick": ("STK", "Tick"),
    "stk.bidask": ("STK", "BidAsk"),
    "odd.tick": ("STK", "Tick"),
    "odd.bidask": ("STK", "BidAsk"),
    "index.quote": ("IND", "Quote"),
    "futures.quote": ("FUT", "Quote"),
    "futures.tick": ("FUT", "Tick"),
    "futures.bidask": ("FUT", "BidAsk"),
}



def _optional_volume(owner: Any, value: Any) -> float | None:
    """A volume (service.market.shared.volume), or None when the field is absent/unconvertible -- never a fabricated 0."""
    if value is None:
        return None
    try:
        number = float(owner._number(value))
    except (TypeError, ValueError):  # not an error: value coercion: a non-numeric value is None (missing) by contract
        return None
    return number if math.isfinite(number) else None


def _breadth_counts(owner: Any, quote: Any) -> dict[str, Any]:
    """Map the SDK index-quote breadth fields onto Market Runtime's QuoteData names.

    Each stays None when the quote does not carry it, so a missing count is null downstream
    rather than a fabricated zero that the UI would render as "0 家上漲".
    """
    def count(*names: str) -> int | None:
        for name in names:
            raw = owner._value(quote, name, None)
            if raw is None or raw == "":
                continue
            try:
                return int(owner._number(raw))
            except (TypeError, ValueError):  # not an error: value coercion: a non-numeric value is None (missing) by contract
                return None
        return None

    return {
        "advance_count": count("raise_count", "advance_count", "up_count"),
        "decline_count": count("fall_count", "decline_count", "down_count"),
        "flat_count": count("flat_count", "unchanged_count"),
        "limit_up_count": count("limit_up_count"),
        "limit_down_count": count("limit_down_count"),
    }


def _book_side(prices, raw_volumes, fields, field: str) -> list[dict]:
    """One side of the book: a level is published only with both its price and its volume. A price whose
    volume is missing, short, NaN or not a number is not a level with volume 0 -- it is left out and counted under
    ``field`` in the adapter's invalid optional fields."""
    try:
        volumes = list(raw_volumes or ())[:5]
    except TypeError:  # not an error: a non-iterable SDK value has no levels; each priced level is then counted below
        volumes = []
    levels = []
    for index, price in enumerate(prices):
        if int(price) < 0:
            continue
        before = fields.invalid[field]
        volume = fields.volume(field, volumes[index]) if index < len(volumes) else None
        if volume is None:
            if fields.invalid[field] == before:
                fields.invalid[field] += 1    # absent beside a price is as invalid as a garbage value
            continue
        levels.append({"price": int(price), "volume": to_volume(volume)})
    return levels

_TAIPEI = ZoneInfo("Asia/Taipei")
class ShioajiThinCallbackAdapter(ProviderThinCallbackAdapter):
    """Provider callback owner for Shioaji.

    Python callbacks validate identity, convert required primitive fields,
    invoke one non-blocking Rust ingress method, and record lock-free
    a CALLBACK_RECEIVED pulse (dataflow_health_ledger via _pulse_dataflow)
    before returning. Market Runtime remains the sole authoritative owner of
    the realtime state; the live_event_sink separately reports ingest
    admission and Market Runtime acknowledgement evidence.

    on_stock_tick/on_stock_bidask fire at Tick/BidAsk frequency. Their
    generic-exception handler counts owner._callback_errors, keeps the last
    one in owner._last_callback_error (both surfaced via owner.status()) and
    records it with record_failure, which writes the first occurrence of each
    failure per minute and counts the repeats, so a failing hot lane leaves a
    durable record without flooding the log.
    """

    def __init__(self, owner: Any) -> None:
        super().__init__("shioaji")
        # Events rejected for a missing/invalid required field (by lane.field), and optional fields left out
        # as invalid (by field). Surfaced in the owner's status.
        self.optional_fields = OptionalFields()
        self.invalid_required: dict[str, int] = {}
        # The last rejected event per lane.field: which product, what value, when -- a count alone cannot say
        # which contract or payload the broker sent (INTRADAY_CHECKS F2).
        self.invalid_required_last: dict[str, dict[str, Any]] = {}
        # Quotes dropped because the market has no price yet (current price 0, NoPriceYet), by lane.field, and the
        # last one per lane.field: not errors, so apart from invalid_required and never warned about.
        self.unpriced_quotes: dict[str, int] = {}
        self.unpriced_quotes_last: dict[str, dict[str, Any]] = {}
        # Every SDK connection of the pool calls this one adapter from its own thread: the four dicts above are
        # changed and read under this lock (diagnostic_snapshot is the status' one read).
        self._drop_lock = threading.Lock()
        self.owner = owner
        # SDK callback serialization is not a Python-side contract. Sequence
        # allocation and native admission must stay in the same critical
        # section or two callback threads could publish reordered identifiers.
        self._event_admission_lock = threading.Lock()
        self._event_sequences: dict[str, int] = {}

    @staticmethod
    def _stock_stream(event: Any, lane: str) -> tuple[str, str, str]:
        """(market, dataflow lane, sequence key) of a stock callback: a 盤中零股 event (``intraday_odd``) is of the
        market ODD -- its own book, prints and sequence -- never the stock's whole lots."""
        code = str(getattr(event, "code", "") or "")
        if bool(getattr(event, "intraday_odd", False) or False):
            return ODD_MARKET, f"odd.{lane}", f"{ODD_MARKET}:{code}"
        return "STK", f"stk.{lane}", code

    def _next_sequence(self, code: str) -> int:
        sequence = self._event_sequences.get(code, 0) + 1
        self._event_sequences[code] = sequence
        return sequence

    def _observe_live(self, market: str, code: str, exchange_ns: int, total_volume: Any, volume: Any) -> None:
        """An admitted live print (or quote): where this process's stream took over a restart's gap of `code`."""
        backfill = getattr(self.owner, "_restart_backfill", None)
        if backfill is None:
            return
        o = self.owner
        total, own = o._number(total_volume), o._number(volume)
        backfill.observe(market, code, int(exchange_ns), None if total is None else float(total), None if own is None else float(own))

    def _pulse_dataflow(
        self, lane: str, symbol: str, sequence: int, accepted: bool, arrival_ns: int, error: str = "",
    ) -> None:
        dataflow_health_ledger.pulse_hot_fields(
            DataFlowStage.CALLBACK_RECEIVED, lane=lane, symbol=symbol,
            sequence=sequence, accepted=accepted, error=error, observed_epoch_ns=arrival_ns,
        )
        if not accepted:
            return
        # Every Shioaji callback already funnels through here, which makes this the
        # one honest place to record that a lane delivered.  Keep it as cheap as the pulse above: two dict
        # writes, no lock, no formatting (see LaneDeliveryEvidence.observe).
        stream = _EVIDENCE_STREAMS.get(lane)
        if stream is None:
            return
        security_type, quote_type = stream
        owner = self.owner
        # The TXF Quote is keyed by its logical code (TXFR1), not by the native contract the exchange stamped on the
        # quote, so the evidence key matches the subscription stream identity for the same lane. A futures month's
        # Tick / BidAsk is pulsed with its symbol (TXF202612), its stream's code; an index quote carries the index's
        # own code (IX0001, IX0028 ...), which is its stream's code.
        if lane == "futures.quote":
            code = str(owner.TXF_CODE)
        else:
            code = str(symbol or "").strip().upper()
        if not code:
            return
        key = (
            f"{security_type}:{code}:{quote_type}:{'odd' if lane.startswith('odd.') else 'regular'}"
            if security_type == "STK"
            else f"{security_type}:{code}:{quote_type}"
        )
        owner.delivery_evidence.observe(key, code=code, lane=quote_type, epoch_ns=arrival_ns)
        owner.note_market_event(security_type)

    def _count_dropped(
        self, counts: dict[str, int], last: dict[str, dict[str, Any]], key: str, value: str, code: str,
        exchange_ns: int | None,
    ) -> int:
        at = datetime.now(_TAIPEI).isoformat(timespec="milliseconds")
        with self._drop_lock:
            count = counts.get(key, 0) + 1
            counts[key] = count
            last[key] = {"code": code, "value": value, "count": count, "exchange_ts_ns": exchange_ns, "at": at}
        return count

    def diagnostic_snapshot(self) -> dict[str, Any]:
        """The dropped-event counts as of one moment, copied under the lock the callback threads count under."""
        with self._drop_lock:
            snapshot = {
                "invalid_required_fields": dict(self.invalid_required),
                "invalid_required_last": {key: dict(row) for key, row in self.invalid_required_last.items()},
                "unpriced_quotes": dict(self.unpriced_quotes),
                "unpriced_quotes_last": {key: dict(row) for key, row in self.unpriced_quotes_last.items()},
            }
        return {**snapshot, "invalid_optional_fields": self.optional_fields.snapshot()}

    def _count_unpriced(self, lane: str, exc: NoPriceYet, code: str, exchange_ns: int | None) -> None:
        self._count_dropped(self.unpriced_quotes, self.unpriced_quotes_last, f"{lane}.{exc.field}",
                            repr(exc.value)[:80], code, exchange_ns)

    def _count_invalid_required(self, lane: str, exc: InvalidField, code: str, exchange_ns: int | None) -> None:
        key = f"{lane}.{exc.field}"
        value = repr(exc.value)[:80]
        count = self._count_dropped(self.invalid_required, self.invalid_required_last, key, value, code, exchange_ns)
        # Logged on the 1st, 10th, 100th ... rejection of a lane.field, so a broken feed cannot flood the log.
        if count == 1 or math.log10(count).is_integer():
            logger.warning("[SHIOAJI] %s rejected for %s: %s=%s (%d so far)", lane, code, exc.field, value, count)

    def install(self, api: Any) -> None:
        api.set_on_tick_stk_v1_callback(self.on_stock_tick)
        api.set_on_bidask_stk_v1_callback(self.on_stock_bidask)
        api.set_on_quote_idx_v1_callback(self.on_index_quote)
        # TXFR1 (the dashboard's 台指期) uses the same one-stream model as TAIEX: QuoteFOPv1 is enough for its
        # summary and trend. A dated futures month (台指期 and 個股期貨, 設定 → 訂閱管理) takes Tick and BidAsk like a
        # stock: its trade detail and 五檔.
        api.set_on_quote_fop_v1_callback(self.on_futures_quote)
        api.set_on_tick_fop_v1_callback(self.on_futures_tick)
        api.set_on_bidask_fop_v1_callback(self.on_futures_bidask)
        self._mark_installed()

    def _futures_symbol(self, lane: str, native_code: str) -> str:
        """A futures month's symbol (TXF202612) for the contract code its callback carries (TXFL6): the code Market
        Runtime and the subscription know it by (futures_contracts.py). An unknown code is a rejected event."""
        month = self.owner.subscription_manager.futures_table().by_code.get(native_code.strip().upper())
        if month is None:
            raise InvalidField("code", native_code)
        return month.symbol

    def on_stock_tick(self, exchange: Any, tick: Any) -> None:
        market, lane, sequence_key = self._stock_stream(tick, "tick")
        self._on_tick(market, lane, tick, sequence_key)

    def on_futures_tick(self, exchange: Any, tick: Any) -> None:
        self._on_tick("FUT", "futures.tick", tick)

    def on_stock_bidask(self, exchange: Any, bidask: Any) -> None:
        market, lane, sequence_key = self._stock_stream(bidask, "bidask")
        self._on_bidask(market, lane, bidask, sequence_key)

    def on_futures_bidask(self, exchange: Any, bidask: Any) -> None:
        self._on_bidask("FUT", "futures.bidask", bidask)

    def _on_tick(self, market: str, lane: str, tick: Any, sequence_key: str = "") -> None:
        o = self.owner
        arrival_ns = time.time_ns()
        code = str(getattr(tick, "code", "") or "")
        exchange_ns: int | None = None
        stream_seq = 0
        try:
            if market == "FUT":
                code = self._futures_symbol(lane, code)
            exchange_ns = int(exchange_timestamp_ns(tick))
            scale = o.price_scale
            fields = self.optional_fields
            # Required: a print without a readable price or size is rejected, never published as 0.
            close = required_price("close", getattr(tick, "close", None), scale=scale)
            volume = required_volume("volume", getattr(tick, "volume", None))
            price_chg = fields.price("price_chg", getattr(tick, "price_chg", None), scale=scale)
            with self._event_admission_lock:
                stream_seq = self._next_sequence(sequence_key or code)
                tick_type = o._int_value(getattr(tick, "tick_type", 0))
                accepted = o.event_sink.publish(RustLiveEvent(
                    source="shioaji", market=market, code=code,
                    generation=max(0, int(o._session_generation)), sequence=stream_seq,
                    event_type="trade", exchange_ts_ns=exchange_ns, arrival_ns=arrival_ns,
                    data=present({
                        "price": int(close),
                        "volume": volume,
                        "total_volume": fields.volume("total_volume", getattr(tick, "total_volume", None)),
                        # The 昨收 this print states: Market Runtime writes it as a Reference of the print's partition
                        # when that partition does not hold it yet (it alone knows the partition).
                        "stated_prev_close": None if price_chg is None else close - price_chg,
                        "side": shioaji_tick_side(tick_type),
                        "trade_id": str(getattr(tick, "seqno", "") or stream_seq),
                        "open": fields.price("open", getattr(tick, "open", None), scale=scale),
                        "high": fields.price("high", getattr(tick, "high", None), scale=scale),
                        "low": fields.price("low", getattr(tick, "low", None), scale=scale),
                        "average": fields.price("avg_price", getattr(tick, "avg_price", None), scale=scale, derived=True),
                        "total_amount": fields.number("total_amount", getattr(tick, "total_amount", None)),
                        "amount": fields.number("amount", getattr(tick, "amount", None)),
                        # Carried, not interpreted. `simtrade` marks a call-auction (試撮)
                        # indicative print, and the two side totals are the exchange's own
                        # 內盤/外盤 cumulative volumes. Both are on every SDK tick and both used
                        # to stop here, which is why the renderer's simtrade filter never fired on
                        # canonical data and its 內外盤 ratio had no input to show.
                        "simtrade": bool(getattr(tick, "simtrade", False) or False),
                        # Absent on a tick that does not report them, and absent is not zero: the
                        # engine stores Option<i64> and the UI must not be told the split is 0/0.
                        "bid_side_total_vol": _optional_volume(o, getattr(tick, "bid_side_total_vol", None)),
                        "ask_side_total_vol": _optional_volume(o, getattr(tick, "ask_side_total_vol", None)),
                    }),
                ))
            self._pulse_dataflow(lane, code, stream_seq, bool(accepted), arrival_ns)
            if accepted and market != ODD_MARKET and not bool(getattr(tick, "simtrade", False) or False):
                self._observe_live(market, code, exchange_ns, getattr(tick, "total_volume", None), volume)
        except InvalidField as exc:
            self._count_invalid_required(lane, exc, code, exchange_ns)
            self._pulse_dataflow(lane, code, stream_seq, False, arrival_ns, error=f"invalid_{exc.field}")
        except ValueError:  # not an error: counted in price-scale errors and pulsed to the dataflow as a rejected price_scale event
            o._price_scale_errors += 1
            self._pulse_dataflow(lane, code, stream_seq, False, arrival_ns, error="price_scale")
        except Exception as exc:
            o._callback_errors += 1
            handler = "on_futures_tick" if market == "FUT" else "on_stock_tick"
            o._last_callback_error = f"{handler}: {exc!r}"[:200]
            record_failure(logger, f"decoding a Shioaji {handler} callback", exc)
            self._pulse_dataflow(lane, code, stream_seq, False, arrival_ns, error=str(exc)[:200])

    def _on_bidask(self, market: str, lane: str, bidask: Any, sequence_key: str = "") -> None:
        o = self.owner
        arrival_ns = time.time_ns()
        code = str(getattr(bidask, "code", "") or "")
        exchange_ns: int | None = None
        stream_seq = 0
        try:
            if market == "FUT":
                code = self._futures_symbol(lane, code)
            exchange_ns = int(exchange_timestamp_ns(bidask))
            scale = o.price_scale
            with self._event_admission_lock:
                stream_seq = self._next_sequence(sequence_key or code)
                bid_prices = fixed_price_5(getattr(bidask, "bid_price", ()), scale=scale)
                ask_prices = fixed_price_5(getattr(bidask, "ask_price", ()), scale=scale)
                # Prices and volumes only: each level's change is Market Runtime's, against the previous book at the
                # same price (D01-05). The SDK's diff_bid_vol / diff_ask_vol is by array index, another meaning.
                accepted = o.event_sink.publish(RustLiveEvent(
                    source="shioaji", market=market, code=code,
                    generation=max(0, int(o._session_generation)), sequence=stream_seq,
                    event_type="orderbook", exchange_ts_ns=exchange_ns, arrival_ns=arrival_ns,
                    data={
                        "bids": _book_side(bid_prices, getattr(bidask, "bid_volume", ()), self.optional_fields, "bid_volume"),
                        "asks": _book_side(ask_prices, getattr(bidask, "ask_volume", ()), self.optional_fields, "ask_volume"),
                        # 試撮 book (盤前 / 收盤集合競價): Rust A shows it live and never stores it.
                        "simtrade": bool(getattr(bidask, "simtrade", False) or False),
                    },
                ))
            self._pulse_dataflow(lane, code, stream_seq, bool(accepted), arrival_ns)
        except InvalidField as exc:
            self._count_invalid_required(lane, exc, code, exchange_ns)
            self._pulse_dataflow(lane, code, stream_seq, False, arrival_ns, error=f"invalid_{exc.field}")
        except ValueError:  # not an error: counted in price-scale errors and pulsed to the dataflow as a rejected price_scale event
            o._price_scale_errors += 1
            self._pulse_dataflow(lane, code, stream_seq, False, arrival_ns, error="price_scale")
        except Exception as exc:
            o._callback_errors += 1
            handler = "on_futures_bidask" if market == "FUT" else "on_stock_bidask"
            o._last_callback_error = f"{handler}: {exc!r}"[:200]
            record_failure(logger, f"decoding a Shioaji {handler} callback", exc)
            self._pulse_dataflow(lane, code, stream_seq, False, arrival_ns, error=str(exc)[:200])

    def on_index_quote(self, quote: Any) -> None:
        o = self.owner
        code = str(o._value(quote, "code", "") or "").strip().upper()
        exchange_ns: int | None = None
        if not code:
            return
        # Market Runtime names IX0001 "TAIEX"; every other index (the 產業指數) by its own code.
        canonical = wal_instrument("IND", code)[1]
        arrival_ns = time.time_ns()
        stream_seq = 0
        try:
            exchange_ns = int(exchange_timestamp_ns(quote))
            scale = o.price_scale
            fields = self.optional_fields
            with self._event_admission_lock:
                stream_seq = self._next_sequence(code)
                accepted = o.event_sink.publish(RustLiveEvent(
                    source="shioaji", market="IDX", code=canonical, generation=max(0, int(o._session_generation)),
                    sequence=stream_seq, event_type="quote", exchange_ts_ns=exchange_ns, arrival_ns=arrival_ns,
                    data=present({
                        "current": quote_price("close", o._value(quote, "close"), scale=scale),
                        "open": fields.price("open", o._value(quote, "open"), scale=scale),
                        "high": fields.price("high", o._value(quote, "high"), scale=scale),
                        "low": fields.price("low", o._value(quote, "low"), scale=scale),
                        "total_volume": fields.volume("vol_sum", o._value(quote, "vol_sum")),
                        "total_amount": fields.number("amount_sum", o._value(quote, "amount_sum")),
                        "status": "live",
                        # The 昨收 the index quote states (see on_stock_tick's stated_prev_close).
                        "stated_prev_close": fields.price("reference", o._value(quote, "reference"), scale=scale),
                        # Derived (exchange-computed) average, exactly like on_stock_tick's
                        # avg_price: an amount/volume quotient routinely carries more precision
                        # than the fixed-point scale holds. Strict price_to_units() raised
                        # ValueError on those and -- with no handler on this method at all --
                        # the exception escaped into the SDK callback thread, losing the TAIEX
                        # quote with no counter, no dataflow pulse and no log line.
                        "average": fields.price("avg_price", o._value(quote, "avg_price"), scale=scale, derived=True),
                        # Market breadth. Market Runtime's QuoteData already carries these five
                        # (advance/decline/flat/limit_up/limit_down) and the renderer's
                        # market_breadth_store + trend_chart_component already render them as
                        # 上漲/下跌/漲停/跌停/平盤 -- but this adapter never forwarded them, so that
                        # whole row of the TAIEX panel was structurally stuck at "--". The SDK
                        # index quote names them raise_count/fall_count/...; keep None when the
                        # quote omits one so Rust's Option<i64> stays null instead of a fake 0.
                        **_breadth_counts(o, quote),
                    }),
                ))
            self._pulse_dataflow("index.quote", code, stream_seq, bool(accepted), arrival_ns)
            if accepted:
                self._observe_live("IDX", canonical, exchange_ns, None, None)
        except NoPriceYet as exc:
            # Nothing to show yet (e.g. a trial auction's first quote): dropped and counted, but no failure --
            # so no rejected pulse, which the dataflow ledger would count as a failed event.
            self._count_unpriced("index.quote", exc, code, exchange_ns)
        except InvalidField as exc:
            self._count_invalid_required("index.quote", exc, code, exchange_ns)
            self._pulse_dataflow("index.quote", code, stream_seq, False, arrival_ns, error=f"invalid_{exc.field}")
        except ValueError:  # not an error: counted in price-scale errors and pulsed to the dataflow as a rejected price_scale event
            o._price_scale_errors += 1
            self._pulse_dataflow("index.quote", code, stream_seq, False, arrival_ns, error="price_scale")
        except Exception as exc:
            o._callback_errors += 1
            o._last_callback_error = f"on_index_quote: {exc!r}"[:200]
            record_failure(logger, "decoding a Shioaji on_index_quote callback", exc)
            self._pulse_dataflow("index.quote", code, stream_seq, False, arrival_ns, error=str(exc)[:200])

    def _stated_txf_reference(self, quote: Any, scale: int) -> dict[str, Any]:
        """The TAIFEX reference a TXF quote states (close - price_chg; the futures Quote carries no ``reference``
        field): Market Runtime writes it as the session reference of the quote's partition when that partition does
        not hold it yet. A 試撮 quote states none."""
        o = self.owner
        if bool(o._value(quote, "simtrade", False)):
            return {}
        close = o._number(o._value(quote, "close"))
        change = o._number(o._value(quote, "price_chg"))
        if close is None or change is None or not float(close) > 0:
            return {}
        return {"stated_reference_price": price_to_units(round(float(close) - float(change), 4), scale=scale),
                "reference_source": "shioaji.quote.close_minus_price_chg"}

    def on_futures_quote(self, exchange: Any, quote: Any) -> None:
        """Push one TXFR1 Quote into the authoritative Rust lane."""
        o = self.owner
        native_code = str(o._value(quote, "code", "") or "").strip().upper()
        exchange_ns: int | None = None
        arrival_ns = time.time_ns()
        stream_seq = 0
        try:
            exchange_ns = int(exchange_timestamp_ns(quote))
            scale = o.price_scale
            fields = self.optional_fields
            stated = self._stated_txf_reference(quote, scale)
            with self._event_admission_lock:
                stream_seq = self._next_sequence(native_code or o.TXF_CODE)
                accepted = o.event_sink.publish(RustLiveEvent(
                    source="shioaji", market="FUT", code=o.TXF_CODE, generation=max(0, int(o._session_generation)),
                    sequence=stream_seq, event_type="quote", exchange_ts_ns=exchange_ns, arrival_ns=arrival_ns,
                    data=present({
                        "current": quote_price("close", o._value(quote, "close"), scale=scale),
                        "open": fields.price("open", o._value(quote, "open"), scale=scale),
                        "high": fields.price("high", o._value(quote, "high"), scale=scale),
                        "low": fields.price("low", o._value(quote, "low"), scale=scale),
                        "total_volume": fields.volume("total_volume", o._value(quote, "total_volume")),
                        "total_amount": fields.number("total_amount", o._value(quote, "total_amount")),
                        "status": "simulated" if bool(o._value(quote, "simtrade", False)) else "live",
                        # Derived average -- see on_index_quote above; strict conversion here
                        # threw out of the SDK callback thread for any non-representable average.
                        "average": fields.price("avg_price", o._value(quote, "avg_price"), scale=scale, derived=True),
                        "volume": fields.volume("volume", o._value(quote, "volume")),
                        "amount": fields.number("amount", o._value(quote, "amount")),
                        **stated,
                    }),
                ))
            self._pulse_dataflow("futures.quote", native_code, stream_seq, bool(accepted), arrival_ns)
            if accepted and stated:
                # The trading date the contract's limits are for is read from it (session._refresh_txf_limits).
                o.note_txf_stated_reference(stated["stated_reference_price"], exchange_ns)
            if accepted and not bool(o._value(quote, "simtrade", False)):
                self._observe_live("FUT", o.TXF_CODE, exchange_ns, o._value(quote, "total_volume"), o._value(quote, "volume"))
        except NoPriceYet as exc:
            # Nothing to show yet (e.g. a trial auction's first quote): dropped and counted, but no failure --
            # so no rejected pulse, which the dataflow ledger would count as a failed event.
            self._count_unpriced("futures.quote", exc, native_code, exchange_ns)
        except InvalidField as exc:
            self._count_invalid_required("futures.quote", exc, native_code, exchange_ns)
            self._pulse_dataflow("futures.quote", native_code, stream_seq, False, arrival_ns, error=f"invalid_{exc.field}")
        except ValueError:  # not an error: counted in price-scale errors and pulsed to the dataflow as a rejected price_scale event
            o._price_scale_errors += 1
            self._pulse_dataflow("futures.quote", native_code, stream_seq, False, arrival_ns, error="price_scale")
        except Exception as exc:
            o._callback_errors += 1
            o._last_callback_error = f"on_futures_quote: {exc!r}"[:200]
            record_failure(logger, "decoding a Shioaji on_futures_quote callback", exc)
            self._pulse_dataflow("futures.quote", native_code, stream_seq, False, arrival_ns, error=str(exc)[:200])