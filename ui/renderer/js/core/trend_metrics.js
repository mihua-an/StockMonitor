// 漲跌 / 漲幅 / 振幅 of a trend view (加權, 期貨, 產業指數, 回放): Market Runtime's (its summary `change` / `change_pct` /
// `amplitude`, D01-04), passed through. The view model owns the result; the header presenter only formats it. A missing
// input gives null, never 0.

import { numberOrNull } from "./numbers.js";

export function trendMetrics({ change = null, changePct = null, amplitude = null } = {}) {
  return { change: numberOrNull(change), changePct: numberOrNull(changePct), amplitude: numberOrNull(amplitude) };
}

/** 振幅 of a chart tab whose range is not the instrument's day (期貨的日盤／夜盤／全日): that range against its reference. */
export function tabAmplitude({ reference = null, high = null, low = null } = {}) {
  const ref = numberOrNull(reference), top = numberOrNull(high), bottom = numberOrNull(low);
  return ref != null && ref > 0 && top != null && bottom != null ? (top - bottom) / ref * 100 : null;
}
