//! Rust A reads a market's trading date on fixed offsets (event.rs market_offset_seconds); config/market_timezones.json
//! is the one table of each market's zone (Python loads it, the renderer's copy is tested against it). Every market in
//! the table must get its zone's offset here, in winter and in summer.

use market_runtime::event::market_offset_seconds;
use serde_json::Value;

const TABLE: &str = include_str!("../../../config/market_timezones.json");
// 2026-01-15 12:00 UTC and 2026-07-15 12:00 UTC: one date each side of New York's daylight-saving change.
const WINTER: i64 = 1_768_478_400;
const SUMMER: i64 = 1_784_116_800;

fn expected_offsets(zone: &str) -> (i64, i64) {
    match zone {
        // No daylight saving in any of these.
        "Asia/Taipei" | "Asia/Hong_Kong" | "Asia/Shanghai" => (8 * 3600, 8 * 3600),
        "America/New_York" => (-5 * 3600, -4 * 3600),
        other => panic!("config/market_timezones.json names {other}, which market_offset_seconds has no rule for"),
    }
}

#[test]
fn every_market_in_the_table_gets_its_zone_offset() {
    let table: Value = serde_json::from_str(TABLE).expect("config/market_timezones.json parses");
    let markets = table["markets"].as_object().expect("markets is an object");
    assert!(!markets.is_empty());
    for (market, zone) in markets {
        let zone = zone.as_str().expect("a zone name");
        let (winter, summer) = expected_offsets(zone);
        assert_eq!(market_offset_seconds(market, WINTER), winter, "{market} ({zone}) in winter");
        assert_eq!(market_offset_seconds(market, SUMMER), summer, "{market} ({zone}) in summer");
    }
}
