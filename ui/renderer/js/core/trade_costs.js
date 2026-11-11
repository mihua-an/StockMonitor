// The renderer's one trade-cost projection: what a trade not made yet would cost, under the terms the ledger states
// for it (AccountingCore.closing_terms -- a position's or a pair's `closing_terms`, the paper funds' `trade_terms`).
// The rates, minimum, roundings and which tax applies (ETF, 當沖) are the ledger's; this module only applies them.
// Without terms nothing is priced: every function answers null, never a figure at some other rate.

const EPSILON = 1e-9;

function rounded(value, mode) {
  if (mode === "floor") return Math.floor(value + EPSILON);
  if (mode === "ceil") return Math.ceil(value - EPSILON);
  if (mode === "cent") return Math.floor(value * 100 + 0.5 + EPSILON) / 100;
  throw new Error(`unknown rounding ${mode}`);
}

function termsOk(terms) {
  return Boolean(terms) && Number.isFinite(Number(terms.fee_rate)) && Number.isFinite(Number(terms.sell_tax_rate));
}

/** A trade's 價金: `qty` shares at `price`, rounded as the ledger rounds a fill. */
export function tradeAmount(terms, qty, price) {
  if (!termsOk(terms)) return null;
  return rounded(Number(qty) * Number(price), terms.amount_rounding);
}

/** The fee on a trade of `gross`. */
export function tradeFee(terms, gross) {
  if (!termsOk(terms)) return null;
  const amount = Number(gross);
  if (!(amount > 0)) return 0;
  return Math.max(Number(terms.min_fee) || 0, rounded(amount * Number(terms.fee_rate), terms.fee_rounding));
}

/** The tax on a sell of `gross` (a buy pays none). */
export function sellTax(terms, gross) {
  if (!termsOk(terms)) return null;
  const amount = Number(gross);
  if (!(amount > 0)) return 0;
  return rounded(amount * Number(terms.sell_tax_rate), terms.tax_rounding);
}

/** What selling `qty` at `price` brings in: the amount less its fee and tax. */
export function sellProceeds(terms, qty, price) {
  const gross = tradeAmount(terms, qty, price);
  return gross === null ? null : gross - tradeFee(terms, gross) - sellTax(terms, gross);
}

/** What buying `qty` at `price` costs: the amount and its fee. */
export function buyCost(terms, qty, price) {
  const gross = tradeAmount(terms, qty, price);
  return gross === null ? null : gross + tradeFee(terms, gross);
}

/** A realized pair's net profit had it closed at `price` instead (配對回放, 歷史回放's trade review): the side it
 * opened on as the ledger charged it (its amount, fee and, for a short, tax), the closing side priced at `price` under
 * the pair's closing_terms. At the pair's own exit price this is the ledger's profit. Null without a price or terms. */
export function pairNetAtPrice(pair, price) {
  const qty = Number(pair?.qty);
  const mark = Number(price);
  if (!(qty > 0) || !(mark > 0)) return null;
  const terms = pair?.closing_terms;
  if (String(pair?.direction || "").trim() === "空") {
    const close = buyCost(terms, qty, mark);
    const opened = Number(pair?.sell_amount) - Number(pair?.sell_fee) - Number(pair?.tax);
    return close === null || !Number.isFinite(opened) ? null : opened - close;
  }
  const close = sellProceeds(terms, qty, mark);
  const opened = Number(pair?.buy_amount) + Number(pair?.buy_fee);
  return close === null || !Number.isFinite(opened) ? null : close - opened;
}
