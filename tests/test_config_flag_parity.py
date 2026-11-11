"""Config flag parsing: one contract in Python and Node (AGENTS.md sections 4 and 7).

Shared cases (tests/fixtures/config/flag_cases.json) pin the strict boolean rule in both languages; source selection
and feature switches are checked to use it -- "false" is never truthy because it is a
non-empty string, and a typo is an error rather than a silent default.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from config.flags import FlagError, parse_flag

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests" / "fixtures" / "config" / "flag_cases.json").read_text(encoding="utf-8"))


def _node(script: str, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30,
                            env={**os.environ, **(env or {})})
    assert result.returncode == 0, result.stderr
    return result.stdout


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["input"]))
def test_python_flag_cases(case):
    if case.get("error"):
        with pytest.raises(FlagError):
            parse_flag(case["input"], name="X", fallback=case["fallback"])
    else:
        assert parse_flag(case["input"], name="X", fallback=case["fallback"]) is case["expected"]


def test_node_agrees_with_python_on_every_case():
    out = _node("""
const { parseFlag } = require('./config/js/flags.js');
const cases = require('./tests/fixtures/config/flag_cases.json');
process.stdout.write(JSON.stringify(cases.map((c) => { try { return parseFlag(c.input, { name: 'X', fallback: c.fallback }); }
  catch (e) { return e.code === 'CONFIG_FLAG_INVALID' ? 'error' : String(e); } })));
""")
    node = json.loads(out)
    python = []
    for case in CASES:
        try:
            python.append(parse_flag(case["input"], name="X", fallback=case["fallback"]))
        except FlagError:
            python.append("error")
    assert node == python


def test_source_offline_flag_is_strict_in_both_languages(monkeypatch):
    from config.source_settings import load_source_settings

    assert load_source_settings({"STOCK_MONITOR_OFFLINE_UI": "true"})["offline_ui"] is True
    assert load_source_settings({"STOCK_MONITOR_OFFLINE_UI": "false"})["offline_ui"] is False
    with pytest.raises(FlagError):
        load_source_settings({"STOCK_MONITOR_OFFLINE_UI": "ture"})
    out = _node("""
const { loadSourceSettings } = require('./config/js/source_settings.js');
const r = [loadSourceSettings({ STOCK_MONITOR_OFFLINE_UI: 'true' }).offline_ui, loadSourceSettings({ STOCK_MONITOR_OFFLINE_UI: 'false' }).offline_ui];
try { loadSourceSettings({ STOCK_MONITOR_OFFLINE_UI: 'ture' }); r.push('accepted'); } catch (e) { r.push(e.code); }
process.stdout.write(JSON.stringify(r));
""")
    assert json.loads(out) == [True, False, "CONFIG_FLAG_INVALID"]


def test_feature_switch_json_must_be_a_real_boolean(tmp_path):
    from config.feature_settings import load_feature_settings

    file = tmp_path / "feature_settings.json"
    file.write_text(json.dumps({"shioaji": {"model_inference": "false"}}), encoding="utf-8")
    with pytest.raises(ValueError, match="JSON boolean"):
        load_feature_settings({}, file)
    file.write_text(json.dumps({"shioaji": {"model_inference": False}}), encoding="utf-8")
    settings = load_feature_settings({}, file)
    assert settings.model_inference is False and settings.source_of("model_inference") == "file"
    assert load_feature_settings({"STOCK_MONITOR_SHIOAJI_MODEL_INFERENCE": "on"}, file).model_inference is True
    with pytest.raises(FlagError):
        load_feature_settings({"STOCK_MONITOR_SHIOAJI_MODEL_INFERENCE": "enable"}, file)


def test_feature_status_keeps_intent_and_capability_apart(tmp_path):
    from config.feature_settings import load_feature_settings

    file = tmp_path / "feature_settings.json"
    file.write_text(json.dumps({"shioaji": {"model_inference": True, "model_training": False}}), encoding="utf-8")
    status = load_feature_settings({}, file).status({"model_inference": False})
    assert status["model_inference"] == {"desired": True, "source": "file", "capability": False, "effective": False,
                                         "reason": "not available"}
    assert status["model_training"]["desired"] is False and status["model_training"]["effective"] is False
    unreported = load_feature_settings({}, file).status()
    assert unreported["model_inference"]["capability"] is None and unreported["model_inference"]["effective"] is False
