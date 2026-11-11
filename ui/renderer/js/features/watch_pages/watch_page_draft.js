// The watch pages editor's draft: pure rules over pages { id, name, source, market, items }. `items` is the only
// shape (an item is { code, name, industry_name, market, type, source, lower_alert, upper_alert }); a code list is
// derived where one is needed. Every operation returns new values and never changes its input.

export function canonicalSource(value) {
  return String(value || "").trim().toLowerCase() === "futu" ? "futu" : "shioaji";
}

export function alertValue(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  const n = Number(raw);
  return Number.isFinite(n) ? String(raw) : "";
}

/** One item from the store or the catalog; null (recorded) when it is not an object with a code. */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") {
    if (raw != null) console.warn("[watch pages] item refused: not an object with a code", raw);
    return null;
  }
  const code = String(raw.code || "").trim().toUpperCase();
  if (!code) return null;
  return {
    code,
    name: String(raw.name || "").trim(),
    industry_name: String(raw.industry_name || raw.industry || "").trim(),
    market: String(raw.market || "").trim().toLowerCase(),
    type: String(raw.type || raw.security_type || "").trim().toLowerCase(),
    source: canonicalSource(raw.source),
    lower_alert: alertValue(raw.lower_alert),
    upper_alert: alertValue(raw.upper_alert),
  };
}

function uniqueItems(rawItems) {
  const seen = new Set();
  const items = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const item = normalizeItem(raw);
    if (!item || seen.has(item.code)) continue;
    seen.add(item.code);
    items.push(item);
  }
  return items;
}

export function normalizePage(raw = {}) {
  const source = canonicalSource(raw.source);
  return {
    id: String(raw.id || ""),
    name: String(raw.name || ""),
    source,
    market: source === "futu" ? "us" : "tw",
    items: uniqueItems(raw.items),
  };
}

export function normalizePages(rawPages) {
  return (Array.isArray(rawPages) ? rawPages : []).map(normalizePage);
}

export function pageCodes(page) {
  return (page?.items || []).map((item) => item.code);
}

/** `list` with the element at `from` moved to `to`; the same list when either index is out of range or equal. */
export function moveInList(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function moveItem(page, from, to) {
  const items = moveInList(page.items, from, to);
  return items === page.items ? page : { ...page, items };
}

export function removeItemAt(page, index) {
  if (index < 0 || index >= page.items.length) return page;
  return { ...page, items: page.items.filter((_, i) => i !== index) };
}

/** The catalog's non-empty fields over the item's; the item's own alerts are kept. */
export function mergeItemMetadata(item, meta) {
  return {
    ...item,
    ...Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== "")),
    lower_alert: item.lower_alert,
    upper_alert: item.upper_alert,
  };
}

/** Adds `item`, or refreshes the existing one's metadata. Answers { page, added }. */
export function addOrMergeItem(page, item) {
  if (!page.items.some((row) => row.code === item.code)) return { page: { ...page, items: [...page.items, item] }, added: true };
  return { page: { ...page, items: page.items.map((row) => (row.code === item.code ? mergeItemMetadata(row, item) : row)) }, added: false };
}

/** The page with each item's metadata refreshed from the search results that list it. */
export function enrichPage(page, searchItems) {
  const byCode = new Map((searchItems || []).map((item) => normalizeItem(item)).filter(Boolean).map((item) => [item.code, item]));
  return { ...page, items: page.items.map((item) => (byCode.has(item.code) ? mergeItemMetadata(item, byCode.get(item.code)) : item)) };
}

/** Every page's items of `code` with the alert `key` ("lower_alert" | "upper_alert") set to `value`. */
export function setAlert(pages, code, key, value) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const normalizedValue = alertValue(value);
  return pages.map((page) => (page.items.some((item) => item.code === normalizedCode)
    ? { ...page, items: page.items.map((item) => (item.code === normalizedCode ? { ...item, [key]: normalizedValue } : item)) }
    : page));
}
