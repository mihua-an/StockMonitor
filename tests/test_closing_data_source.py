"""The closing-data source connects only to an address the user set."""
from __future__ import annotations

import json
import urllib.request

from config import closing_data_settings as settings
from service.market.shioaji import closing_state_source as source


def test_no_address_connects_nowhere(monkeypatch):
    monkeypatch.setattr(settings, "url", lambda *a, **k: "")
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not connect")))
    assert source.fetch("2330", "2026-11-09") is None


def test_the_repository_names_no_address():
    assert settings.DEFAULTS["url"] == ""
    assert not hasattr(source, "_URL")


def test_the_set_address_is_asked_with_the_code(monkeypatch):
    seen = {}

    class Answer:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps({"msgArray": [{"c": "2330", "d": "20261109", "y": "100"}]}).encode()

    def opened(request, **_):
        seen["url"], seen["referer"] = request.full_url, request.get_header("Referer")
        return Answer()

    monkeypatch.setattr(settings, "url", lambda *a, **k: "https://example.test/q?c={code}")
    monkeypatch.setattr(urllib.request, "urlopen", opened)
    state = source.fetch("2330", "2026-11-09")
    assert seen == {"url": "https://example.test/q?c=2330", "referer": "https://example.test/"}
    assert state.prev_close == 100


def test_an_address_must_be_a_web_address_with_the_code():
    assert settings.validate({"url": ""}) == []
    assert settings.validate({"url": "https://example.test/q?c={code}"}) == []
    assert [p["code"] for p in settings.validate({"url": "https://example.test/q"})] == ["URL"]
    assert [p["code"] for p in settings.validate({"url": "file:///c:/x{code}"})] == ["URL"]
