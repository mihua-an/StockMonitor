// A futures month as Market Runtime, the background list and the WAL name it: its category and delivery month,
// "TXF202611", "CDF202612", "GR1202612" (a category may carry a digit: futures_contracts.py). TXFR1 (the 大盤 台指期
// Quote) is not a month. A stock code starts with a digit, a Futu code has a market prefix: neither matches.
const FUTURES_MONTH = /^([A-Z][A-Z0-9]{1,3})(20\d{2}(?:0[1-9]|1[0-2]))$/;

export function isFuturesMonthSymbol(code) {
  return FUTURES_MONTH.test(String(code || "").trim().toUpperCase());
}

/** "CDF202611" -> { category: "CDF", month: "202611" }; null for anything else. */
export function parseFuturesMonthSymbol(code) {
  const match = FUTURES_MONTH.exec(String(code || "").trim().toUpperCase());
  return match ? { category: match[1], month: match[2] } : null;
}

/** The code a header shows: a futures month by its category (CDF; its month is on the product row), else itself. */
export function futuresDisplayCode(code) {
  const month = parseFuturesMonthSymbol(code);
  return month ? month.category : String(code || "").trim().toUpperCase();
}

/** The market Market Runtime keys a Shioaji code under: a futures month and TXFR1 are FUT, anything else a stock. */
export function shioajiMarketOf(code) {
  return isFuturesMonthSymbol(code) || String(code || "").trim().toUpperCase() === "TXFR1" ? "FUT" : "STK";
}
