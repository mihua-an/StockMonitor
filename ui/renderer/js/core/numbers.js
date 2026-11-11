// The renderer's one reading of a numeric field from data (a service's JSON, a stored record). Every module that
// reads a price, a volume or a sequence uses these, so the same bad value reads the same everywhere:
//   a number          -> itself when finite (0 included); NaN / Infinity -> null
//   a string          -> its number when the whole trimmed text is one ("12.5", "-3", "1e3"); "", "  ", "abc" -> null
//   null / undefined  -> null (missing is never 0)
//   anything else     -> null: a boolean is not a number (Number(true) is 1, which drew a price of 1), nor is an
//                        array, an object or a bigint
// tests/renderer_numbers_contract.mjs is the table of cases.

/** A finite number, or null when the value is missing or not a finite number (see the rules above). */
export function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** A finite number above zero (a price, a volume that must exist), or null. */
export function positiveNumberOrNull(value) {
  const number = numberOrNull(value);
  return number != null && number > 0 ? number : null;
}
