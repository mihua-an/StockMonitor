"""Every CSS selector under ui/ names classes/ids some JS or HTML under ui/ produces."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_no_css_rule_without_a_producer():
    out = subprocess.run([sys.executable, str(ROOT / "scripts" / "tooling" / "css_selector_coverage.py")],
                         capture_output=True, text=True, check=True).stdout
    assert out.strip().splitlines()[-1] == "total 0 0", out
