// A trade's stored fills, trade_info: "數量@價格" tokens joined by "_" ("1000@52.3_500@52.4"). The one reader of that
// format: each token keeps its raw text, its parsed numbers and what is wrong with it, and each screen projects the
// shape it needs (the day table draws the valid fills; the editor shows every token as it was stored).

function positiveNumber(text) {
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return value > 0 ? value : null;
}

/**
 * trade_info -> { fills: [{ raw, qtyText, priceText, qty, price, errors }], valid }. qty / price are positive numbers
 * or null; errors names each problem ("qty", "price", "format"); valid is true when every token parsed.
 */
export function parseTradeInfo(text) {
  const fills = String(text ?? "").split("_").map((chunk) => chunk.trim()).filter(Boolean).map((raw) => {
    const parts = raw.split("@");
    const fill = parseTradeFill(parts[0], parts[1]);
    if (parts.length !== 2) fill.errors.unshift("format");
    return { raw, ...fill };
  });
  return { fills, valid: fills.every((fill) => !fill.errors.length) };
}

/** One fill from its two texts (a stored token's halves, or the editor's two inputs): the same rule for both. */
export function parseTradeFill(qtyText, priceText) {
  const qtyTrimmed = String(qtyText ?? "").trim();
  const priceTrimmed = String(priceText ?? "").trim();
  const qty = positiveNumber(qtyTrimmed);
  const price = positiveNumber(priceTrimmed);
  const errors = [];
  if (qty == null) errors.push("qty");
  if (price == null) errors.push("price");
  return { qtyText: qtyTrimmed, priceText: priceTrimmed, qty, price, errors };
}

/** Fills -> trade_info, from the texts the user entered. */
export function formatTradeInfo(fills) {
  return fills.map((fill) => `${fill.qtyText}@${fill.priceText}`).join("_");
}
