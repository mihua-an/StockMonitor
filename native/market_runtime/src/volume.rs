//! 成交量 (volume) on every boundary: a decimal quantity, `f64`.
//!
//! An integer would silently turn a US fractional-share print (0.25 shares, Futu `hpVolume`) into 0.
//! Prices stay integers in 1/10_000 units (event::PRICE_SCALE); volume does not, because a source's size is whatever
//! the exchange reports and the system only adds sizes up and compares them.
//!
//! Rules that keep f64 safe here:
//! - Comparisons go through [`eq`] / [`gt`] / [`lt`] / [`positive`] with a tolerance relative to the magnitude, never
//!   `==` on two volumes: a cumulative total that was summed (0.1 + 0.2) and one the source sent (0.3) are the same
//!   total, and "the cumulative volume did not move" (a broker resend) must not depend on the last bit.
//! - Sums are plain `+` (f64 has ~15-16 significant digits; a day of TW lots or US shares is far below that), and
//!   [`clean`] removes the binary noise only where a value leaves the process (wire JSON, files).
//! - A whole value is written as a JSON integer, so a TW lot count reads exactly as before (10, not 10.0).
//! - The unit is explicit: [`unit`] names it per source/market (張 / 口 / 股 / 顆).

use serde_json::Value;

pub type Volume = f64;

/// Relative tolerance for volume comparisons (and the absolute floor for values below 1).
pub const TOLERANCE: f64 = 1e-9;
/// Decimal places kept when a volume leaves the process. Futu reports sub-share sizes; 8 places is far finer than
/// any exchange's quantity step and coarser than the binary noise of a day's sum.
pub const DECIMALS: i32 = 8;

fn tol(a: f64, b: f64) -> f64 {
    TOLERANCE * 1f64.max(a.abs()).max(b.abs())
}

/// The two volumes are the same quantity.
pub fn eq(a: Volume, b: Volume) -> bool {
    (a - b).abs() <= tol(a, b)
}

/// `a` is more than `b` (not just by binary noise).
pub fn gt(a: Volume, b: Volume) -> bool {
    a - b > tol(a, b)
}

/// `a` is less than `b` (not just by binary noise).
pub fn lt(a: Volume, b: Volume) -> bool {
    b - a > tol(a, b)
}

/// A real, positive quantity (NaN / infinity / zero / negative are not).
pub fn positive(v: Volume) -> Option<Volume> {
    (v.is_finite() && v > TOLERANCE).then_some(v)
}

/// A finite value from a source; anything else is no quantity.
pub fn sanitize(v: Volume) -> Volume {
    if v.is_finite() { v } else { 0.0 }
}

/// The value without binary noise (0.1 + 0.2 -> 0.3), for output.
pub fn clean(v: Volume) -> Volume {
    if !v.is_finite() {
        return 0.0;
    }
    let scale = 10f64.powi(DECIMALS);
    let rounded = (v * scale).round() / scale;
    if rounded == 0.0 { 0.0 } else { rounded }
}

/// JSON for a volume: an integer when whole (TW lots read exactly as before), else the cleaned decimal.
pub fn wire(v: Volume) -> Value {
    let c = clean(v);
    if c.fract() == 0.0 && c.abs() < 9.0e15 {
        Value::from(c as i64)
    } else {
        Value::from(c)
    }
}

pub fn wire_opt(v: Option<Volume>) -> Value {
    v.map(wire).unwrap_or(Value::Null)
}

/// What one unit of `volume` is for this source/market: Shioaji stocks trade in 張 (lots of 1,000 shares), futures in
/// 口 (contracts), Futu equities in 股 (shares, fractional allowed), crypto in coins.
pub fn unit(source: &str, market: &str) -> &'static str {
    match (source.to_ascii_lowercase().as_str(), market.to_ascii_uppercase().as_str()) {
        ("shioaji", "STK") => "lot",
        ("shioaji", "FUT") => "contract",
        ("shioaji", "IDX") => "index_lot",
        ("futu", "CC") => "coin",
        ("futu", _) => "share",
        _ => "unit",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comparisons_ignore_binary_noise_but_not_real_differences() {
        let summed = 0.1 + 0.2; // 0.30000000000000004
        assert!(summed != 0.3, "the premise: plain == fails");
        assert!(eq(summed, 0.3));
        assert!(!gt(summed, 0.3) && !lt(summed, 0.3));
        // A real fractional difference is never swallowed, even at large totals.
        assert!(gt(48_971_788.25, 48_971_788.0));
        assert!(lt(0.0001, 0.0002));
        assert!(!eq(0.25, 0.0));
        // A day of many small prints adds up to the source's cumulative figure.
        let total: f64 = std::iter::repeat_n(0.01, 10_000).sum();
        assert!(eq(total, 100.0), "{total}");
        let lots: f64 = (1..=200_000).map(|i| (i % 7 + 1) as f64).sum();
        assert_eq!(lots, 799_997.0, "whole lots stay exact in f64");
    }

    #[test]
    fn a_positive_fractional_size_is_never_zero() {
        assert_eq!(positive(0.25), Some(0.25));
        assert_eq!(positive(0.0001), Some(0.0001));
        assert_eq!(positive(0.0), None);
        assert_eq!(positive(-1.0), None);
        assert_eq!(positive(f64::NAN), None);
        assert_eq!(positive(f64::INFINITY), None);
        assert_eq!(wire(0.25), serde_json::json!(0.25));
        assert_eq!(wire(0.0001), serde_json::json!(0.0001));
    }

    #[test]
    fn output_is_clean_and_whole_values_stay_integers() {
        assert_eq!(wire(0.1 + 0.2), serde_json::json!(0.3));
        assert_eq!(wire(10.0), serde_json::json!(10));
        assert!(wire(10.0).is_i64(), "a TW lot count is still an integer on the wire");
        assert_eq!(wire(48_971_788.0), serde_json::json!(48_971_788));
        assert_eq!(wire_opt(None), Value::Null);
        assert_eq!(clean(-0.0), 0.0);
        assert_eq!(clean(f64::NAN), 0.0);
    }

    #[test]
    fn old_integer_records_read_as_volumes() {
        // WAL / checkpoint / history JSON written before this change holds integers: they deserialize unchanged.
        let v: Volume = serde_json::from_str("1234").unwrap();
        assert_eq!(v, 1234.0);
        let v: Volume = serde_json::from_str("0.25").unwrap();
        assert_eq!(v, 0.25);
    }

    #[test]
    fn every_market_names_its_unit() {
        assert_eq!(unit("shioaji", "STK"), "lot");
        assert_eq!(unit("shioaji", "FUT"), "contract");
        assert_eq!(unit("futu", "US"), "share");
        assert_eq!(unit("futu", "HK"), "share");
        assert_eq!(unit("futu", "CC"), "coin");
    }
}
