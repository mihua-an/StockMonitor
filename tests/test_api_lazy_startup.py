"""An API process listens before it builds its services (Python start cost).

Building every part's services in bind and loading pandas at import made each API take 2-3 s alone (6-8 s in a cold
start). Now: importing the two services never loads pandas, binding builds nothing, and a component is built on its
first use (or by the background warm-up once the process answers).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_importing_both_api_services_does_not_load_pandas():
    code = "import sys, api.services.app_api, api.services.realtime_api; print('pandas' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "False", "a module on the API import path imports pandas at module scope again"


def test_binding_builds_nothing_and_first_use_builds_once():
    from fastapi import FastAPI

    from api.components import Components, Deferred
    from api.service_host import ServiceHost
    from api.services import app_api

    host = ServiceHost("app_api", port=0, config_revision=None)
    app = FastAPI()
    for _name, factory in app_api.PARTS:
        part = factory(host)
        part.bind(app)
    components: Components = host.components
    assert set(components.built()) <= {"gas_bridge"}, components.built()

    calls = []
    deferred = Deferred("probe", lambda: calls.append(1) or {"value": 7})
    assert not deferred.is_built
    assert deferred.get("value") == 7 and deferred.get("value") == 7
    assert calls == [1] and deferred.is_built


def test_a_failed_build_is_a_state_retried_after_a_backoff(monkeypatch):
    # A failed build is recorded and kept as the component's state; uses before the next try is due
    # answer it at once instead of rebuilding on every request.
    import api.components as components_module
    from api.components import ComponentUnavailable, Components, Deferred

    clock = [1000.0]
    monkeypatch.setattr(components_module.time, "monotonic", lambda: clock[0])

    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("provider not up yet")
        return "ok"

    components = Components("test_api")
    deferred = components.lazy("flaky", flaky)
    try:
        deferred.resolve()
    except RuntimeError:
        pass
    assert components.failed() == ["flaky"]
    assert components.states()["flaky"]["error"].startswith("RuntimeError: provider not up yet")
    try:
        deferred.resolve()
        raise AssertionError("a use before the retry is due must not build")
    except ComponentUnavailable:
        pass
    assert len(attempts) == 1
    clock[0] += 1.5
    assert deferred.resolve() == "ok" and len(attempts) == 2
    assert components.states()["flaky"]["state"] == "READY" and components.failed() == []
    assert isinstance(Deferred("x", lambda: 1).status(), dict)


def test_shutdown_ends_a_build_recovery_that_never_succeeded(monkeypatch):
    # A component whose build kept failing left its recovery open forever once the API stopped.
    import service.platform.remediation as remediation
    from api.components import Components

    finished = []

    class FakeRecovery:
        def __init__(self, **_kwargs):
            self.open = False

        def failed(self, *_args, **_kwargs):
            self.open = True

        def finish(self, outcome, **kwargs):
            finished.append((outcome, kwargs.get("detail", {}).get("component")))
            self.open = False
            return True

    monkeypatch.setattr(remediation, "Recovery", FakeRecovery)
    components = Components("test_api")
    broken = components.lazy("broken", lambda: (_ for _ in ()).throw(RuntimeError("never builds")))
    fine = components.lazy("fine", lambda: "ok")
    try:
        broken.resolve()
    except RuntimeError:
        pass
    assert fine.resolve() == "ok"
    components.shutdown()
    assert finished == [("abandoned", "broken")]


def test_the_warm_up_builds_only_what_a_windows_start_reads():
    """Codex 1022-ST-07: the warm-up built every deferred component two seconds after the API answered -- the history
    replay, the data center, credentials -- beside the window's first reads in the same Python process. It builds the
    startup set; a page's own component waits for that page's first request."""
    from api.components import STARTUP_COMPONENTS, Components

    components = Components("app_api")
    built = []
    for name in ("product_catalog", "paper_orders", "history_replay", "data_center", "credentials"):
        components.lazy(name, lambda name=name: built.append(name) or object())
    components.warm().join(10)
    assert sorted(built) == ["paper_orders", "product_catalog"]
    assert {"history_replay", "data_center", "credentials", "shioaji_provider"}.isdisjoint(STARTUP_COMPONENTS)
    components.lazy("history_replay").resolve()
    assert "history_replay" in built, "built on its first use"
