"""The flow/event rule validators never crash on a malformed element and refuse values Rust B cannot use."""
from __future__ import annotations

import pytest

from api.routes.config_routes import seed_defaults, validate_event_rules, validate_flow_rules
from config.config_revisions import ConfigRevisionStore


def codes(problems):
    return {p["code"] for p in problems}


def test_seeded_defaults_are_valid(tmp_path):
    seed_defaults(tmp_path)
    for domain, validate in (("flow_rules", validate_flow_rules), ("event_rules", validate_event_rules)):
        values = ConfigRevisionStore(tmp_path, domain).latest()["values"]
        assert validate(values) == [], domain


@pytest.mark.parametrize("validate", [validate_flow_rules, validate_event_rules])
def test_non_object_elements_are_problems_not_crashes(validate):
    assert "INVALID_RULE" in codes(validate({"rules": ["x", 3, None]}))


@pytest.mark.parametrize("rule, code", [
    ({"type": "window_move", "window": 1, "threshold_pct": -1}, "THRESHOLD_PCT"),
    ({"type": "window_move", "window": 1, "threshold_pct": "1.5"}, "THRESHOLD_PCT"),
    ({"type": "window_move", "window": True, "threshold_pct": 1.0}, "WINDOW_MOVE"),
    ({"type": "opening_move"}, "THRESHOLD_PCT"),
    ({"type": "window_move", "window": 1, "threshold_pct": 1.0, "reset_ratio": 2}, "RESET_RATIO"),
    # 爆量 (volume_spike) was removed 10-14: its volume is 量比 on the price events; the type is refused.
    ({"type": "volume_spike", "ratio": 3.0}, "TYPE"),
    ({"type": "window_move", "window": 1, "threshold_pct": 1.0, "direction": "sideways"}, "DIRECTION"),
    ({"type": "window_move", "window": 1, "threshold_pct": 1.0, "exclude_minutes": [[900, 800]]}, "EXCLUDE_MINUTES"),
    # The marker rank is the rule's own (Rust B rules.rs EventRule::priority): never a default, never a string.
    ({"type": "window_move", "window": 1, "threshold_pct": 1.0}, "PRIORITY"),
    ({"type": "window_move", "window": 1, "threshold_pct": 1.0, "priority": "400"}, "PRIORITY"),
    ({"type": "window_move", "window": 1, "threshold_pct": 1.0, "priority": True}, "PRIORITY"),
])
def test_event_values_rust_b_cannot_use_are_refused(rule, code):
    assert code in codes(validate_event_rules({"rules": [{"rule_id": "r", **rule}]}))


@pytest.mark.parametrize("threshold", [-1, 0, True, "5", float("nan"), float("inf")])
def test_flow_threshold_must_be_a_real_positive_number(threshold):
    rule = {"rule_id": "r", "threshold_type": "volume", "threshold": threshold}
    assert "THRESHOLD" in codes(validate_flow_rules({"rules": [rule]}))


def test_every_field_rust_b_reads_is_checked_with_its_type():
    """unit_size, multiplier, unit, currency, match members and an event's label/window/reset_ratio -- one of
    another type made Rust B unable to read the whole revision."""
    from api.routes.config_routes import validate_event_rules, validate_flow_rules

    flow = {"rule_id": "f", "threshold_type": "amount", "threshold": 1, "currency": "TWD", "unit_size": 1000}
    assert validate_flow_rules({"rules": [flow]}) == []
    codes = lambda problems: sorted(p["code"] for p in problems)
    assert codes(validate_flow_rules({"rules": [{**flow, "unit_size": 0}]})) == ["FIELD_TYPE"]
    assert codes(validate_flow_rules({"rules": [{**flow, "multiplier": "2"}]})) == ["FIELD_TYPE"]
    assert codes(validate_flow_rules({"rules": [{**flow, "unit": 5}]})) == ["FIELD_TYPE"]
    assert codes(validate_flow_rules({"rules": [{**flow, "match": {"code": 2330}}]})) == ["MATCH_FIELD"]
    assert codes(validate_flow_rules({"rules": [{**flow, "match": {"symbol": "2330"}}]})) == ["MATCH_FIELD"]
    event = {"rule_id": "e", "type": "window_move", "window": 1, "threshold_pct": 1.0, "priority": 400}
    assert validate_event_rules({"rules": [event]}) == []
    assert codes(validate_event_rules({"rules": [{**event, "label": 3}]})) == ["FIELD_TYPE"]
    assert "FIELD_TYPE" in codes(validate_event_rules({"rules": [{**event, "reset_ratio": "x"}]}))


@pytest.mark.parametrize("validate, base", [
    (validate_flow_rules, {"threshold_type": "volume", "threshold": 10}),
    (validate_event_rules, {"type": "opening_move", "threshold_pct": 1.0}),
])
@pytest.mark.parametrize("rule_id", [7, 1.5, True, ["r"], {"id": "r"}, "", "   "])
def test_rule_id_is_a_non_empty_string(validate, base, rule_id):
    # rule_id is a String in Rust B: a number there failed the whole revision while str() made it pass here.
    assert "RULE_ID" in codes(validate({"rules": [{"rule_id": rule_id, **base}]}))


@pytest.mark.parametrize("rule", [
    {"type": "opening_move", "threshold_pct": 1.0, "window": 2 ** 31},
    {"type": "opening_move", "threshold_pct": 1.0, "window": -(2 ** 31) - 1},
    {"type": "window_move", "window": 1, "threshold_pct": 10 ** 400},
])
def test_integers_and_numbers_outside_rust_b_types_are_refused(rule):
    # window is i32 in Rust B; a number too large for an f64 is refused, not a crash.
    assert validate_event_rules({"rules": [{"rule_id": "r", **rule}]}) != []


def test_a_flow_number_too_large_for_a_float_is_a_problem_not_a_crash():
    problems = validate_flow_rules({"rules": [{"rule_id": "r", "threshold_type": "volume", "threshold": 10 ** 400,
                                               "impact_ratio": 10 ** 400, "episode_gap_ms": 10}]})
    assert {"THRESHOLD", "IMPACT_RATIO"} <= codes(problems)
