"""資料中心 K 線下載 / 系統拓樸 歷史資料額度 answered 503 from app_api on every call (10-14): the view handed the eight
K-bar endpoints through to its client, and app_api's client (ProviderHttpClient) had none of them. They are now the
view's own, written over get_json / post_json, which every client has."""
from typing import Any

import pytest

from service.market.shioaji.daemon_client import ShioajiDaemonClientView
from service.market.shioaji.daemon_errors import MarketDaemonError


class _HttpOnlyClient:
    """Like api/provider_http_client.ProviderHttpClient: get_json / post_json and nothing else."""

    def __init__(self, fail: bool = False) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.fail = fail

    def get_json(self, path: str, *, params: dict[str, Any] | None = None, timeout: float = 3.0) -> dict[str, Any]:
        if self.fail:
            raise MarketDaemonError("provider down")
        self.calls.append(("GET", path, params))
        return {"ok": True, "path": path}

    def post_json(self, path: str, body: dict[str, Any] | None = None, *, params: dict[str, Any] | None = None,
                  timeout: float = 8.0) -> dict[str, Any]:
        self.calls.append(("POST", path, body))
        return {"ok": True, "path": path}


@pytest.fixture
def view(monkeypatch, tmp_path):
    # The view builds its local readers on construction; none of them is exercised here.
    from service.market.shioaji import daemon_client
    monkeypatch.setattr(daemon_client, "ShioajiHistoricalRepository", lambda *a, **k: object())
    return lambda client: ShioajiDaemonClientView(client)


def test_every_kbar_endpoint_works_over_a_client_with_only_get_and_post(view):
    client = _HttpOnlyClient()
    app = view(client)
    for name in ("preview_kbar_download", "create_kbar_download_job", "list_kbar_download_jobs",
                 "get_kbar_download_job", "action_kbar_download_job", "request_older_kbars", "older_kbars_status"):
        assert hasattr(app, name), f"history_routes checks hasattr(app, {name!r}) and answers 503 without it"
    assert app.preview_kbar_download({"code": "2330"})["path"] == "/v1/history/kbars/preview"
    assert app.action_kbar_download_job("j1", "cancel")["path"] == "/v1/history/kbars/jobs/j1/action"
    assert ("POST", "/v1/history/kbars/jobs/j1/action", {"action": "cancel"}) in client.calls


def test_an_unreachable_provider_is_a_daemon_error_the_route_answers(view):
    with pytest.raises(MarketDaemonError):
        view(_HttpOnlyClient(fail=True)).list_kbar_download_jobs()
