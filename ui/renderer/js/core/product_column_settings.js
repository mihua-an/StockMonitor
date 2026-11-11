export const PRODUCT_COLUMN_SETTINGS_SCHEMA_VERSION = 2;

export function normalizeProductColumnOrder(optionKeys = [], values = [], { appendMissing = true } = {}) {
  const allowed = new Set((Array.isArray(optionKeys) ? optionKeys : []).map((value) => String(value || "").trim()).filter(Boolean));
  const seen = new Set();
  const normalized = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter((key) => allowed.has(key) && !seen.has(key) && seen.add(key));
  if (appendMissing) {
    for (const key of allowed) {
      if (!seen.has(key)) { seen.add(key); normalized.push(key); }
    }
  }
  return normalized;
}

export function resolveProductColumnSettings({ saved = null, optionKeys = [], defaultVisibleKeys = [] } = {}) {
  const allKeys = normalizeProductColumnOrder(optionKeys, optionKeys);
  if (saved != null && !(Array.isArray(saved.order) && saved.visible && typeof saved.visible === "object")) {
    console.warn("[product columns] stored column settings refused: not the { order, visible } shape; defaults apply");
  } else if (saved) {
    const order = normalizeProductColumnOrder(allKeys, saved.order);
    const visible = Object.fromEntries(allKeys.map((key) => [key, saved.visible[key] === true]));
    return { schema_version: PRODUCT_COLUMN_SETTINGS_SCHEMA_VERSION, order, visible, source: "user-config" };
  }
  const defaults = new Set(normalizeProductColumnOrder(allKeys, defaultVisibleKeys, { appendMissing: false }));
  const order = normalizeProductColumnOrder(allKeys, defaultVisibleKeys);
  const visible = Object.fromEntries(allKeys.map((key) => [key, defaults.has(key)]));
  return { schema_version: PRODUCT_COLUMN_SETTINGS_SCHEMA_VERSION, order, visible, source: "default-initial" };
}

export function buildProductColumnSettings({ order = [], visible = {}, optionKeys = [] } = {}) {
  const allKeys = normalizeProductColumnOrder(optionKeys, optionKeys);
  const normalizedOrder = normalizeProductColumnOrder(allKeys, order);
  const normalizedVisible = Object.fromEntries(allKeys.map((key) => [key, visible?.[key] === true]));
  return { schema_version: PRODUCT_COLUMN_SETTINGS_SCHEMA_VERSION, order: normalizedOrder, visible: normalizedVisible, source: "user-config" };
}
