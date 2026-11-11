"""A paper order desk still being built when the service stops is closed, never started afterwards.

``start()`` built the desk on a thread and started it; ``close()`` and ``prepare_shutdown()`` only closed a desk that
already existed, so a desk finished during the shutdown went on polling the paper ledger.
"""
from __future__ import annotations

import asyncio
import threading

from api.services import paper_account_api


class _Desk:
    def __init__(self) -> None:
        self.started = self.closed = 0

    def start(self) -> None:
        self.started += 1

    def close(self, timeout: float = 0) -> bool:
        self.closed += 1
        return True


class _Host:
    service_id = "paper_account_api"
    components = None
    stream_closers: list = []


def _resources(factory):
    resources = paper_account_api.Resources(_Host())
    resources.components.paper_orders = lambda: resources.components._get("paper_orders", factory)
    return resources


def test_a_desk_built_during_the_shutdown_is_closed_not_started():
    building, release = threading.Event(), threading.Event()
    desk = _Desk()

    def slow_factory():
        building.set()
        release.wait(5)
        return desk

    resources = _resources(slow_factory)

    async def scenario():
        await resources.start()
        assert await asyncio.to_thread(building.wait, 5)
        receipt = await asyncio.to_thread(resources.prepare_shutdown)
        assert receipt["paper_orders_stopped"] is True, "no desk is running yet"
        release.set()
        await resources.close()

    asyncio.run(scenario())
    assert desk.started == 0, "built after the shutdown began: never started"
    assert desk.closed >= 1


def test_a_desk_started_before_the_shutdown_is_the_one_it_closes():
    desk = _Desk()
    resources = _resources(lambda: desk)

    async def scenario():
        await resources.start()
        await resources._desk_task
        assert desk.started == 1
        await asyncio.to_thread(resources.prepare_shutdown)
        await resources.close()

    asyncio.run(scenario())
    assert desk.closed >= 1
