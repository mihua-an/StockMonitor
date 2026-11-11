from __future__ import annotations

import pandas as pd

from service.market.shioaji.history_repository import ShioajiHistoricalRepository


def test_mixed_precision_timestamps_keep_close_capture_rows() -> None:
    values = pd.Series([
        "2026-09-04T13:24:58.901273",
        "2026-09-04T13:30:00",
    ])

    parsed = ShioajiHistoricalRepository._parse_timestamp_series(values)

    assert parsed.notna().all()
    assert parsed.iloc[-1] == pd.Timestamp("2026-09-04T13:30:00")
