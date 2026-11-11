"""A change feed holds one pending payload per reader (the latest revision), not every revision since its last read;
a reader whose event loop closed without unsubscribing is removed and recorded."""
from __future__ import annotations

import asyncio
import threading

from service.platform.change_feed import ChangeFeed


def test_a_slow_reader_gets_the_latest_change_not_every_one():
    async def run():
        feed = ChangeFeed()
        sub = feed.subscribe()
        for revision in range(1000):
            feed.publish({"revision": revision})
        await asyncio.sleep(0)
        assert await sub.get() == {"revision": 999}
        try:
            await asyncio.wait_for(sub.get(), 0.05)
            raise AssertionError("nothing new was published")
        except asyncio.TimeoutError:  # not an error: the expected outcome -- no pending change
            pass
        feed.publish({"revision": 1000})
        assert await asyncio.wait_for(sub.get(), 1) == {"revision": 1000}, "a timed-out wait lost nothing"
        feed.close()
        assert await sub.get() is None
        assert await sub.get() is None, "the close stays answered"
    asyncio.run(run())


def test_a_change_published_from_another_thread_arrives():
    async def run():
        feed = ChangeFeed()
        sub = feed.subscribe()
        threading.Thread(target=feed.publish, args=({"revision": 7},)).start()
        assert await asyncio.wait_for(sub.get(), 2) == {"revision": 7}
    asyncio.run(run())


def test_a_subscriber_whose_loop_closed_is_removed_and_counted():
    feed = ChangeFeed()
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(asyncio.sleep(0))
        sub = loop.run_until_complete(_subscribe(feed))
    finally:
        loop.close()
    assert feed.subscriber_count() == 1
    feed.publish({"revision": 1})
    assert feed.subscriber_count() == 0 and feed.dropped_subscribers == 1
    assert sub is not None


async def _subscribe(feed):
    return feed.subscribe()
