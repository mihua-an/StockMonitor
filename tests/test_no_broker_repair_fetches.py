"""The Shioaji history repository asks the broker only for what a user-started K-bar download needs; the tick and
final-volume repair fetches nobody called are gone (a gap fill goes through the provider's fill_history_windows)."""
from __future__ import annotations

from service.market.shioaji.history_repository import ShioajiHistoricalRepository


def test_only_the_kbar_download_asks_the_broker():
    broker_reads = sorted(name for name in vars(ShioajiHistoricalRepository) if name.startswith("fetch_broker_"))
    assert broker_reads == ["fetch_broker_kbars_for_download"]
    for gone in ("normalize_ticks", "_normalize_ticks", "_parse_timestamp_series"):
        assert not hasattr(ShioajiHistoricalRepository, gone), gone
