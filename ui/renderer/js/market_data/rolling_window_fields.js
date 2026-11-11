// Rust B's rolling windows (a view's `windows` channel, 02_rust_b.md section 3) as product-row fields: the one
// reading both the Shioaji rows (canonical_view_owner.js) and the Futu rows (moomoo_view_adapter.js) use, so a
// 1m／3m／5m has one definition on every list.

// Rust B's rolling windows -> the product-row fields (percent, like every other row change column). The window
// is the N minutes ending at the evaluation minute (02 section 3); a window B marks incomplete is still shown
// with its value -- completeness is B's statement, not a reason to invent a zero.
export function windowSummaryFields(windows = {}) {
  const block = windows?.windows && typeof windows.windows === "object" ? windows.windows : {};
  const out = { short_change_source: "NATIVE_ROLLING_WINDOW" };
  // Every window B computes (1/3/5/15/30/60 min); 60 is presented as "1h".
  for (const minutes of [1, 3, 5, 15, 30, 60]) {
    const w = block[String(minutes)] || null;
    let pct = w?.change_pct;
    if (pct != null && w?.change_pct_unit === "decimal_ratio") pct = Number(pct) * 100;
    const label = minutes === 60 ? "1h" : `${minutes}m`;
    out[`chg_${label}`] = pct == null ? null : Number(pct);
    out[`price_${label}_ago`] = w?.base_price ?? null;
  }
  // 1mK / 3mK / 5mK: the price against the open of the current session-aligned bar (B's `k`).
  const k = windows?.k && typeof windows.k === "object" ? windows.k : {};
  for (const minutes of [1, 3, 5]) {
    const pct = k[String(minutes)]?.change_pct;
    out[`k_${minutes}m`] = pct == null ? null : Number(pct);
  }
  // 量變: the last completed clock minute against the previous session's same minute (B's `volume_compare`).
  // Present = authoritative for its minute, null percent included, so a stale number never outlives its minute.
  const compare = windows?.volume_compare;
  if (compare && typeof compare === "object") {
    Object.assign(out, {
      volume_baseline_source: "NATIVE_COMPLETED_CLOCK_MINUTE",
      baseline_date: compare.baseline_date ?? null,
      baseline_minute: compare.baseline_minute ?? null,
      baseline_volume: compare.baseline_volume ?? null,
      volume_diff_vs_baseline: compare.diff ?? null,
      volume_ratio_vs_baseline: compare.ratio ?? null,
      volume_change_pct_vs_baseline: compare.change_pct == null ? null : Number(compare.change_pct),
    });
  }
  return out;
}
