"""MarketDaemonStream (Shioaji's backend<-daemon /v1/stream client) used to
swallow any json.loads failure with a bare `except Exception: continue` --
no counter, no log. The fix calls an optional decode_error() callback (kept
separate from failed(), which represents a real connection failure and would
otherwise incorrectly trigger reconnect/backoff for a single bad frame).
"""

import threading

from service.market.shioaji.daemon_stream import MarketDaemonStream


class _FakeWebSocket:
    def __init__(self, frames, running: threading.Event):
        self._frames = list(frames)
        self._running = running

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def recv(self, timeout=None):
        if self._frames:
            return self._frames.pop(0)
        # Frames exhausted: stop the stream cleanly (must clear `running`,
        # this loop's "keep going" flag) instead of looping forever trying
        # to reconnect.
        self._running.clear()
        return None

    def send(self, data):
        pass


def _run_stream(monkeypatch, frames, *, route=None, failed=None, decode_error=None):
    running = threading.Event()
    running.set()
    fake_ws = _FakeWebSocket(frames, running)
    monkeypatch.setattr("websockets.sync.client.connect", lambda uri, **kwargs: fake_ws)
    stream = MarketDaemonStream(
        client_id="test-client",
        heartbeat_seconds=30,
        prepare_connection=lambda: None,
        route=route or (lambda msg: None),
        failed=failed or (lambda msg: None),
        decode_error=decode_error,
    )
    stream.run(running)


def test_malformed_frame_calls_decode_error_not_failed(monkeypatch):
    routed = []
    failed_calls = []
    decode_errors = []

    _run_stream(
        monkeypatch,
        frames=["not json at all", '{"type": "ok", "payload": {}}'],
        route=lambda msg: routed.append(msg),
        failed=lambda msg: failed_calls.append(msg),
        decode_error=lambda: decode_errors.append(1),
    )

    assert decode_errors == [1]
    assert failed_calls == []  # a single bad frame must not look like a connection failure
    assert routed == [{"type": "ok", "payload": {}}]


def test_decode_error_callback_is_optional(monkeypatch):
    # Existing callers that do not pass decode_error must keep working
    # unchanged (backward compatible optional parameter).
    routed = []
    _run_stream(monkeypatch, frames=["not json", '{"type": "ok"}'], route=lambda msg: routed.append(msg))
    assert routed == [{"type": "ok"}]


def test_well_formed_non_dict_json_is_not_counted_as_a_decode_error(monkeypatch):
    # Scope guard: this fix only targets json.loads failures, not the
    # separate "valid JSON but not an object" shape-mismatch drop.
    decode_errors = []
    routed = []
    _run_stream(
        monkeypatch,
        frames=["[1, 2, 3]"],
        route=lambda msg: routed.append(msg),
        decode_error=lambda: decode_errors.append(1),
    )
    assert decode_errors == []
    assert routed == []
