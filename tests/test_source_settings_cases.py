"""config/source_settings.py refuses the same damaged settings, with the same problems, as config/js/source_settings.js
(tests/source_enablement_contract.cjs runs the same cases)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from config.source_settings import source_settings_problems

CASES = json.loads((Path(__file__).parent / "fixtures" / "source_settings_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_source_settings_problems_match_the_shared_cases(case):
    assert source_settings_problems(case["settings"]) == case["problems"]
