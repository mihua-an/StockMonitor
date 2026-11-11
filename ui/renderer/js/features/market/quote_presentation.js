import { REALTIME_QUOTE_COLUMNS, REALTIME_HOLDING_COLUMNS } from "../../core/column_schemas.js";
import { resolveProductColumnSettings, buildProductColumnSettings } from "../../core/product_column_settings.js";
import { destroyColumnTitle } from "../../core/column_title.js";
import { registerColumnProfile } from "../../core/column_profiles.js";

// Two column profiles (user's choice): the ordinary product pages, and the 實際庫存 page with a
// column list of its own -- the position columns plus every ordinary one. Both product lists (Shioaji and Futu)
// share each profile. A column added to a schema later is appended to the end of its profile's list.
export const PRODUCT_COLUMN_PROFILE = "products";
export const HOLDINGS_COLUMN_PROFILE = "holdings";

const PROFILES = {
  [PRODUCT_COLUMN_PROFILE]: {
    storageKey: "shioajiMonitorQuoteColumnsV1",
    title: "商品列表欄位",
    columns: REALTIME_QUOTE_COLUMNS,
    defaults: ["name", "code", "volume_change", "prev_close", "open", "current", "chg_1m", "chg_3m", "chg_5m", "day_change_pct"],
  },
  [HOLDINGS_COLUMN_PROFILE]: {
    storageKey: "actualHoldingsQuoteColumnsV1",
    title: "實際庫存欄位",
    columns: [...REALTIME_HOLDING_COLUMNS, ...REALTIME_QUOTE_COLUMNS],
    defaults: ["name", "code", "position_qty", "position_pnl", "position_pnl_pct", "prev_close", "current", "position_avg_cost", "position_cost_amount"],
  },
};

function profileOf(name) {
  return PROFILES[name] || PROFILES[PRODUCT_COLUMN_PROFILE];
}

export function getRealtimeQuoteColumnOptions(profile = PRODUCT_COLUMN_PROFILE) {
  return profileOf(profile).columns.map((column) => ({ key: column.id, label: column.title }));
}

function columnOptionKeys(profile) {
  return profileOf(profile).columns.map((column) => column.id);
}

// 股名、股號至少顯示一個 (user 11-07): a row's 現／期 and month controls sit on whichever of the two is shown. A
// setting that hides both shows 股名.
const IDENTITY_COLUMN_KEYS = Object.freeze(["name", "code"]);
function keepIdentityColumn(visible) {
  return IDENTITY_COLUMN_KEYS.some((key) => visible[key] === true) ? visible : { ...visible, name: true };
}

// Keyed on the RAW stored string, so any writer -- this module, another window,
// devtools -- invalidates it just by changing what localStorage holds. There is
// no separate invalidation hook to forget. Only the parse and the normalisation
// are skipped; the getItem still happens every call, which is what keeps this
// honest. Measured on this machine: getItem 0.20us, JSON.parse 1.28us,
// resolveProductColumnSettings 5.46us. realtimeRowCells() calls this once PER ROW
// while rendering, and the column set cannot change between rows of one render,
// so a 74-row product list was paying 74 parses and 148 twenty-key object
// allocations to re-derive an identical answer -- 0.66ms, about 45% of the
// list's fixed per-row cost.
const columnSettingsCache = new Map();  // profile -> { raw, settings, config }

function readColumnSettingsRaw(profile) {
  try { return localStorage.getItem(profileOf(profile).storageKey); }
  catch (error) { console.warn("[quote columns: reading the stored settings] failed", error); return null; }
}

function columnSettingsEntry(profile) {
  const raw = readColumnSettingsRaw(profile);
  const cached = columnSettingsCache.get(profile);
  if (cached && cached.raw === raw) return cached;
  let saved = null;
  try { saved = JSON.parse(raw || "null"); }
  catch (error) { console.warn("[reading the saved product column settings] failed", error); saved = null; }
  const resolved = resolveProductColumnSettings({
    saved,
    optionKeys: columnOptionKeys(profile),
    defaultVisibleKeys: profileOf(profile).defaults,
  });
  const settings = { ...resolved, visible: keepIdentityColumn(resolved.visible) };
  // Replaced, never mutated: a caller still holding an earlier result keeps a
  // valid snapshot of the settings as they were when it asked.
  const entry = { raw, settings, config: settings.order.filter((key) => settings.visible[key] === true) };
  columnSettingsCache.set(profile, entry);
  return entry;
}

export function getRealtimeQuoteColumnSettings(profile = PRODUCT_COLUMN_PROFILE) {
  return columnSettingsEntry(profile).settings;
}

export function getRealtimeQuoteColumnConfig(profile = PRODUCT_COLUMN_PROFILE) {
  return columnSettingsEntry(profile).config;
}

// Saved, then announced: each product list draws its own table again on `realtime-product-columns-changed`.
export function setRealtimeQuoteColumnSettings(settings = {}, { profile = PRODUCT_COLUMN_PROFILE } = {}) {
  const normalized = buildProductColumnSettings({
    order: settings.order,
    visible: keepIdentityColumn(settings.visible || {}),
    optionKeys: columnOptionKeys(profile),
  });
  localStorage.setItem(profileOf(profile).storageKey, JSON.stringify({
    schema_version: normalized.schema_version,
    order: normalized.order,
    visible: normalized.visible,
  }));
  const tables = [...document.querySelectorAll('[data-role="product-list-table"]')];
  for (const table of tables) {
    destroyColumnTitle(table);
    table.querySelector('colgroup[data-column-schema-owner="realtimeQuote"]')?.remove();
  }
  window.dispatchEvent(new CustomEvent("realtime-product-columns-changed", { detail: { profile } }));
  return normalized;
}

// The two lists in the column settings panel (core/components/column_settings_editor.js).
for (const name of [PRODUCT_COLUMN_PROFILE, HOLDINGS_COLUMN_PROFILE]) {
  registerColumnProfile(name, {
    title: PROFILES[name].title,
    required: IDENTITY_COLUMN_KEYS,
    options: () => getRealtimeQuoteColumnOptions(name),
    read: () => getRealtimeQuoteColumnSettings(name),
    write: (settings) => setRealtimeQuoteColumnSettings(settings, { profile: name }),
  });
}

