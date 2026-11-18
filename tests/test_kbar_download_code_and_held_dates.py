"""K 線下載: the product code is checked as the K-bar store names its files before any path is built, and what the
store holds is read by 技術分析's own reader (an unreadable file is recorded and holds nothing, never a 500)."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.shioaji.routes.history_routes import HistoryRouteDependencies, create_history_router
from service.market.shioaji import history_download
from service.market.shioaji.history_download import KBarDownloadManager
from service.platform.http.errors import register_error_handlers
from tests.support.kbar_download_fakes import FakeAPI, FakeRepository

QUOTA = {"bytes": 0, "limit_bytes": 10**9, "remaining_bytes": 10**9}
BAD_CODES = ["..\\..\\secrets", "../x", "A B", "X" * 40, ""]


def manager_on(tmp_path):
    repository = FakeRepository(tmp_path, FakeAPI([QUOTA]))
    clock = lambda: datetime(2026, 11, 8, 2, 0, tzinfo=timezone.utc)  # noqa: E731
    return KBarDownloadManager(lambda: repository.api, repository, db_path=tmp_path / "meta.sqlite",
                               kbar_root=lambda: tmp_path / "kbars", import_runner=lambda root, payload: {"ok": True},
                               clock=clock)


@pytest.mark.parametrize("code", BAD_CODES)
def test_a_code_the_store_cannot_name_is_refused_before_any_path(tmp_path, code):
    manager = manager_on(tmp_path)
    for call in (lambda: manager.preview(code, "2026-11-02", "2026-11-06"),
                 lambda: manager.request_older(code, "2026-11-06"),
                 lambda: manager.older_status(code)):
        with pytest.raises(ValueError, match="invalid product code"):
            call()


def test_a_held_date_is_read_by_the_charts_reader(tmp_path, monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    path = tmp_path / "kbars" / "source=shioaji" / "market=STK" / "2330.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"sessions": {"DAY": {"daily": {"2026-11-03": [1, 2, 0, 1, 5]},
                                                      "intraday": {"2026-11-04": {"timeframe": 1, "bars": []}}}}}),
                    encoding="utf-8")
    plan = manager_on(tmp_path).preview(" 2330 ", "2026-11-02", "2026-11-06")
    assert plan["code"] == "2330"
    assert plan["missing_dates"] == ["2026-11-02", "2026-11-05", "2026-11-06"]


def test_an_unreadable_store_file_is_recorded_and_holds_nothing(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    path = tmp_path / "kbars" / "source=shioaji" / "market=STK" / "2330.json"
    path.parent.mkdir(parents=True)
    path.write_text("{not json", encoding="utf-8")
    manager = manager_on(tmp_path)
    with caplog.at_level(logging.WARNING):
        plan = manager.preview("2330", "2026-11-02", "2026-11-03")
    assert plan["missing_dates"] == ["2026-11-02", "2026-11-03"]
    assert any("2330.json" in record.getMessage() for record in caplog.records), "the bad file is recorded"


def test_the_daemon_answers_a_refused_code_with_400(tmp_path):
    manager = manager_on(tmp_path)
    deps = HistoryRouteDependencies(app_provider=lambda: SimpleNamespace(kbar_download_manager=manager),
                                    data_center_service_provider=lambda: None,
                                    route_key=lambda *a, **k: "", await_route_work=lambda *a, **k: None)
    app = FastAPI()
    register_error_handlers(app)
    app.include_router(create_history_router(deps))
    client = TestClient(app)
    body = {"code": "..\\..\\x", "start_date": "2026-11-02", "end_date": "2026-11-06"}
    assert client.post("/v1/history/kbars/preview", json=body).status_code == 400
    assert client.post("/v1/history/kbars/jobs", json=body).status_code == 400
    assert client.post("/v1/history/kbars/older", json={"code": "../x", "before": "2026-11-06"}).status_code == 400
    assert client.get("/v1/history/kbars/older", params={"code": "../x"}).status_code == 400


def test_app_api_answers_a_refused_code_with_400_before_calling_the_daemon():
    """The daemon's 400 reaches app_api only as a failed provider call (a 500); app_api checks the code itself, with
    the same valid_code, so 資料中心 gets the caller's 400 and the daemon is never asked."""
    from api.routes.history_routes import DataCenterRouteDependencies, create_data_center_router

    calls = []
    daemon = SimpleNamespace(preview_kbar_download=lambda body: calls.append(("preview", body)) or {"ok": True},
                             create_kbar_download_job=lambda body: calls.append(("job", body)) or {"ok": True})
    app = FastAPI()
    register_error_handlers(app)
    app.include_router(create_data_center_router(DataCenterRouteDependencies(runtime=SimpleNamespace(app=daemon),
                                                                             data_center=None)))
    client = TestClient(app)
    for path in ("/api/data-center/kbars/preview", "/api/data-center/kbars/jobs"):
        for code in ("../X", "A B", "X" * 40, ""):
            assert client.post(path, json={"code": code, "start_date": "2026-11-02"}).status_code == 400, (path, code)
    assert calls == []
    assert client.post("/api/data-center/kbars/preview", json={"code": " 2330 ", "start_date": "2026-11-02"}).status_code == 200
    assert calls == [("preview", {"code": "2330", "start_date": "2026-11-02"})]
