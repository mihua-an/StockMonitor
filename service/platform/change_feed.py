"""Change notifications for Server-Sent Events streams: one feed per thing that changes, any number of streams.

The owner of a changing artifact (a ledger's positions, the paper order desk, a provider's security master, the
product catalog) publishes on its feed whenever it changes, on whatever thread changed it. Each reader keeps one SSE
stream open (``revision_events``): the identity now, then one event per change -- nobody polls.

Subscribers live on the server's event loop; ``publish`` may be called from any thread. ``close`` ends every stream
(a draining service must not wait on them).

Every payload is the changed thing's identity now (its revision), so a newer one replaces an older one a reader has
not taken yet: a slow reader holds one pending payload, never every revision since it last read. A subscriber whose
event loop is gone is removed and recorded.
"""
from __future__ import annotations

import logging
import threading
from typing import Any, Callable

from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

_CLOSED = None


class Subscription:
    """One reader's pending change: the latest payload not yet taken, or the close. Lives on its event loop."""

    def __init__(self, loop) -> None:
        import asyncio

        self.loop = loop
        self._ready = asyncio.Event()
        self._latest: dict[str, Any] | None = None
        self._closed = False

    def _offer(self, payload: dict[str, Any] | None) -> None:
        if payload is _CLOSED:
            self._closed = True
        else:
            self._latest = payload
        self._ready.set()

    async def get(self) -> dict[str, Any] | None:
        """The latest change since the last get (``None`` once the feed closed). Cancelling a wait loses nothing."""
        await self._ready.wait()
        self._ready.clear()
        if self._latest is not None:
            payload, self._latest = self._latest, None
            return payload
        if self._closed:
            self._ready.set()       # every later get answers the close too
        return _CLOSED


class ChangeFeed:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: set[Subscription] = set()
        self._closed = False
        self.published = 0
        self.dropped_subscribers = 0

    def _deliver(self, targets: list[Subscription], payload: dict[str, Any] | None) -> None:
        for sub in targets:
            try:
                sub.loop.call_soon_threadsafe(sub._offer, payload if payload is _CLOSED else dict(payload))
            except RuntimeError as exc:
                # The stream's event loop is closed without it having unsubscribed: it can never read again.
                with self._lock:
                    self._subscribers.discard(sub)
                    self.dropped_subscribers += 1
                record_failure(_failure_log, "delivering a change to a subscriber whose event loop is closed (removed)", exc)

    def publish(self, payload: dict[str, Any]) -> None:
        with self._lock:
            self.published += 1
            targets = list(self._subscribers)
        self._deliver(targets, payload)

    def subscribe(self) -> Subscription:
        """The reader's subscription: ``await sub.get()`` for the latest change (``None`` when the feed closes). Call
        from the event loop."""
        import asyncio

        sub = Subscription(asyncio.get_running_loop())
        with self._lock:
            if self._closed:
                sub._offer(_CLOSED)
            else:
                self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            self._subscribers.discard(sub)

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            targets = list(self._subscribers)
            self._subscribers.clear()
        self._deliver(targets, _CLOSED)


async def revision_events(feed: ChangeFeed, event: str, current: Callable[[], dict[str, Any]], heartbeat_s: float):
    """The body of one SSE stream over ``feed``: ``event`` with ``current()`` now, then one per published change; a
    comment line every ``heartbeat_s`` lets a dead connection be noticed; the stream ends when the feed closes.
    Subscribed before ``current()`` is read: a change in between is still delivered."""
    import asyncio
    import json

    queue = feed.subscribe()
    try:
        yield f"event: {event}\ndata: {json.dumps(current())}\n\n"
        while True:
            try:
                payload = await asyncio.wait_for(queue.get(), heartbeat_s)
            except asyncio.TimeoutError:  # not an error: the heartbeat interval passed with no change: a heartbeat is sent
                yield ": heartbeat\n\n"
                continue
            if payload is None:
                return
            yield f"event: {event}\ndata: {json.dumps(payload)}\n\n"
    finally:
        feed.unsubscribe(queue)
