// 設定 > 顯示: per-viewer display preferences, each applied as soon as it is chosen -- the price colour scheme
// (main process, shared by every window), the 個股走勢 footer horizons and the 即時報價 pane workspace. A choice shows
// itself (the check mark, the select's value), so only a failure says anything, left of its group; 還原預設版面 has no
// visible result here and floats one.

import { $ } from "../core/utility.js";
import { themeColor } from "../core/market_palette.js";
import { inFlight, runSingleFlight, userFacingMessage } from "../core/user_action.js";
import { setNote } from "../core/settings_ui.js";
import { MODEL_HORIZON_OPTIONS, getTrendFooterHorizons, setTrendFooterHorizons } from "../core/trend_footer_horizons.js";

// Unlike the click listeners below (bound to DOM nodes that get replaced, and so self-clean, whenever this page's
// HTML is reloaded), this is an ipcRenderer subscription that lives outside the DOM -- it must be explicitly
// unsubscribed or repeated init calls would stack duplicate main->renderer listeners.
let colorPreferencesUnsubscribe = null;

// Only two presets are offered: Taiwan-market convention (red = up, green =
// down) or the swapped/international convention (green = up, red = down).
// Flat stays fixed white -- not part of either scheme. The colours are tokens.css's, read when a scheme is chosen.
const priceColorSchemes = () => ({
  "red-up": { priceUpColor: themeColor("--market-red"), priceDownColor: themeColor("--market-green"), priceFlatColor: themeColor("--white") },
  "green-up": { priceUpColor: themeColor("--market-green"), priceDownColor: themeColor("--market-red"), priceFlatColor: themeColor("--white") },
});

function schemeFromColors(colors = {}) {
  return colors.priceUpColor === themeColor("--market-green") ? "green-up" : "red-up";
}

function applyPriceColorScheme(scheme) {
  for (const id of ["priceColorSchemeRedUp", "priceColorSchemeGreenUp"]) {
    const row = $(id);
    if (!row) continue;
    const chosen = row.dataset.scheme === scheme;
    row.setAttribute("aria-pressed", String(chosen));
    const mark = row.querySelector(".settings-checkmark");
    if (mark) mark.textContent = chosen ? "✓" : "";
  }
}

// The save only says whether it went through (a failure rejects); what the page shows after it comes from main's
// preferences:colors-changed broadcast alone, which every window receives in save order -- so a slow answer to this
// window's older save can never draw over a newer save made in another window.
async function savePriceColorScheme(scheme) {
  const schemes = priceColorSchemes();
  const payload = schemes[scheme] || schemes["red-up"];
  await window.desktopAPI.setColorPreferences(payload);
}

// The one read at load is the bootstrap snapshot; after that the broadcast is the only writer of the check marks.
function bindPriceColorSettings() {
  applyPriceColorScheme(schemeFromColors(window.desktopAPI?.colorPreferences || {}));
  colorPreferencesUnsubscribe?.();
  colorPreferencesUnsubscribe = window.desktopAPI?.onColorPreferencesChanged?.(
    (colors) => applyPriceColorScheme(schemeFromColors(colors))
  ) || null;
  for (const id of ["priceColorSchemeRedUp", "priceColorSchemeGreenUp"]) {
    $(id)?.addEventListener("click", (event) => {
      setNote($("priceColorMessage"), "");
      const btn = event.currentTarget;
      const flight = runSingleFlight(btn, () => savePriceColorScheme(btn.dataset.scheme));
      syncSchemeButtons();
      flight
        .catch((error) => setNote($("priceColorMessage"), userFacingMessage(error, "套用顏色失敗，請稍後再試", { context: "SETTINGS_COLOR_SAVE" }), true))
        .then(syncSchemeButtons);
    });
  }
}

// The scheme rows' one writer of `disabled`: a row is pressed again only once its save has settled.
function syncSchemeButtons() {
  for (const id of ["priceColorSchemeRedUp", "priceColorSchemeGreenUp"]) {
    const row = $(id);
    if (row) row.disabled = inFlight(row);
  }
}

// 個股走勢 footer horizons (core/trend_footer_horizons.js): two of the model horizons, applied on change.
function bindTrendFooterHorizonSettings() {
  const selects = [$("trendFooterHorizonA"), $("trendFooterHorizonB")];
  if (selects.some((select) => !select)) return;
  const current = getTrendFooterHorizons();
  selects.forEach((select, index) => {
    select.innerHTML = MODEL_HORIZON_OPTIONS.map((minutes) => `<option value="${minutes}">${minutes} 分鐘</option>`).join("");
    select.value = String(current[index]);
    select.addEventListener("change", () => {
      const message = $("trendFooterHorizonMessage");
      try {
        setTrendFooterHorizons(selects.map((node) => Number(node.value)));
        setNote(message, "");
      } catch (error) {
        setNote(message, userFacingMessage(error, "套用走勢預測時間失敗，請稍後再試", { context: "SETTINGS_TREND_FOOTER_HORIZONS" }), true);
      }
    });
  });
}

// 即時報價's screens are arranged in their own window (pages/layouts.js).
function bindRealtimePaneSettings() {
  const message = $("realtimePaneMessage");
  $("realtimeLayoutEditorOpen")?.addEventListener("click", () => {
    setNote(message, "");
    Promise.resolve(window.desktopAPI?.openLayoutEditor?.())
      .catch((error) => setNote(message, userFacingMessage(error, "開啟版型編輯失敗，請稍後再試", { context: "SETTINGS_LAYOUT_EDITOR" }), true));
  });
}

export function initDisplaySettings() {
  bindPriceColorSettings();
  bindTrendFooterHorizonSettings();
  bindRealtimePaneSettings();
}

export function disposeDisplaySettings() {
  colorPreferencesUnsubscribe?.();
  colorPreferencesUnsubscribe = null;
}
