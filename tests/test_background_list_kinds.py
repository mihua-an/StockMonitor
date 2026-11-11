"""The background list's kinds validate the same in Python and in market_runtime (native/market_runtime/src/demand.rs):
absent means every kind; a given list names at least one known kind, none twice. Nothing is rewritten to fit."""
from __future__ import annotations

from config import background_list


def _codes(items, monkeypatch):
    monkeypatch.setattr("config.source_settings.source_enabled", lambda source: True)
    return [p["code"] for p in background_list.validate_background({"items": items})]


def _item(**extra):
    return {"source": "shioaji", "market": "STK", "code": "2330", **extra}


def test_absent_kinds_mean_every_kind(monkeypatch):
    assert _codes([_item()], monkeypatch) == []


def test_given_kinds_are_checked_not_replaced(monkeypatch):
    assert _codes([_item(kinds=[])], monkeypatch) == ["EMPTY_KINDS"]
    assert _codes([_item(kinds=None)], monkeypatch) == ["EMPTY_KINDS"]
    assert _codes([_item(kinds=["tick"])], monkeypatch) == ["UNKNOWN_KIND"]
    assert _codes([_item(kinds=["quote", "quote"])], monkeypatch) == ["REPEATED_KIND"]
    assert _codes([_item(kinds=["quote", "trade"])], monkeypatch) == []
