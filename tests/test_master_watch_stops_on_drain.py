"""app_api's security-master watches end when the service drains, not when its process exits; the close waits for them.

A full shutdown drains the APIs and then stops the providers at once; the process exit (and the lifespan's close) come
later, so a watch still open then would see the provider end its stream and record a
client.security_master_events_reconnect on every full close. The close then waits, bounded, for every watch and the
catalog's start check, so nothing they started writes the catalog after the service closed."""
from __future__ import annotations

import asyncio
import inspect
import threading

from api.service_host import ServiceHost
from api.services import settings_api


class _Watch:
    def __init__(self, service_id="provider_shioaji", ends=True):
        self.service_id = service_id
        self.stopped = 0
        self.joined: list[float] = []
        self.ends = ends

    def stop(self):
        self.stopped += 1

    def join(self, timeout_s):
        self.joined.append(timeout_s)
        return self.ends


def _resources():
    host = ServiceHost("app_api", port=0, config_revision=1, bind_host="127.0.0.1")
    return host, settings_api.Resources(host)


def test_the_drain_stops_every_master_watch_and_the_close_joins_them():
    host, resources = _resources()
    watches = [_Watch(), _Watch("provider_futu")]
    resources._master_watches.extend(watches)
    host.stream_closers.append(resources.stop_master_watches)   # what bind() registers (asserted below)
    receipt = asyncio.run(host.drain(timeout_s=0.1))
    assert receipt["ok"] is True
    assert [w.stopped for w in watches] == [1, 1]
    assert [w.joined for w in watches] == [[], []], "the drain only sets flags: it runs on the event loop"
    assert resources._catalog_follow_stopped, "a watch still starting after the drain is stopped as it starts"
    asyncio.run(resources.close())
    assert [w.stopped for w in watches] == [1, 1], "the process's close does not stop them again"
    assert all(len(w.joined) == 1 for w in watches), "the close waits for every stopped watch"


def test_the_close_waits_for_the_start_check_and_reports_what_did_not_end(monkeypatch):
    _host, resources = _resources()
    failures = []
    monkeypatch.setattr(settings_api, "record_failure", lambda log, what, exc=None: failures.append(str(exc)))
    stuck = _Watch("provider_futu", ends=False)
    resources._stopped_watches.append(stuck)
    release = threading.Event()

    async def scenario():
        resources._follow_future = asyncio.get_running_loop().run_in_executor(None, release.wait, 5)
        return await resources.join_master_follow(0.2)

    try:
        still_running = asyncio.run(scenario())
    finally:
        release.set()
    assert still_running == ["product catalog start check", "provider_futu security-master watch"]
    assert failures and "provider_futu security-master watch" in failures[0]


def test_a_watch_started_after_the_stop_is_stopped_and_joined(monkeypatch):
    _host, resources = _resources()
    resources.stop_master_watches()
    late = _Watch()
    resources._master_watches.append(late)
    resources.stop_master_watches()       # what follow_security_masters does when it finds the follow stopped
    asyncio.run(resources.join_master_follow(0.1))
    assert late.stopped == 1 and len(late.joined) == 1


def test_bind_registers_the_watch_stop_as_a_stream_closer():
    source = inspect.getsource(settings_api.Resources.bind)
    assert "self.host.stream_closers.append(self.stop_master_watches)" in source
    start = inspect.getsource(settings_api.Resources.start)
    assert "self._follow_future = loop.run_in_executor(None, follow_security_masters)" in start
    assert "self.stop_master_watches()" in start.split("def follow_security_masters", 1)[1]
