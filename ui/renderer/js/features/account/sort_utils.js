/**
 * The comparator every sortable 帳務 table uses (股票統計, 每日明細, 配對明細, 當沖報表): a field's rows ascending or
 * descending, a missing value last in both directions, numbers before text, text numeric-aware (dates, codes, names).
 *
 * Reads no owned state.
 */

// What a field sorts as: a number, non-empty text, or null when it holds neither (a real 0 is a number).
function sortCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : text;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareCells(left, right, direction) {
  const a = sortCell(left);
  const b = sortCell(right);
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const dir = direction === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
  if (typeof a !== typeof b) return (typeof a === "number" ? -1 : 1) * dir;
  return a.localeCompare(b, "zh-TW", { numeric: true, sensitivity: "base" }) * dir;
}

/** Order two rows by `key`; rows equal there keep a fixed order by `tiebreakKey` (ascending in either direction). */
export function compareAccountSortValue(a, b, key, direction, tiebreakKey = null) {
  const order = compareCells(a?.[key], b?.[key], direction);
  return order !== 0 || !tiebreakKey ? order : compareCells(a?.[tiebreakKey], b?.[tiebreakKey], "asc");
}
