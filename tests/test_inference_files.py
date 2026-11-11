"""The files between model_api and Rust B keep their contract: a config value JSON cannot hold is refused, not written
as its str(); a status file that is not B's document is unavailable with its reason, never "no status" or fresh."""
from __future__ import annotations

import json
from decimal import Decimal

import pytest

from service.analysis.inference_files import STATUS_SCHEMA, read_status, write_config


def test_a_config_value_json_cannot_hold_is_refused(tmp_path):
    with pytest.raises(TypeError):
        write_config({"limit": Decimal("1.5")}, tmp_path)
    with pytest.raises(ValueError):
        write_config({"limit": float("nan")}, tmp_path)
    assert not (tmp_path / "config.json").exists()
    assert write_config({"limit": 1.5}, tmp_path) is True
    assert write_config({"limit": 1.5}, tmp_path) is False, "unchanged content is not rewritten"


def test_status_states(tmp_path):
    assert read_status(tmp_path) is None, "B never wrote one"
    path = tmp_path / "status.json"
    path.write_text(json.dumps({"schema": STATUS_SCHEMA, "capability": {"3m_up": True}}), encoding="utf-8")
    status = read_status(tmp_path)
    assert status["available"] is True and status["stale"] is False and status["capability"] == {"3m_up": True}
    for broken in ("[1, 2]", json.dumps({"capability": {}}), "{not json"):
        path.write_text(broken, encoding="utf-8")
        status = read_status(tmp_path)
        assert status["available"] is False and status["stale"] is True and status["unavailable_reason"], broken
        assert "capability" not in status
