// Which two model horizons the 個股走勢 footer shows as "N分上漲 / N分下跌".
//
// The horizon list itself is owned by config/prediction_horizons.json (allowed_minutes / default_enabled_minutes);
// tests/trend_footer_horizons_contract.mjs keeps these two constants equal to it.
// The CHOICE of two is a display preference: set from the settings page today, and from the model-analysis page
// once it exists -- both call setTrendFooterHorizons(), and every open window follows (storage event).
import { readJsonPreference, writePreferenceOrThrow } from "./preferences.js";

export const MODEL_HORIZON_OPTIONS = Object.freeze([3, 5, 10, 15, 30]);
export const DEFAULT_TREND_FOOTER_HORIZONS = Object.freeze([3, 5]);
const STORAGE_KEY = "stockmonitor.trendFooterHorizons.v1";
const CHANGED = "trend-footer-horizons-changed";

function valid(list) {
  if (!Array.isArray(list) || list.length !== 2) return null;
  const pair = list.map(Number);
  return pair.every((n) => MODEL_HORIZON_OPTIONS.includes(n)) ? pair : null;
}

export function getTrendFooterHorizons() {
  return valid(readJsonPreference(STORAGE_KEY, { context: "trend footer horizons" })) || [...DEFAULT_TREND_FOOTER_HORIZONS];
}

/** Store the pair and tell every listener; throws when the pair is refused or cannot be kept (nothing announced). */
export function setTrendFooterHorizons(list) {
  const pair = valid(list);
  if (!pair) throw new Error(`horizons must be two of ${MODEL_HORIZON_OPTIONS.join("/")} minutes`);
  writePreferenceOrThrow(STORAGE_KEY, JSON.stringify(pair), { context: "trend footer horizons" });
  globalThis.window?.dispatchEvent?.(new CustomEvent(CHANGED, { detail: { horizons: pair } }));
  return pair;
}

export function subscribeTrendFooterHorizons(callback) {
  const win = globalThis.window;
  if (!win?.addEventListener) return () => {};
  const local = () => callback(getTrendFooterHorizons());
  const other = (event) => { if (event.key === STORAGE_KEY) callback(getTrendFooterHorizons()); };
  win.addEventListener(CHANGED, local);
  win.addEventListener("storage", other);
  return () => { win.removeEventListener(CHANGED, local); win.removeEventListener("storage", other); };
}
