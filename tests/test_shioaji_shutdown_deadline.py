"""Every step of the Shioaji service's shutdown shares runtime.stop's deadline, and the sink's drain keeps its part."""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace

from service.market.shioaji.service import ShioajiMarketService


def _service(worker_seconds: list[float], close_timeouts: list[float]):
    """The real shutdown over doubles: each worker uses all the time it is given."""

    def worker():
        def shutdown(timeout):
            worker_seconds.append(timeout)
            time.sleep(timeout)
            return {"ok": False, "running": True}

        return SimpleNamespace(shutdown=shutdown)

    def close(timeout):
        close_timeouts.append(timeout)
        return {"ok": True}

    service = ShioajiMarketService.__new__(ShioajiMarketService)
    service._shutdown_lock = threading.RLock()
    service._state_lock = threading.RLock()
    service._shutdown_complete = False
    service._run_stop_event = threading.Event()
    service.market_maintenance_coordinator = worker()
    service.kbar_download_manager = worker()
    service.live_event_sink = SimpleNamespace(stop_admission=lambda: None, close=close)
    service.broker_service = SimpleNamespace(begin_graceful_shutdown=lambda **_kw: {})
    return service


def test_busy_workers_cannot_take_the_time_of_the_drain():
    workers: list[float] = []
    closes: list[float] = []
    service = _service(workers, closes)
    started = time.monotonic()
    service.shutdown_background_processing(defer_broker_logout=True, deadline=started + 2.0)
    assert sum(workers) <= 0.3, workers
    assert closes[0] >= 1.5, closes
    assert closes[0] <= 2.0 and time.monotonic() - started < 2.0


def test_without_a_stop_each_worker_keeps_its_own_bound():
    workers: list[float] = []
    closes: list[float] = []
    service = _service(workers, closes)
    service.market_maintenance_coordinator = SimpleNamespace(
        shutdown=lambda timeout: workers.append(timeout) or {"ok": True})
    service.kbar_download_manager = service.market_maintenance_coordinator
    service.shutdown_background_processing()
    assert workers[0] == 5.0 and closes
