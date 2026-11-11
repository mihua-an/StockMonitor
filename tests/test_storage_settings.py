"""設定 → 資料儲存: retention / location validation, defaults and the one historical root."""
from __future__ import annotations

from pathlib import Path

from config.config_revisions import ConfigRevisionStore
from config import storage_settings as ss


def test_defaults_keep_shioaji_three_trading_dates_and_futu_none():
    assert ss.DEFAULT_RETENTION["sources"] == {"shioaji": {"persist": True, "retention_days": 3},
                                               "futu": {"persist": False, "retention_days": None}}
    assert ss.validate_retention(ss.DEFAULT_RETENTION) == []


def test_retention_validation_is_strict():
    ok = {"sources": {"shioaji": {"persist": True, "retention_days": None}, "futu": {"persist": True, "retention_days": 20}}}
    assert ss.validate_retention(ok) == []
    codes = lambda values: {p["code"] for p in ss.validate_retention(values)}
    assert "PERSIST" in codes({"sources": {"shioaji": {"persist": "false", "retention_days": 3}, "futu": {"persist": False}}})
    assert "RETENTION_DAYS" in codes({"sources": {"shioaji": {"persist": True, "retention_days": 0}, "futu": {"persist": False}}})
    assert "RETENTION_DAYS" in codes({"sources": {"shioaji": {"persist": True, "retention_days": True}, "futu": {"persist": False}}})
    assert "UNKNOWN_SOURCE" in codes({"sources": {**ok["sources"], "ib": {"persist": True}}})
    assert "SOURCE" in codes({"sources": {"shioaji": ok["sources"]["shioaji"]}})


def test_location_must_be_absolute_on_an_existing_drive(tmp_path):
    assert ss.validate_location({"historical_root": None}) == []
    assert ss.validate_location({"historical_root": str(tmp_path / "hist")}) == []
    assert ss.validate_location({"historical_root": "relative\\dir"})[0]["code"] == "HISTORICAL_ROOT"
    assert ss.validate_location({"historical_root": "Q:\\nowhere"})[0]["code"] in {"HISTORICAL_ROOT_DRIVE", "HISTORICAL_ROOT"}


def test_location_refuses_a_folder_holding_other_files(tmp_path):
    # Health moves only what StockMonitor owns and never merges into another folder.
    folder = tmp_path / "Data"
    folder.mkdir()
    assert ss.validate_location({"historical_root": str(folder)}) == [], "an empty folder is fine"
    (folder / "photo.jpg").write_text("p")
    assert ss.validate_location({"historical_root": str(folder)})[0]["code"] == "HISTORICAL_ROOT_NOT_EMPTY"
    (folder / "photo.jpg").unlink()
    (folder / ss.MARKER).write_text("{}")
    (folder / "source=shioaji").mkdir()
    assert ss.validate_location({"historical_root": str(folder)}) == [], "an earlier StockMonitor store is recognised"


def test_the_last_apply_operation_is_reported(tmp_path):
    assert ss.location_apply_operation(tmp_path) is None
    (tmp_path / "storage_location").mkdir()
    (tmp_path / "storage_location" / "apply_operation.json").write_text(
        '{"operation_id": "x", "revision": 2, "state": "refused", "error": "the new folder is not empty"}', encoding="utf-8")
    assert ss.location_apply_operation(tmp_path)["state"] == "refused"
    # The settings page shows a running copy from the same record.
    (tmp_path / "storage_location" / "apply_operation.json").write_text(
        '{"revision": 2, "state": "copying", "progress": {"bytes_done": 1, "bytes_total": 2}, "synced_at": null}', encoding="utf-8")
    assert ss.location_apply_operation(tmp_path)["progress"] == {"bytes_done": 1, "bytes_total": 2}


def test_the_historical_root_is_the_active_location_only(tmp_path):
    config_root, data_root = tmp_path / "config", tmp_path / "data"
    assert ss.historical_root(config_root, data_root) == data_root / "historical"
    store = ConfigRevisionStore(config_root, "storage_location")
    store.save({"historical_root": str(tmp_path / "D")}, expected_revision=None, source="test", activate=False)
    # Saved, not active yet (Health activates it at the next full start, after moving the data).
    assert ss.historical_root(config_root, data_root) == data_root / "historical"
    store.save({"historical_root": str(tmp_path / "D")}, expected_revision=1, source="test", activate=True)
    assert ss.historical_root(config_root, data_root) == Path(tmp_path / "D")


def test_retention_falls_back_per_source(tmp_path):
    store = ConfigRevisionStore(tmp_path, "storage_retention")
    store.save({"sources": {"shioaji": {"persist": True, "retention_days": None}, "futu": {"persist": False, "retention_days": None}}},
               expected_revision=None, source="test", activate=True)
    assert ss.retention(tmp_path)["sources"]["shioaji"] == {"persist": True, "retention_days": None}
    assert ss.retention(tmp_path / "empty")["sources"]["shioaji"] == {"persist": True, "retention_days": 3}


def test_settings_api_seeds_and_serves_both_domains(tmp_path):
    from api.routes.config_routes import SaveRequest, create_config_router, seed_defaults

    seed_defaults(tmp_path)
    router = create_config_router(config_root=lambda: tmp_path)
    endpoint = {(route.path, method): route.endpoint for route in router.routes for method in route.methods}
    get, put = endpoint[("/api/config/{domain}", "GET")], endpoint[("/api/config/{domain}", "PUT")]
    retention = get("storage_retention")
    assert retention["active"]["values"]["sources"]["futu"] == {"persist": False, "retention_days": None}
    assert retention["effect"]["mode"] == "runtime_apply"
    location = get("storage_location")
    assert location["effect"]["mode"] == "full_restart_bootstrap" and location["activate_on_save"] is False
    bad = put("storage_retention", SaveRequest(expected_revision=1, values={"sources": {}}))
    assert bad.status_code == 422
    saved = put("storage_location", SaveRequest(expected_revision=1, values={"historical_root": str(tmp_path / "E")}))
    assert saved["ok"] and saved["activated"] is False
