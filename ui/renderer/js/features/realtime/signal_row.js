// The one projection of an instrument's `signals` block (Market Runtime's view channel) into product-row fields
// for both the Shioaji product rows (canonical_view_owner.js) and the Futu rows (moomoo_view_adapter.js): two copies had
// drifted (one kept nulls and the row stamp, the other dropped both).
//
// Market Runtime sends the instrument's WHOLE merged signals object on every `signals.frame` and in every view
// snapshot (projection.rs merge_signals), so what this returns is the complete row -- callers replace the previous
// row with it, never merge into it.
//
// - `authority` is transport provenance, not a row field.
// - 量變 is renamed for the column reader (`volume_change_pct_vs_baseline`). It is one fact with the clock minute it
//   compares (`volume_compare_minute`): a named minute without a value is an explicit "no 量變 for that minute"
//   (null), never the previous minute's number.
// - `update_time` (exchange clock) stays on the row: the page's 更新時間 is the newest stamp of the rows it shows.
// - Other null or missing values are left out (no value, not zero).

/** Product-row fields of one `signals` block; null when there is no block (no analysis row for the instrument). */
export function signalRowFields(signals) {
  if (!signals || typeof signals !== "object") return null;
  const { volume_change_pct: volumeChange, authority: _authority, ...rest } = signals;
  const fields = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== null && value !== undefined) fields[key] = value;
  }
  if (rest.volume_compare_minute !== null && rest.volume_compare_minute !== undefined) {
    fields.volume_change_pct_vs_baseline = volumeChange ?? null;
  } else if (volumeChange !== null && volumeChange !== undefined) {
    fields.volume_change_pct_vs_baseline = volumeChange;
  }
  return fields;
}
