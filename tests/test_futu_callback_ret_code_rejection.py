"""Futu's on_recv_rsp used to silently drop any push with ret_code != RET_OK:
no counter, no log, no diagnostics -- only the RET_OK branch did anything.
The fix records a count and the last rejection (kind/ret_code/message),
surfaced through FutuThinCallbackAdapter.snapshot() (already wired into
FutuMarketService.status() via self.thin_callback.snapshot()). The data flow
itself is unchanged: a rejected push is still not submitted/processed.
"""

from types import SimpleNamespace

from service.market.futu.callback import FutuThinCallbackAdapter


class _FakeHandlerBase:
    def parse_rsp_pb(self, rsp_pb):
        # Real SDK base classes decode the protobuf into (ret_code, data);
        # tests pass that tuple straight through.
        return rsp_pb


class _FakeContext:
    def __init__(self):
        self.handlers = []

    def set_handler(self, handler):
        self.handlers.append(handler)


def _install_single_handler():
    submitted = []

    class Sink:
        def publish(self, event):
            submitted.append((event.event_type, event.code))
            return True

        def stop_admission(self):
            pass

    adapter = FutuThinCallbackAdapter(Sink(), generation=lambda: 1)
    sdk = SimpleNamespace(RET_OK=0, TickerHandlerBase=_FakeHandlerBase)
    context = _FakeContext()
    installed = adapter.install(context, sdk)
    assert installed == 1
    return adapter, context.handlers[0], submitted


def test_ret_ok_submits_and_records_no_rejection():
    adapter, handler, submitted = _install_single_handler()

    handler.on_recv_rsp((0, {"code": "US.AAPL", "price": 1.5, "volume": 3, "time": "2026-10-01 10:00:00"}))

    assert submitted == [("trade", "US.AAPL")]
    snap = adapter.snapshot()
    assert snap["rejected"] == 0
    assert snap["last_rejection"] is None


def test_ret_code_failure_is_observable_and_not_submitted():
    adapter, handler, submitted = _install_single_handler()

    ret_code, data = handler.on_recv_rsp((-1, "some OpenD error string"))

    assert (ret_code, data) == (-1, "some OpenD error string")  # unchanged return contract
    assert submitted == []  # still dropped, same as before this fix
    snap = adapter.snapshot()
    assert snap["rejected"] == 1
    assert snap["last_rejection"] == {"kind": "trade", "ret_code": -1, "message": "some OpenD error string"}


def test_rejections_accumulate_and_last_rejection_overwrites():
    adapter, handler, submitted = _install_single_handler()

    handler.on_recv_rsp((-1, "first error"))
    handler.on_recv_rsp((-2, "second error"))

    snap = adapter.snapshot()
    assert snap["rejected"] == 2
    assert snap["last_rejection"]["message"] == "second error"
    assert submitted == []


def test_rejection_message_is_truncated_to_avoid_unbounded_growth():
    adapter, handler, _ = _install_single_handler()

    handler.on_recv_rsp((-1, "x" * 5000))

    snap = adapter.snapshot()
    assert len(snap["last_rejection"]["message"]) <= 200
