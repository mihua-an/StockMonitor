"""Two business API processes, seven parts (docs/system-architecture/00 sections 1-4, 08 section 2).

Each part, mounted alone, exposes identity/metrics/drain under the service-management credential only, serves its own
routes and none of another part's, and settings_api keeps versioned configuration with conflict detection. The parts
have no app factory of their own: the tests mount one through the same composite host the two
processes use.
"""
from __future__ import annotations

import importlib

import pytest
from tests.asgi_client import AsgiClient as AppClient

CLIENT = "client-token-0000000000000000000000000000"

OWN = {
    "quote_api": ["/api/monitor/events?date=2026-10-08", "/api/security-master/search?q=23", "/api/status"],
    "history_api": ["/api/replay/status"],
    "model_api": ["/api/model/options", "/api/system/inference"],
    "data_center_api": ["/api/data-center/closing"],
    "actual_account_api": ["/api/diagnostics/account-sqlite"],
    "paper_account_api": ["/api/paper-wallet/status"],
    "settings_api": ["/api/config/network", "/api/config/flow_rules", "/api/watch-pages"],
}
FOREIGN = {
    "quote_api": "/api/paper-wallet/status", "history_api": "/api/model/options", "model_api": "/api/history/dates",
    "data_center_api": "/api/actual-account/status", "actual_account_api": "/api/config/network",
    "paper_account_api": "/api/actual-account/status", "settings_api": "/api/status",
}


@pytest.fixture()
def isolated_roots(tmp_path, monkeypatch):
    monkeypatch.setenv("STOCK_MONITOR_AUTH_ROOT", str(tmp_path / "auth"))
    monkeypatch.setenv("STOCK_MONITOR_CONFIG_ROOT", str(tmp_path / "config"))
    monkeypatch.setenv("STOCK_MONITOR_PRODUCER_ENDPOINT_FILE", str(tmp_path / "auth" / "producer.json"))
    import service.market.projection.analysis_event_archive as event_archive
    monkeypatch.setattr(event_archive, "default_root", lambda: tmp_path / "analysis" / "events")
    import service.platform.project_root as project_root
    monkeypatch.setattr(project_root, "CONFIG_ROOT", tmp_path / "config", raising=False)
    monkeypatch.setattr(project_root, "_AUTH_ROOT", tmp_path / "auth", raising=False)
    return tmp_path


def management_headers():
    from api.service_host import management_token

    return {"Authorization": f"Bearer {management_token()}"}


def _single_part_app(service_id, **kwargs):
    from api.service_host import create_composite_app

    module = importlib.import_module(f"api.services.{service_id}")
    return create_composite_app(service_id, ((service_id, module.Resources),), **kwargs)


@pytest.mark.parametrize("service_id", sorted(OWN))
def test_each_part_mounted_alone_serves_only_its_routes_with_management_endpoints(service_id, isolated_roots):
    app = _single_part_app(service_id, port=1, config_revision=7, client_token=CLIENT)
    with AppClient(app) as client:
        assert client.get("/api/service/identity").status_code == 401, "management needs Health's credential"
        assert client.get("/api/service/identity", headers={"Authorization": f"Bearer {CLIENT}"}).status_code == 401, \
            "the renderer's client token is not a management credential"
        identity = client.get("/api/service/identity", headers=management_headers()).json()
        assert (identity["service_id"], identity["config_revision"], identity["protocol"]) == (service_id, 7, "stock-monitor-service-v1")
        auth = {"Authorization": f"Bearer {CLIENT}"}
        for path in OWN[service_id]:
            response = client.get(path, headers=auth)
            assert response.status_code != 404, f"{service_id} must serve {path}"
            assert response.status_code != 401
        assert client.get(FOREIGN[service_id], headers=auth).status_code == 404, f"{service_id} must not serve {FOREIGN[service_id]}"
        metrics = client.get("/api/service/metrics", headers=management_headers()).json()
        names = {m["name"] for m in metrics["metrics"]}
        assert {"http.inflight", "http.requests_total"} <= names
        assert all(m["value"] is not None or m["availability"] != "OK" for m in metrics["metrics"]), "missing is never zero"
        drained = client.post("/api/service/drain", headers=management_headers()).json()
        assert drained["draining"] is True
        assert client.get(OWN[service_id][0], headers=auth).status_code == 503, "draining refuses new business requests"


def test_settings_api_saves_revisions_with_conflicts_and_previews_network_impact(isolated_roots):
    from api.services import app_api

    with AppClient(app_api.build_app(port=1, client_token=CLIENT)) as client:
        auth = {"Authorization": f"Bearer {CLIENT}"}
        flow = client.get("/api/config/flow_rules", headers=auth).json()
        assert flow["active"]["source"] == "defaults", "the defaults become revision 1"
        bad = client.post("/api/config/network/validate", headers=auth, json={"values": {"services": {"realtime_api": {"port": 8007}}}}).json()
        assert bad["ok"] is False and bad["problems"][0]["code"] == "PORT_RESERVED"
        preview = client.post("/api/config/network/validate", headers=auth,
                              json={"values": {"services": {"market_runtime": {"port": 18010}}}}).json()
        assert preview["ok"] is True
        assert preview["impact"]["changed_services"] == ["market_runtime"]
        assert "realtime_api" in preview["impact"]["dependent_services"]
        assert preview["impact"]["renderer_reconnect"] is True
        self_change = client.post("/api/config/network/validate", headers=auth, json={"values": {"services": {"app_api": {"port": 18006}}}}).json()
        assert self_change["impact"]["effect_mode"] == "full_restart_bootstrap"
        saved = client.put("/api/config/network", headers=auth, json={"expected_revision": None, "values": {"services": {"realtime_api": {"port": 18000}}}}).json()
        assert saved["ok"] and saved["activated"] is False, "saving a network revision never applies it"
        state = client.get("/api/config/network", headers=auth).json()
        assert state["pending_apply"] is True
        assert state["active_effective"]["services"]["realtime_api"]["port"] == 8000
        assert state["saved_effective"]["services"]["realtime_api"]["port"] == 18000
        conflict = client.put("/api/config/network", headers=auth, json={"expected_revision": None, "values": {"services": {}}}).json()
        assert conflict["error"] == "REVISION_CONFLICT" and conflict["current"]["revision"] == 1
        # The background list and the 訂閱偏好 are read here but written only by their owners (background_demand.py,
        # POST /api/subscriptions/ops): a whole-list write is refused.
        latest = (client.get("/api/config/background", headers=auth).json().get("latest") or {}).get("revision")
        background = client.put("/api/config/background", headers=auth, json={"expected_revision": latest, "values": {"items": [
            {"source": "shioaji", "market": "STK", "code": "2330"}]}})
        assert background.status_code == 405 and background.json()["error"] == "OWNER_WRITTEN"
        assert client.get("/api/config/subscriptions", headers=auth).json()["ok"]
        assert client.put("/api/config/subscriptions", headers=auth, json={"expected_revision": None, "values": {}}).status_code == 405
        rejected = client.put("/api/config/flow_rules", headers=auth, json={"expected_revision": 1, "values": {"rules": [{"rule_id": "x", "threshold_type": "volume", "threshold": -1}]}}).json()
        assert rejected["error"] == "REVISION_REJECTED"


def test_drain_reports_active_requests_and_never_closes_resources_under_them():
    # The identity's ok: True was merged last and overwrote a failed drain, and the
    # resources were prepared for shutdown while requests were still running.
    import asyncio
    from api.service_host import ServiceHost

    class Resources:
        prepared = 0

        def prepare_shutdown(self):
            Resources.prepared += 1
            return {"closed": True}

    host = ServiceHost("quote_api", port=None, config_revision=None)
    host.resources = Resources()
    host.requests.begin("x")  # one request still running
    busy = asyncio.run(host.drain(timeout_s=0.05))
    assert busy["ok"] is False and busy["inflight"] == 1 and busy["forced"] is False
    assert host.requests.open_groups() == {"x": 1}, "a drain that runs out its time names what it waited on"
    assert set(busy["timings_ms"]) == {"close_streams_ms", "wait_inflight_ms", "shutdown_resources_ms"}
    assert Resources.prepared == 0, "nothing is closed under an active request"
    forced = asyncio.run(host.drain(timeout_s=0.05, force=True))
    assert forced["ok"] is False and forced["forced"] is True and Resources.prepared == 1, "stop forces it, and says so"
    host.requests.end("x", 200, 1.0)
    idle = asyncio.run(host.drain(timeout_s=0.05))
    assert idle["ok"] is True and idle["forced"] is False and Resources.prepared == 1, "the shutdown runs once (R08-23)"
    asyncio.run(host.shutdown_resources())     # the lifespan's end
    assert Resources.prepared == 1


def test_a_composite_that_fails_to_start_closes_the_parts_it_started_in_reverse():
    # A part failing to start left the earlier parts running; now they -- and only they -- close, in reverse.
    import asyncio
    from api.service_host import CompositeResources, ServiceHost

    log = []

    def part(name, fail=False):
        class Part:
            def bind(self, app): pass

            async def start(self):
                if fail:
                    raise RuntimeError(f"{name} cannot start")
                log.append(f"start:{name}")

            async def close(self):
                log.append(f"close:{name}")

            def prepare_shutdown(self):
                log.append(f"prepare:{name}")
                return {}
        return lambda host: Part()

    host = ServiceHost("app_api", port=None, config_revision=None)
    composite = CompositeResources(host, (("a", part("a")), ("b", part("b")), ("c", part("c", fail=True)), ("d", part("d"))))
    host.resources = composite
    with pytest.raises(RuntimeError, match="c cannot start"):
        asyncio.run(composite.start())
    asyncio.run(host.shutdown_resources())
    asyncio.run(composite.close())
    assert log == ["start:a", "start:b", "prepare:b", "prepare:a", "close:b", "close:a"]


def test_a_failed_shutdown_is_terminal_every_part_is_prepared_and_closed():
    # A prepare that raised was run again by the next path and skipped the lifespan's close; one failing part
    # skipped the parts after it.
    import asyncio
    from api.service_host import CompositeResources, ServiceHost

    log = []

    def part(name, fail=False):
        class Part:
            def bind(self, app): pass

            async def start(self):
                log.append(f"start:{name}")

            async def close(self):
                log.append(f"close:{name}")

            def prepare_shutdown(self):
                log.append(f"prepare:{name}")
                if fail:
                    raise RuntimeError(f"{name} cannot flush")
                return {"ok": True}
        return lambda host: Part()

    host = ServiceHost("app_api", port=None, config_revision=None)
    composite = CompositeResources(host, (("a", part("a")), ("b", part("b", fail=True)), ("c", part("c"))))
    host.resources = composite
    asyncio.run(composite.start())
    first = asyncio.run(host.shutdown_resources())
    assert first["b"]["ok"] is False and "cannot flush" in first["b"]["error"]
    assert first["a"] == {"ok": True} and first["c"] == {"ok": True}, "the others are still prepared"
    assert asyncio.run(host.shutdown_resources()) is first, "terminal: never run again"
    assert log.count("prepare:b") == 1

    class Broken:
        def prepare_shutdown(self):
            raise RuntimeError("boom")

    lone = ServiceHost("realtime_api", port=None, config_revision=None)
    lone.resources = Broken()
    receipt = asyncio.run(lone.shutdown_resources())
    assert receipt["ok"] is False and asyncio.run(lone.shutdown_resources()) is receipt


# -- two API processes ------------------------------------------------------------------------------

PROCESS_PARTS = {"realtime_api": ("quote_api", "model_api"),
                 "app_api": ("settings_api", "history_api", "data_center_api", "actual_account_api", "paper_account_api")}


@pytest.mark.parametrize("process_id", sorted(PROCESS_PARTS))
def test_each_process_serves_exactly_its_parts(process_id, isolated_roots):
    module = importlib.import_module(f"api.services.{process_id}")
    app = module.build_app(port=1, config_revision=3, client_token=CLIENT)
    auth = {"Authorization": f"Bearer {CLIENT}"}
    with AppClient(app) as client:
        identity = client.get("/api/service/identity", headers=management_headers()).json()
        assert identity["service_id"] == process_id
        for part in PROCESS_PARTS[process_id]:
            for path in OWN[part]:
                assert client.get(path, headers=auth).status_code not in (401, 404), f"{process_id} must serve {part}'s {path}"
        for other, parts in PROCESS_PARTS.items():
            if other == process_id:
                continue
            for part in parts:
                assert client.get(OWN[part][0], headers=auth).status_code == 404, f"{process_id} must not serve {part}"
        resources = app.state.resources
        assert [name for name, _ in resources.parts] == list(PROCESS_PARTS[process_id])
        shared = {id(part.components) for _, part in resources.parts}
        assert len(shared) == 1, "the parts of one process share one set of components"
        receipt = client.post("/api/service/drain", headers=management_headers()).json()["receipt"]
        assert set(receipt) == set(PROCESS_PARTS[process_id]), "every part reports its own shutdown receipt"


def test_manifest_api_parts_match_the_process_modules():
    from config.network_config import load_manifest, services

    table = services(load_manifest())
    for process_id, parts in PROCESS_PARTS.items():
        module = importlib.import_module(f"api.services.{process_id}")
        assert tuple(name for name, _ in module.PARTS) == parts
        assert tuple(table[process_id]["parts"]) == parts
        assert table[process_id]["entry"] == f"api.services.{process_id}"


def test_history_trade_list_reads_the_shared_account_ledger_in_app_api(isolated_roots):
    # It was NotHere("actual_account_api") after the service split: the replay page's 交易明細 always failed.
    from api.services import app_api

    with AppClient(app_api.build_app(port=1, client_token=CLIENT)) as client:
        response = client.get("/api/history/daytrades?scope=today&date=2026-09-29", headers={"Authorization": f"Bearer {CLIENT}"})
        body = response.json()
        assert response.status_code == 200, body
        assert "WRONG_SERVICE" not in str(body) and "belongs to actual_account_api" not in str(body), body


def test_a_futu_daemon_that_does_not_answer_is_a_state_not_a_500(isolated_roots, monkeypatch):
    from api.components import Components
    from service.market.shioaji.daemon_errors import MarketDaemonError

    class _Down:
        def request(self, *a, **k):
            raise MarketDaemonError("HTTPConnectionPool(host='127.0.0.1', port=8101): connect timeout")

    components = Components("t")
    components._built["provider_futu"] = _Down()
    reply = components.futu_proxy()("GET", "/v1/futu/status")
    assert reply["ok"] is False and reply["classification"] == "PROVIDER_UNAVAILABLE"


def test_daemon_launchers_stop_their_dataflow_logger_with_the_server():
    # The interval logger's thread ended only with the interpreter.
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    text = (root / "backend/shared/provider_main.py").read_text(encoding="utf-8")
    finally_block = text[text.rindex("    finally:"):]
    assert "dataflow_logger.stop()" in finally_block
