// 成交明細's column settings, per list (Shioaji / Futu, the component's widthScope): which of 時間、成交、漲跌、
// 漲跌幅、單量、總量 are shown and in what order. Edited in the shared column settings panel (its ⚙, user 11-11) and
// kept in this browser's storage like the product list's settings.
import { FUTU_TICK_DETAILS_COLUMNS, TICK_DETAILS_COLUMNS } from "./column_schemas.js";
import { defineColumnSchema } from "./column_title.js";
import { buildProductColumnSettings, resolveProductColumnSettings } from "./product_column_settings.js";
import { registerColumnProfile } from "./column_profiles.js";

export const TICK_DETAILS_COLUMNS_CHANGED = "tick-details-columns-changed";

// A Futu ticker row states no cumulative volume (Market Runtime sends total_volume null for it): 總量 is listed
// greyed out there and never shown.
const SCOPES = {
  shioaji: { schema: TICK_DETAILS_COLUMNS, unavailable: {} },
  futu: { schema: FUTU_TICK_DETAILS_COLUMNS, unavailable: { total_volume: "富途的逐筆成交沒有累計總量" } },
};

function scopeOf(scope) { return SCOPES[scope] ? String(scope) : "shioaji"; }
function storageKey(scope) { return `tickDetailsColumns:${scopeOf(scope)}`; }
function availableKeys(scope) {
  const { schema, unavailable } = SCOPES[scopeOf(scope)];
  return schema.map((column) => column.id).filter((key) => !unavailable[key]);
}

export function tickDetailsColumnProfile(scope) { return `tickDetails:${scopeOf(scope)}`; }

// Unavailable columns are never visible, and at least one available column always is: a stored record that shows
// none (written by hand) shows 成交.
function settle(settings, scope) {
  const available = new Set(availableKeys(scope));
  const visible = Object.fromEntries(Object.entries(settings.visible).map(([key, shown]) => [key, shown === true && available.has(key)]));
  if (![...available].some((key) => visible[key])) visible.trade = true;
  return { ...settings, visible };
}

// Keyed on the raw stored string (as the product list's settings): each table render reads it, and any writer
// invalidates it just by changing what the storage holds.
const cache = new Map();  // scope -> { raw, settings, columns }

function readRaw(scope) {
  try { return localStorage.getItem(storageKey(scope)); }
  catch (error) { console.warn("[tick details columns: reading the stored settings] failed", error); return null; }
}

function entry(scope) {
  const name = scopeOf(scope);
  const raw = readRaw(name);
  const cached = cache.get(name);
  if (cached && cached.raw === raw) return cached;
  let saved = null;
  try { saved = JSON.parse(raw || "null"); }
  catch (error) { console.warn("[tick details columns: parsing the stored settings] failed", error); saved = null; }
  const { schema } = SCOPES[name];
  const keys = schema.map((column) => column.id);
  const settings = settle(resolveProductColumnSettings({ saved, optionKeys: keys, defaultVisibleKeys: keys }), name);
  const byId = new Map(schema.map((column) => [column.id, column]));
  const columns = defineColumnSchema(settings.order.filter((key) => settings.visible[key]).map((key) => byId.get(key)), { id: "tickDetails" });
  const next = { raw, settings, columns };
  cache.set(name, next);
  return next;
}

export function tickDetailsColumnSettings(scope) { return entry(scope).settings; }

/** The columns the list shows, in the user's order (a column schema). */
export function tickDetailsVisibleColumns(scope) { return entry(scope).columns; }

export function setTickDetailsColumnSettings(scope, settings = {}) {
  const name = scopeOf(scope);
  const normalized = settle(buildProductColumnSettings({
    order: settings.order, visible: settings.visible || {}, optionKeys: SCOPES[name].schema.map((column) => column.id),
  }), name);
  localStorage.setItem(storageKey(name), JSON.stringify({ schema_version: normalized.schema_version, order: normalized.order, visible: normalized.visible }));
  window.dispatchEvent(new CustomEvent(TICK_DETAILS_COLUMNS_CHANGED, { detail: { scope: name } }));
  return normalized;
}

for (const scope of Object.keys(SCOPES)) {
  registerColumnProfile(tickDetailsColumnProfile(scope), {
    title: "成交明細欄位",
    // At least one column stays shown: the last one ticked cannot be unticked.
    required: availableKeys(scope),
    options: () => SCOPES[scope].schema.map((column) => ({
      key: column.id, label: column.title,
      unavailable: Boolean(SCOPES[scope].unavailable[column.id]), unavailableReason: SCOPES[scope].unavailable[column.id] || "",
    })),
    read: () => tickDetailsColumnSettings(scope),
    write: (settings) => setTickDetailsColumnSettings(scope, settings),
  });
}
