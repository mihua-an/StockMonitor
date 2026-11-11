"""A timestamp's age is "none" only for what the contract allows; any other fault is raised, not hidden.

``_age_seconds()`` caught every Exception and answered None, so a broken clock or a later code error showed up as a
source with no age instead of a failure.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from api.source_diagnostics import timestamp_age_seconds

NOW = datetime(2026, 10, 21, 9, 0, 0, tzinfo=timezone.utc)


def clock(tz=None):
    return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


def test_ages_of_valid_and_contract_invalid_timestamps():
    assert timestamp_age_seconds("2026-10-21T08:59:30Z", clock=clock) == 30.0
    assert timestamp_age_seconds("2026-10-21T08:59:00", clock=clock) == 60.0
    assert timestamp_age_seconds("2026-10-21T09:00:10+00:00", clock=clock) == 0.0, "never negative"
    for invalid in (None, "", "yesterday", "2026-13-01T00:00:00", 12345):
        assert timestamp_age_seconds(invalid, clock=clock) is None, invalid


def test_an_unexpected_fault_is_raised():
    def broken(tz=None):
        raise RuntimeError("clock unavailable")

    with pytest.raises(RuntimeError, match="clock unavailable"):
        timestamp_age_seconds("2026-10-21T08:59:30Z", clock=broken)
