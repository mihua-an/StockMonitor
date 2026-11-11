"""The JSON boundary converts the types it knows and refuses any other, naming the type and where it is, instead of
sending str(value): a repr can carry paths or secrets, and it hides a schema error behind data that looks valid."""
from __future__ import annotations

import enum
import logging
import math
from datetime import date, time
from decimal import Decimal
from uuid import UUID

import pytest

from service.platform.json_safety import JsonSerializationError, strict_json_dumps, to_json_safe


class Side(enum.Enum):
    BUY = "B"


class Secretive:
    def __str__(self):
        return "C:/Users/someone/token=abc"


def test_known_types_convert():
    assert to_json_safe({"d": Decimal("1.50"), "n": Decimal("NaN"), "s": Side.BUY, "t": time(9, 0), "day": date(2026, 10, 21),
                         "u": UUID(int=1), "f": math.inf, "x": [1, (2, 3)]}) == {
        "d": "1.50", "n": None, "s": "B", "t": "09:00:00", "day": "2026-10-21",
        "u": "00000000-0000-0000-0000-000000000001", "f": None, "x": [1, [2, 3]]}


def test_an_unknown_type_is_refused_with_its_place_and_logged(caplog):
    with caplog.at_level(logging.ERROR, logger="service.platform.json_safety"):
        with pytest.raises(JsonSerializationError) as caught:
            strict_json_dumps({"rows": [{"ok": 1}, {"value": Secretive()}]})
    assert caught.value.where == "$.rows[1].value"
    assert "Secretive" in str(caught.value) and "token" not in str(caught.value)
    assert any("$.rows[1].value" in r.getMessage() for r in caught_records(caplog))


def caught_records(caplog):
    return [r for r in caplog.records if r.name == "service.platform.json_safety"]


def test_an_object_whose_str_raises_is_refused_not_crashing_differently():
    class Broken:
        def __str__(self):
            raise RuntimeError("boom")
    with pytest.raises(JsonSerializationError):
        to_json_safe([Broken()])
