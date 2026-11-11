"""A component's status, the built list and the failed list are read while a slow factory runs, never behind it.

``Deferred.resolve()`` held the state lock through the whole factory and ``status()`` took the same lock, so a
metrics read during a cold build waited for it (the monitoring probe timed out); ``Components._get`` did the same
with the container lock.
"""
from __future__ import annotations

import threading
import time

from api.components import Components, Deferred


def _in_background(fn):
    thread = threading.Thread(target=fn, daemon=True)
    thread.start()
    return thread


def test_deferred_status_answers_during_a_build_and_waiters_get_its_outcome():
    entered, release = threading.Event(), threading.Event()
    builds = []

    def factory():
        builds.append(1)
        entered.set()
        release.wait(5)
        return "built"

    deferred = Deferred("slow", factory)
    results = []
    first = _in_background(lambda: results.append(deferred.resolve()))
    assert entered.wait(5)
    second = _in_background(lambda: results.append(deferred.resolve()))
    started = time.monotonic()
    assert deferred.status()["state"] == "BUILDING"
    assert deferred.built() is None
    assert time.monotonic() - started < 0.5, "status() did not wait for the factory"
    release.set()
    first.join(5), second.join(5)
    assert results == ["built", "built"] and len(builds) == 1, "built once; the waiter got the same value"
    assert deferred.status()["state"] == "READY"


def test_components_lists_answer_during_a_build():
    entered, release = threading.Event(), threading.Event()
    components = Components("probe")

    def slow():
        entered.set()
        release.wait(5)
        return object()

    builder = _in_background(lambda: components._get("slow", slow))
    assert entered.wait(5)
    started = time.monotonic()
    assert components.built() == [] and components.failed() == [] and components.peek("slow") is None
    assert not components.built_component("slow")
    assert time.monotonic() - started < 0.5
    release.set()
    builder.join(5)
    assert components.built() == ["slow"] and components.peek("slow") is not None
    assert components._get("slow", lambda: (_ for _ in ()).throw(AssertionError("built twice"))) is components.peek("slow")
