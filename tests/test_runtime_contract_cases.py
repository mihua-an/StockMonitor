"""The Python runtime-contract loader refuses the same damaged contracts, with the same problems, as the Node one
(tests/runtime_config_failure_contract.cjs runs the same cases)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from service.platform.runtime_contract import contract_problems

CASES = json.loads((Path(__file__).parent / "fixtures" / "runtime_contract_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_contract_problems_match_the_shared_cases(case):
    assert contract_problems(case["contract"]) == case["problems"]
