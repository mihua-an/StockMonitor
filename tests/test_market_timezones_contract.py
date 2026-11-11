"""config/market_timezones.json is the one table of each market's clock; the session identity contract reads it."""
import json
from zoneinfo import ZoneInfo

from service.market.shared.session_identity_contract import MARKET_TIMEZONES, market_zone
from service.platform import project_root as process_paths


def test_session_identity_reads_the_shared_table():
    table = json.loads((process_paths.PROJECT_ROOT / "config" / "market_timezones.json").read_text(encoding="utf-8"))["markets"]
    assert MARKET_TIMEZONES == table
    for market, zone in table.items():
        assert market_zone(market) == ZoneInfo(zone)
        assert market_zone(market.lower()) == ZoneInfo(zone)
    assert market_zone("XX") == ZoneInfo("UTC")
