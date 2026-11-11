"""Machine times in shared health payloads carry their UTC offset: a naive local time is ambiguous once records of
several processes (or a time-zone change) meet."""
from datetime import datetime

from service.market.shared.daemon_shutdown_state import DaemonShutdownState
from service.market.shared.provider_contract import LaneDeliveryEvidence


def _aware(text):
    return datetime.fromisoformat(text).utcoffset() is not None


def test_delivery_and_shutdown_times_have_an_offset():
    assert _aware(LaneDeliveryEvidence._iso(1_791_177_579_000_000_000))
    state = DaemonShutdownState()
    state.begin("test")
    state.complete()
    assert _aware(state.state["started_at"]) and _aware(state.state["finished_at"])
