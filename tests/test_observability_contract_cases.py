"""config/observability_contract.py metric() on the shared cases (tests/observability_contract_contract.cjs runs the
same cases through the Node module): the complete serialized metric is the same in both languages."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from config.observability_contract import metric

CASES = json.loads((Path(__file__).parent / "fixtures" / "observability_metric_cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_metric_matches_the_shared_case(case):
    args = dict(case["args"])
    name, service_id = args.pop("name"), args.pop("service_id")
    if "error" in case:
        with pytest.raises(ValueError, match=re.escape(case["error"])):
            metric(name, service_id, **args)
    else:
        assert metric(name, service_id, **args) == case["metric"]


def test_a_missing_sample_time_is_filled_with_now():
    sampled = metric("q", "s", unit="u", value=1)["sampled_at"]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", sampled)
