"""A Futu adapter slower than OpenD's pushes loses nothing and raises nothing: the SDK's unbounded queue grows and every
event arrives later than the last. Three things keep that from happening unseen: the handler decodes a push without
building the SDK's DataFrame (and the decode stays what the DataFrame held), the queue's depth is read and judged,
and the SDK's file log does not write per push.
"""
from __future__ import annotations

import importlib
import inspect
import itertools
import logging
import math
import os
import queue
import site
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping

import pytest

import service.market.futu.service as futu_service
from service.market.futu.callback import FutuThinCallbackAdapter
from service.market.futu.opend_lifecycle import FutuOpenDLifecycle, OpenDConnectionState
from service.market.shared import callback_queue
from service.market.shared.callback_queue import CallbackQueueMeter
from service.market.shared.rust_live import sdk_payload

ROOT = Path(__file__).resolve().parents[1]
_providers = itertools.count()
LOG = logging.getLogger("tests.callback_queue")


# --- The decode -----------------------------------------------------------------------------------------------------


def _sdk():
    return pytest.importorskip("moomoo")


def _quote_pb(*, pre_market: bool = False, hp_volume: float | None = None):
    from moomoo.common.pb.Qot_UpdateBasicQot_pb2 import Response

    rsp = Response()
    rsp.retType = 0
    for code, price in (("AAPL", 271.25), ("TSLA", 402.5)):
        row = rsp.s2c.basicQotList.add()
        row.security.market, row.security.code = 11, code
        row.isSuspended, row.listTime, row.priceSpread = False, "1980-12-12", 0.01
        row.updateTime = "2026-11-09 10:15:30"
        row.highPrice, row.openPrice, row.lowPrice, row.curPrice = price + 2, price - 1, price - 3, price
        row.lastClosePrice, row.volume, row.turnover, row.turnoverRate, row.amplitude = price - 2, 1200, 325500.5, 0.1, 1.8
        if hp_volume is not None:
            row.hpVolume = hp_volume
        if pre_market:
            pre = row.preMarket
            pre.price, pre.highPrice, pre.lowPrice, pre.volume = price + 1, price + 2, price, 300
            pre.turnover, pre.changeVal, pre.changeRate, pre.amplitude = 81000.0, 1.0, 0.37, 0.7
    return rsp


def _ticker_pb(*, with_direction: bool = True):
    from moomoo.common.pb.Qot_UpdateTicker_pb2 import Response

    rsp = Response()
    rsp.retType = 0
    rsp.s2c.security.market, rsp.s2c.security.code = 11, "AAPL"
    rsp.s2c.name = "Apple"
    for index, (volume, hp_volume) in enumerate(((100, None), (0, 0.25), (35, 35.5))):
        row = rsp.s2c.tickerList.add()
        row.time, row.sequence, row.price = f"2026-11-09 10:15:3{index}.125", 7000 + index, 271.25 + index
        row.volume, row.turnover = volume, 27125.0 + index
        row.recvTime = 1_794_000_000.5 + index
        if hp_volume is not None:
            row.hpVolume = hp_volume
        if with_direction:
            row.dir, row.type = 1 + index % 2, 1
    return rsp


def _order_book_pb():
    from moomoo.common.pb.Qot_UpdateOrderBook_pb2 import Response

    rsp = Response()
    rsp.retType = 0
    rsp.s2c.security.market, rsp.s2c.security.code = 11, "AAPL"
    rsp.s2c.svrRecvTimeBid, rsp.s2c.svrRecvTimeAsk = "2026-11-09 10:15:30.125", ""
    for side, price in ((rsp.s2c.orderBookBidList, 271.2), (rsp.s2c.orderBookAskList, 271.3)):
        level = side.add()
        level.price, level.volume, level.orederCount = price, 200, 3
    return rsp


def _rt_pb(*, with_average: bool = True):
    from moomoo.common.pb.Qot_UpdateRT_pb2 import Response

    rsp = Response()
    rsp.retType = 0
    rsp.s2c.security.market, rsp.s2c.security.code = 11, "AAPL"
    for minute in range(2):
        row = rsp.s2c.rtList.add()
        row.time, row.minute, row.isBlank = f"2026-11-09 10:1{minute}:00", 45 + minute, False
        row.price, row.lastClosePrice, row.turnover, row.volume = 271.0 + minute, 269.5, 54200.0, 200
        if with_average:
            row.avgPrice = 270.5
    return rsp


PUSHES = [
    ("StockQuoteHandlerBase", "quote", _quote_pb),
    ("StockQuoteHandlerBase", "quote", lambda: _quote_pb(pre_market=True)),
    ("StockQuoteHandlerBase", "quote", lambda: _quote_pb(hp_volume=1200.75)),
    ("TickerHandlerBase", "trade", _ticker_pb),
    ("TickerHandlerBase", "trade", lambda: _ticker_pb(with_direction=False)),
    ("OrderBookHandlerBase", "orderbook", _order_book_pb),
    ("RTDataHandlerBase", "minute_bar", _rt_pb),
    ("RTDataHandlerBase", "minute_bar", lambda: _rt_pb(with_average=False)),
]
PUSH_IDS = ["quote", "quote_pre_market", "quote_decimal_volume", "ticker", "ticker_unknown_direction", "order_book",
            "minute", "minute_without_average"]


class _Sink:
    def __init__(self) -> None:
        self.events: list[Any] = []

    def publish(self, event: Any) -> bool:
        self.events.append(event)
        return True

    def stop_admission(self) -> None:
        pass


class _Context:
    def __init__(self) -> None:
        self.handlers: list[Any] = []

    def set_handler(self, handler: Any) -> None:
        self.handlers.append(handler)


def _adapter_and_handler(sdk: Any, base_name: str) -> tuple[FutuThinCallbackAdapter, _Sink, Any]:
    sink = _Sink()
    adapter = FutuThinCallbackAdapter(sink, generation=lambda: 1)
    context = _Context()
    adapter.install(context, SimpleNamespace(RET_OK=sdk.RET_OK, **{base_name: getattr(sdk, base_name)}))
    assert len(context.handlers) == 1
    return adapter, sink, context.handlers[0]


def _rows_through_the_dataframe(sdk: Any, base_name: str, rsp: Any) -> list[dict[str, Any]]:
    """What the handler used to read: the SDK's base on_recv_rsp, its DataFrame turned back into dicts."""
    ret_code, data = getattr(sdk, base_name)().on_recv_rsp(rsp)
    assert ret_code == sdk.RET_OK
    if isinstance(data, Mapping):
        return [sdk_payload(data)]
    return [sdk_payload(row) for row in data.to_dict("records")]


def _is_missing(value: Any) -> bool:
    return value is None or (isinstance(value, float) and math.isnan(value))


@pytest.mark.parametrize(("base_name", "kind", "make"), PUSHES, ids=PUSH_IDS)
def test_every_field_the_dataframe_held_decodes_the_same_without_it(base_name: str, kind: str, make: Any) -> None:
    sdk = _sdk()
    rsp = make()
    ret_code, decoded = getattr(sdk, base_name).parse_rsp_pb(rsp)
    assert ret_code == sdk.RET_OK
    decoded_rows = [sdk_payload(row) for row in (decoded if isinstance(decoded, list) else [decoded])]
    frame_rows = _rows_through_the_dataframe(sdk, base_name, rsp)
    assert len(decoded_rows) == len(frame_rows) > 0
    for direct, through_frame in zip(decoded_rows, frame_rows):
        for name, value in through_frame.items():
            assert name in direct, name
            if _is_missing(value):
                assert _is_missing(direct[name]), name
            else:
                assert direct[name] == value, name


@pytest.mark.parametrize(("base_name", "kind", "make"), PUSHES, ids=PUSH_IDS)
def test_the_events_published_are_the_ones_the_dataframe_path_published(base_name: str, kind: str, make: Any) -> None:
    sdk = _sdk()
    rsp = make()
    adapter, sink, handler = _adapter_and_handler(sdk, base_name)
    frame_adapter, frame_sink, _ = _adapter_and_handler(sdk, base_name)

    ret_code, _data = handler.on_recv_rsp(rsp)
    frame_adapter._publish(kind, _rows_through_the_dataframe(sdk, base_name, rsp))

    assert ret_code == sdk.RET_OK
    assert sink.events, "the push was published"
    assert len(sink.events) == len(frame_sink.events)
    for event, frame_event in zip(sink.events, frame_sink.events):
        for name in ("source", "market", "code", "generation", "sequence", "event_type", "exchange_ts_ns", "data",
                     "time_quality", "flags"):
            assert getattr(event, name) == getattr(frame_event, name), name
    assert adapter.snapshot()["rejected"] == frame_adapter.snapshot()["rejected"] == 0


@pytest.mark.parametrize(("base_name", "make"), [("StockQuoteHandlerBase", _quote_pb), ("TickerHandlerBase", _ticker_pb),
                                                 ("RTDataHandlerBase", _rt_pb)], ids=["quote", "ticker", "minute"])
def test_a_push_is_handled_without_building_a_dataframe(base_name: str, make: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    sdk = _sdk()
    module = importlib.import_module(f"{sdk.__name__}.quote.quote_response_handler")
    _, sink, handler = _adapter_and_handler(sdk, base_name)

    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("a DataFrame was built on the SDK's callback thread")

    monkeypatch.setattr(module.pd, "DataFrame", refuse)
    handler.on_recv_rsp(make())
    assert sink.events


def test_a_quote_push_costs_a_fraction_of_the_dataframe_path() -> None:
    """Compared on this machine in the same run, so a slow box does not fail it: the old path was 6.1 ms against 0.09."""
    sdk = _sdk()
    rsp = _quote_pb()
    _, _, handler = _adapter_and_handler(sdk, "StockQuoteHandlerBase")
    frame_adapter, _, _ = _adapter_and_handler(sdk, "StockQuoteHandlerBase")

    def direct() -> None:
        handler.on_recv_rsp(rsp)

    def through_frame() -> None:
        frame_adapter._publish("quote", _rows_through_the_dataframe(sdk, "StockQuoteHandlerBase", rsp))

    def median_seconds(call: Any) -> float:
        taken = []
        for _ in range(60):
            started = time.perf_counter()
            call()
            taken.append(time.perf_counter() - started)
        return statistics.median(taken)

    assert median_seconds(direct) * 5 < median_seconds(through_frame)


# --- The judgement --------------------------------------------------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class _Depth:
    def __init__(self) -> None:
        self.value = 0

    def __call__(self) -> int:
        return self.value


def _meter(clock: _Clock, depth: _Depth | None = None) -> CallbackQueueMeter:
    # A provider name of its own: record_failure counts a repeat of the same record within a minute instead of logging.
    meter = CallbackQueueMeter(f"provider{next(_providers)}", log=LOG, clock=clock)
    if depth is not None:
        meter.attach(depth)
    return meter


def _fill_window(meter: CallbackQueueMeter, clock: _Clock, depth: _Depth, *depths: int) -> None:
    """One whole window of callbacks, each leaving the queue at the given depth, closed by a status read."""
    for value in depths:
        depth.value = value
        meter.handled(0.001)
    clock.advance(10.0)
    meter.backlog()


def _records(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [record.getMessage() for record in caplog.records if record.name == LOG.name]


def test_a_queue_deep_for_a_whole_window_is_a_backlog_recorded_once(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger=LOG.name)
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    _fill_window(meter, clock, depth, 5000, 7000)
    depth.value = 9000
    episode = meter.backlog()
    assert episode is not None and episode["min_depth"] == 5000
    _fill_window(meter, clock, depth, 9000, 12000)
    episode = meter.backlog()
    assert episode is not None and episode["worst_min_depth"] == 9000
    assert len(_records(caplog)) == 1
    assert "CALLBACK_BACKLOG" in _records(caplog)[0]


def test_a_burst_the_queue_drains_within_the_window_is_no_backlog() -> None:
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    _fill_window(meter, clock, depth, 8000, 20, 6000)
    assert meter.backlog() is None


def test_the_limit_itself_is_not_a_backlog() -> None:
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    _fill_window(meter, clock, depth, 1000)
    depth.value = 1001
    assert meter.backlog() is None
    _fill_window(meter, clock, depth, 1001)
    assert meter.backlog() is not None


def test_a_depth_hovering_at_the_limit_is_one_episode(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger=LOG.name)
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    for value in (1200, 800, 1200, 800, 1200):
        _fill_window(meter, clock, depth, value)
        assert meter.backlog() is not None
    assert len(_records(caplog)) == 1
    assert meter.snapshot()["backlog_episodes"] == 1


def test_the_episode_ends_at_the_recovered_depth_and_is_logged_once(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger=LOG.name)
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    _fill_window(meter, clock, depth, 7000)
    _fill_window(meter, clock, depth, 201)
    assert meter.backlog() is not None
    _fill_window(meter, clock, depth, 200)
    assert meter.backlog() is None
    _fill_window(meter, clock, depth, 10)
    records = _records(caplog)
    assert len(records) == 2
    assert "callback backlog ended" in records[1]
    snapshot = meter.snapshot()
    assert snapshot["backlog"] is None and snapshot["backlog_episodes"] == 1


def test_a_callback_thread_that_stopped_delivering_stays_backlogged() -> None:
    """No callback runs at all: only the status reads see the queue, and it must not read as caught up."""
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    depth.value = 5000
    for _ in range(6):
        clock.advance(10.0)
        meter.backlog()
    assert meter.backlog() is not None
    assert meter.snapshot()["callbacks_total"] == 0
    depth.value = 0
    clock.advance(10.0)
    meter.backlog()
    clock.advance(10.0)
    assert meter.backlog() is None


def test_a_meter_with_no_queue_yet_has_no_verdict() -> None:
    clock = _Clock()
    meter = _meter(clock)
    meter.handled(0.001)
    clock.advance(30.0)
    assert meter.backlog() is None
    assert meter.snapshot()["last_window"]["min_depth"] is None


def test_a_depth_that_cannot_be_read_is_recorded_once_and_ends_the_episode(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger=LOG.name)
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    _fill_window(meter, clock, depth, 7000)
    assert meter.backlog() is not None

    def broken() -> int:
        raise AttributeError("no such queue")

    meter._depth = broken
    assert meter.backlog() is None
    meter.handled(0.001)
    assert meter.backlog() is None
    records = [line for line in _records(caplog) if "queue depth" in line]
    assert len(records) == 2 and "reading the" in records[0] and "cannot be read" in records[1]
    assert "AttributeError" in meter.snapshot()["depth_unreadable"]


def test_a_new_connection_ends_the_episode_of_the_old_queue() -> None:
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    _fill_window(meter, clock, depth, 7000)
    assert meter.backlog() is not None
    meter.attach(_Depth())
    assert meter.backlog() is None


def test_the_record_is_written_outside_the_meter_lock(monkeypatch: pytest.MonkeyPatch) -> None:
    clock, depth = _Clock(), _Depth()
    meter = _meter(clock, depth)
    held: list[bool] = []
    monkeypatch.setattr(callback_queue, "record_failure", lambda *_a, **_k: held.append(meter._lock.locked()))
    _fill_window(meter, clock, depth, 7000)
    assert held == [False]


def test_handled_callbacks_report_how_busy_the_callback_thread_is() -> None:
    clock = _Clock()
    meter = _meter(clock)
    for _ in range(4):
        meter.handled(0.5)
    clock.advance(10.0)
    meter.backlog()
    snapshot = meter.snapshot()
    assert snapshot["last_window"]["callbacks"] == 4 and snapshot["last_window"]["busy_ratio"] == 0.2
    assert snapshot["callbacks_total"] == 4 and snapshot["handler_seconds_total"] == 2.0


def test_old_event_times_are_no_backlog() -> None:
    """A PC clock seconds off and OpenD's replay of an old print: the event's own time plays no part in the verdict."""
    adapter = FutuThinCallbackAdapter(_Sink(), generation=lambda: 1)
    clock = _Clock()
    adapter._queue = _meter(clock, _Depth())
    row = {"code": "US.AAPL", "time": "2020-01-02 10:15:30.125", "price": 271.25, "volume": 1}
    for _ in range(4):
        adapter._publish("trade", [row])
        adapter._publish("trade", [row])
        clock.advance(10.0)
        assert adapter.callback_backlog() is None


class _QueueContext(_Context):
    def __init__(self) -> None:
        super().__init__()
        self._callback_executor = SimpleNamespace(queue=queue.Queue())


class _PlainHandler:
    @staticmethod
    def parse_rsp_pb(_rsp_pb: Any) -> tuple[int, Any]:
        return 0, []


def test_install_reads_the_queue_of_the_context_it_installed_on() -> None:
    adapter = FutuThinCallbackAdapter(_Sink(), generation=lambda: 1)
    context = _QueueContext()
    adapter.install(context, SimpleNamespace(RET_OK=0, TickerHandlerBase=_PlainHandler))
    for _ in range(3):
        context._callback_executor.queue.put(object())
    adapter.callback_backlog()
    assert adapter.snapshot()["callback_queue"]["current_window"]["max_depth"] == 3


def test_the_real_sdk_keeps_its_callback_queue_where_install_reads_it() -> None:
    _sdk()
    from moomoo.common import open_context_base
    from moomoo.common.callback_executor import CallbackExecutor

    assert "self._callback_executor = CallbackExecutor()" in inspect.getsource(open_context_base.OpenContextBase.__init__)
    executor = CallbackExecutor()
    try:
        assert executor.queue.qsize() == 0
    finally:
        executor.close()


def test_a_push_that_fails_to_decode_is_counted_and_goes_no_further() -> None:
    class Failing:
        @staticmethod
        def parse_rsp_pb(_rsp_pb: Any) -> tuple[int, Any]:
            raise ValueError("bad push")

    adapter = FutuThinCallbackAdapter(_Sink(), generation=lambda: 1)
    context = _QueueContext()
    adapter.install(context, SimpleNamespace(RET_OK=0, RET_ERROR=-1, TickerHandlerBase=Failing))
    ret_code, _data = context.handlers[0].on_recv_rsp(b"")
    snapshot = adapter.snapshot()
    assert ret_code == -1
    assert snapshot["rejected"] == 1 and snapshot["last_rejection"]["ret_code"] == "decode_error"
    assert snapshot["callback_queue"]["callbacks_total"] == 1


@pytest.fixture()
def futu(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("FUTU_MARKET_DB", str(tmp_path / "futu.db"))
    monkeypatch.setenv("FUTU_SECURITY_MASTER_FILE", str(tmp_path / "master.csv"))
    monkeypatch.setattr(futu_service, "resolve_session", lambda _spec: SimpleNamespace(active=True))
    service = futu_service.FutuMarketService()
    service._opend.connected = True
    service._thread = SimpleNamespace(is_alive=lambda: True)
    manager = service.subscription_manager
    manager.replace_plan([{"market": "US", "code": "US.AAPL", "kinds": ["quote", "trade"]}])
    for lane in manager.subscription_plan("US.AAPL").watchlist_lanes:
        manager.confirmed_pairs.add(("US.AAPL", lane))
    return service


def test_a_backlog_makes_the_provider_stale_and_its_end_clears_it(futu: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert futu.read_status()["readiness"]["state"] == "READY"
    monkeypatch.setattr(futu.thin_callback, "callback_backlog", lambda: {"min_depth": 7000})
    readiness = futu.read_status()["readiness"]
    assert readiness["state"] == "STALE" and readiness["stale"] is True and readiness["reason"] == "CALLBACK_BACKLOG"
    monkeypatch.setattr(futu.thin_callback, "callback_backlog", lambda: None)
    assert futu.read_status()["readiness"]["state"] == "READY"


# --- The snapshot read: the one SDK answer still a DataFrame --------------------------------------------------------


def test_the_snapshot_behind_the_previous_close_reaches_the_reference_publisher_as_rows() -> None:
    """get_market_snapshot answers a DataFrame: dropping the frame branch from the push decode must not lose 昨收."""
    pandas = pytest.importorskip("pandas")
    frame = pandas.DataFrame([{"code": "US.AAPL", "name": "Apple", "prev_close_price": 269.5},
                              {"code": "US.TSLA", "name": "Tesla", "prev_close_price": 395.0}])
    bars = pandas.DataFrame([{"code": "CC.BTCUSD", "time_key": "2026-11-10 16:00:00", "close": 73701.88841}])
    rt = pandas.DataFrame([{"code": "US.AAPL", "time": "2026-11-13 09:31:00", "cur_price": 250.0, "volume": 100, "turnover": 25000.0}])
    read: list[list[dict[str, Any]]] = []
    asked: list[tuple[Any, ...]] = []
    backfilled: list[tuple[list[str], list[Any]]] = []

    class Context:
        def get_market_snapshot(self, _codes: list[str]) -> tuple[int, Any]:
            return 0, frame

        def request_history_kline(self, code: str, **kwargs: Any) -> tuple[int, Any, Any]:
            asked.append((code, kwargs))
            return 0, bars, None   # (ret, frame, page key), as the SDK answers

        def get_rt_data(self, _code: str) -> tuple[int, Any]:
            return 0, rt

    def run(snapshot, codes, kline):
        read.append(snapshot(sorted(codes)))
        read.append(kline("CC.BTCUSD", "2026-11-10 15:50:00", "2026-11-10 16:00:00"))

    def trend_run(fetch, codes):
        backfilled.append((sorted(codes), [fetch(code) for code in sorted(codes)]))
        return 0

    provider = SimpleNamespace(
        pollable_watch_codes=lambda: ([], []),
        subscription_manager=SimpleNamespace(
            confirmed_snapshot=lambda: {("US.AAPL", "quote"), ("US.TSLA", "quote"), ("US.AAPL", "RT_DATA")},
            sync=lambda *_a, **_k: {}),
        notify_subscriptions_changed=lambda: None,
        reference=SimpleNamespace(run=run),
        trend_backfill=SimpleNamespace(run=trend_run),
    )
    sdk = SimpleNamespace(RET_OK=0, KLType=SimpleNamespace(K_1M="K_1M"))
    lifecycle = FutuOpenDLifecycle(provider, state=OpenDConnectionState(context_generation=1, sdk=sdk), lock=threading.RLock(),
                                   stop=threading.Event(), wake=threading.Event())

    lifecycle.sync_context(Context())

    assert read == [[{"code": "US.AAPL", "name": "Apple", "prev_close_price": 269.5},
                     {"code": "US.TSLA", "name": "Tesla", "prev_close_price": 395.0}],
                    [{"code": "CC.BTCUSD", "time_key": "2026-11-10 16:00:00", "close": 73701.88841}]]
    assert asked == [("CC.BTCUSD", {"start": "2026-11-10 15:50:00", "end": "2026-11-10 16:00:00", "ktype": "K_1M",
                                    "max_count": 20})]
    # The RT_DATA-subscribed code's today 分時 reaches the trend backfill as get_rt_data rows (US.TSLA has no RT_DATA pair).
    assert backfilled == [(["US.AAPL"], [[{"code": "US.AAPL", "time": "2026-11-13 09:31:00", "cur_price": 250.0,
                                           "volume": 100, "turnover": 25000.0}]])]


# --- The SDK's file log ---------------------------------------------------------------------------------------------

_LOG_LEVEL_PROBE = """
import glob, os, sys
sys.path.insert(0, sys.argv[1])
from service.market.futu.opend_lifecycle import FutuOpenDLifecycle
sdk = FutuOpenDLifecycle.load_sdk(object.__new__(FutuOpenDLifecycle))
from moomoo.common.ft_logger import logger
logger.debug("per-push line")
logger.info("connect line")
logger.warning("queue line")
logger.fileHandler.flush()
print(open(glob.glob(os.path.join(os.environ["APPDATA"], "com.moomoo.OpenD", "Log", "py_*.log"))[0], encoding="utf-8").read())
"""


def test_the_real_sdk_file_log_stops_writing_each_push_once_loaded(tmp_path: Path) -> None:
    """A process of its own: the SDK opens its log file at import, under the %APPDATA% of that process."""
    _sdk()
    # APPDATA also places the user site-packages (where the SDK is installed here): named explicitly so it stays found.
    env = {**os.environ, "APPDATA": str(tmp_path), "PYTHONPATH": site.getusersitepackages()}
    result = subprocess.run([sys.executable, "-c", _LOG_LEVEL_PROBE, str(ROOT)], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", env=env, timeout=60, cwd=str(tmp_path), check=False)
    assert result.returncode == 0, result.stderr
    assert "per-push line" not in result.stdout
    assert "connect line" in result.stdout and "queue line" in result.stdout


def test_load_sdk_lowers_the_file_log_of_the_package_it_loaded(monkeypatch: pytest.MonkeyPatch) -> None:
    from service.market.futu import opend_lifecycle

    logger = SimpleNamespace(file_level=logging.DEBUG)
    sdk = SimpleNamespace()

    def fake_import(name: str) -> Any:
        if name == "moomoo":
            raise ModuleNotFoundError(name)
        return {"futu": sdk, "futu.common.ft_logger": SimpleNamespace(logger=logger)}[name]

    monkeypatch.setattr(opend_lifecycle.importlib, "import_module", fake_import)
    assert FutuOpenDLifecycle.load_sdk(object.__new__(FutuOpenDLifecycle)) is sdk
    assert logger.file_level == logging.INFO


@pytest.mark.parametrize("failure", [ModuleNotFoundError("moomoo.common.ft_logger"), AttributeError("logger")],
                         ids=["module_gone", "logger_gone"])
def test_an_sdk_whose_log_cannot_be_lowered_still_loads(failure: Exception, monkeypatch: pytest.MonkeyPatch,
                                                        caplog: pytest.LogCaptureFixture) -> None:
    from service.market.futu import opend_lifecycle

    sdk = SimpleNamespace()

    def fake_import(name: str) -> Any:
        if name == "moomoo":
            return sdk
        raise failure

    caplog.set_level(logging.WARNING, logger=opend_lifecycle.__name__)
    monkeypatch.setattr(opend_lifecycle.importlib, "import_module", fake_import)
    assert FutuOpenDLifecycle.load_sdk(object.__new__(FutuOpenDLifecycle)) is sdk
    assert any("lowering the SDK file log" in record.getMessage() for record in caplog.records)
