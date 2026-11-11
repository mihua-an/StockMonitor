"""How far a broker SDK's callback queue has fallen behind, and the verdict when it stays behind.

A broker SDK hands pushes to the adapter on its own callback thread through its own queue (OpenD's is an unbounded
``queue.Queue``): an adapter slower than the push rate never drops anything and never raises, its queue just grows and
every event arrives later than the one before. Nothing downstream can see that -- Market Runtime receives a steady
stream, only of old events -- so the adapter reads the depth of that queue.

The depth needs no clock and no event time, so a PC clock that is seconds off and an old print OpenD replays for a new
subscription cannot look like a backlog. It is read after every callback and at every status read, so a callback thread
that stopped delivering still shows. Per window the smallest depth is kept: a queue that keeps up comes back near empty
at least once in a window however large a burst was, a backlog never does. An episode opens above
``CALLBACK_BACKLOG_DEPTH`` and closes only at ``CALLBACK_RECOVERED_DEPTH``, so a depth hovering at the limit is one
episode; each is recorded once when it starts and once when it ends (AGENTS.md R4).
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from service.platform.failure_record import record_failure

# One window of depths judged at a time: long enough for a healthy queue to have drained, short enough that a backlog
# shows within seconds of beginning.
CALLBACK_QUEUE_WINDOW_SECONDS = 10.0
# The depth the SDK itself calls large: about 5 s of pushes at the US open (180 a second measured on 11-09).
CALLBACK_BACKLOG_DEPTH = 1000
# About 1 s of pushes at the same rate: the queue has really caught up.
CALLBACK_RECOVERED_DEPTH = 200

_Note = Callable[[], None]


class _Window:
    __slots__ = ("start", "samples", "min_depth", "max_depth", "handled", "busy")

    def __init__(self, start: float) -> None:
        self.start = start
        self.samples = 0
        self.min_depth = 0
        self.max_depth = 0
        self.handled = 0
        self.busy = 0.0

    def add_depth(self, depth: int) -> None:
        self.min_depth = depth if self.samples == 0 else min(self.min_depth, depth)
        self.max_depth = max(self.max_depth, depth)
        self.samples += 1

    def summary(self, now: float) -> dict[str, Any]:
        span = max(1e-9, now - self.start)
        return {"samples": self.samples,
                "min_depth": self.min_depth if self.samples else None,
                "max_depth": self.max_depth if self.samples else None,
                "callbacks": self.handled, "busy_ratio": round(min(1.0, self.busy / span), 3),
                "seconds": round(span, 3)}


class CallbackQueueMeter:
    """Depth of a provider's callback queue, per window, and whether it is backlogged now."""

    def __init__(self, provider: str, *, log: logging.Logger,
                 window_seconds: float = CALLBACK_QUEUE_WINDOW_SECONDS,
                 backlog_depth: int = CALLBACK_BACKLOG_DEPTH,
                 recovered_depth: int = CALLBACK_RECOVERED_DEPTH,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._provider = provider
        self._log = log
        self._window_seconds = float(window_seconds)
        self._backlog_depth = int(backlog_depth)
        self._recovered_depth = int(recovered_depth)
        self._clock = clock
        self._lock = threading.Lock()
        self._depth: Callable[[], int] | None = None
        self._unreadable: str | None = None
        self._current = _Window(clock())
        self._last: dict[str, Any] | None = None
        self._handled_total = 0
        self._busy_total = 0.0
        # The open backlog episode (started at, worst window minimum) and how many there were.
        self._backlog: dict[str, Any] | None = None
        self._episodes = 0

    def attach(self, depth: Callable[[], int]) -> None:
        """Read the queue through ``depth`` from now on: a new connection has a queue of its own."""
        with self._lock:
            now = self._clock()
            self._depth = depth
            self._unreadable = None
            self._current = _Window(now)
            note = self._end_backlog(now, "the connection was replaced")
        self._write(note)

    def _read_depth(self) -> int | None:
        depth = self._depth
        if depth is None:
            return None
        try:
            return int(depth())
        except Exception as exc:  # the depth is read through the SDK's internals: the feed must outlive them changing
            self._depth = None
            self._unreadable = f"{type(exc).__name__}: {exc}"
            record_failure(self._log, f"reading the {self._provider} callback queue depth", exc)
            return None

    def handled(self, seconds: float) -> None:
        """One SDK callback took ``seconds`` on the SDK's callback thread (the busy share says how near saturation it
        runs)."""
        depth = self._read_depth()
        with self._lock:
            window = self._current
            window.handled += 1
            window.busy += seconds
            self._handled_total += 1
            self._busy_total += seconds
            if depth is not None:
                window.add_depth(depth)
            note = self._roll()
        self._write(note)

    def _roll(self) -> _Note | None:
        """Caller holds the lock: closes (and judges) the current window if its time is up. What to record is returned,
        for the caller to write after releasing the lock: the callback thread must not wait on a log write."""
        now = self._clock()
        window = self._current
        if now - window.start < self._window_seconds:
            return None
        self._last = window.summary(now)
        self._current = _Window(now)
        return self._judge(window.min_depth, now) if window.samples else None

    def _judge(self, min_depth: int, now: float) -> _Note | None:
        note: _Note | None = None
        if self._backlog is None:
            if min_depth <= self._backlog_depth:
                return None
            self._episodes += 1
            self._backlog = {"since_monotonic": now, "since_ns": time.time_ns(), "worst_min_depth": 0}
            message = (f"CALLBACK_BACKLOG: at least {min_depth} pushes stayed queued throughout the last "
                       f"{self._window_seconds:.0f} s (limit {self._backlog_depth}); the SDK's callback queue is growing")
            note = lambda: record_failure(self._log, f"{self._provider} callbacks keeping up", RuntimeError(message))
        elif min_depth <= self._recovered_depth:
            return self._end_backlog(now, f"the queue is down to {min_depth} pushes")
        self._backlog["min_depth"] = min_depth
        self._backlog["worst_min_depth"] = max(self._backlog["worst_min_depth"], min_depth)
        return note

    def _end_backlog(self, now: float, why: str) -> _Note | None:
        if self._backlog is None:
            return None
        episode, self._backlog = self._backlog, None
        seconds, worst = now - episode["since_monotonic"], episode["worst_min_depth"]
        return lambda: self._log.warning("%s callback backlog ended after %.0f s (worst window minimum %d pushes): %s",
                                         self._provider, seconds, worst, why)

    @staticmethod
    def _write(*notes: _Note | None) -> None:
        for note in notes:
            if note is not None:
                note()

    def backlog(self) -> dict[str, Any] | None:
        """The open backlog episode, or None. A depth that can no longer be read leaves nothing to judge: the episode
        ends there."""
        depth = self._read_depth()
        with self._lock:
            if depth is not None:
                self._current.add_depth(depth)
            note = self._roll()
            gone = self._end_backlog(self._clock(), "the queue depth cannot be read") if self._depth is None else None
            result = None if self._backlog is None else {
                key: value for key, value in self._backlog.items() if key != "since_monotonic"}
        self._write(note, gone)
        return result

    def snapshot(self) -> dict[str, Any]:
        backlog = self.backlog()
        with self._lock:
            now = self._clock()
            return {"window_seconds": self._window_seconds, "backlog_depth": self._backlog_depth,
                    "recovered_depth": self._recovered_depth, "depth_unreadable": self._unreadable,
                    "callbacks_total": self._handled_total, "handler_seconds_total": round(self._busy_total, 3),
                    "current_window": self._current.summary(now),
                    "last_window": self._last, "backlog": backlog, "backlog_episodes": self._episodes}
