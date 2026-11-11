import { numberOrNull } from "../../core/numbers.js";
import { signedValueClass } from "../../core/market_color_policy.js";

/**
 * Account read-model presentation helpers: pure formatting of the figures a view reads. They take the market as an
 * argument and never read page state; the account page remains the sole owner of mode, selection and dirty-view state.
 */
export function createAccountReadViewPresentation() {
  // Every figure is read through numberOrNull: a missing value (null, "", undefined) shows as missing ("--" / "-"),
  // never as a fabricated 0 / $0 / 0.00%.
  const money = (value, market = "台股") => {
    const amount = numberOrNull(value);
    if (amount === null) return "--";
    const digits = market === "美股" ? 2 : 0;
    return amount.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  const price = (value, market = "台股") => {
    const amount = numberOrNull(value);
    if (amount === null) return "--";
    // A trade price as it was struck (decisions.md 美股價格與金額的位數): 美股 2..4 decimals (150.50, 123.4567),
    // 台股 up to 2. Money, fees, tax and P&L are money() -- always 2 decimals in 美股.
    const [minDigits, maxDigits] = market === "美股" ? [2, 4] : [0, 2];
    return amount.toLocaleString("zh-TW", { minimumFractionDigits: minDigits, maximumFractionDigits: maxDigits });
  };
  const signedMoney = (value, market = "台股") => {
    const amount = numberOrNull(value);
    return amount === null ? "--" : money(Math.abs(amount), market);
  };
  const qty = (value) => {
    const amount = numberOrNull(value);
    if (amount === null) return "--";
    return Number.isInteger(amount) ? amount.toLocaleString("zh-TW") : amount.toLocaleString("zh-TW", { maximumFractionDigits: 4 });
  };
  const percent = (value, digits = 2) => {
    const amount = numberOrNull(value);
    return amount === null ? "-" : `${(amount * 100).toFixed(digits)}%`;
  };
  // Unlike percent(), this expects an already-scaled percentage (4 meaning
  // 4%, matching the market-domain pct_chg convention the dashboard's
  // unrealized_pnl_pct field reuses) rather than a raw 0-1 ratio.
  const signedPercent = (value, digits = 2) => {
    const amount = numberOrNull(value);
    return amount === null ? "-" : `${Math.abs(amount).toFixed(digits)}%`;
  };
  const ratio = (value) => {
    const amount = numberOrNull(value);
    return amount === null ? "-" : amount.toFixed(2);
  };
  const metricMoney = (value) => {
    const amount = numberOrNull(value);
    return amount === null ? "-" : money(amount);
  };
  return Object.freeze({ money, price, signedMoney, qty, percent, signedPercent, ratio, metricMoney, profitClass: signedValueClass });
}

/** Shares in one 張 (a board lot). */
export const PAPER_LOT_SHARES = 1000;

/**
 * 模擬帳務's figures (模擬下單's ticket, 模擬帳務's ledger, 委託紀錄): plain numbers up to 2 decimals, "--" when the value
 * is missing or not a number (read through numberOrNull, so true / "" are missing, never 1 / 0).
 */
export function paperMoney(value) {
  const amount = numberOrNull(value);
  return amount === null ? "--" : amount.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
}

/** A signed 模擬帳務 figure: its size only, the direction is the colour (signedValueClass). */
export function paperSignedMoney(value) {
  const amount = numberOrNull(value);
  return amount === null ? "--" : paperMoney(Math.abs(amount));
}

/** 買進 in the up colour, 賣出 in the down colour. */
export function paperSideClass(side) {
  return side === "買進" ? "price-up" : "price-down";
}

/** An order's shares counted in its own unit: 張 for a board-lot order, 股 for 零股 ("odd"); null when missing. */
export function paperOrderUnitCount(lot, shares) {
  const amount = numberOrNull(shares);
  return amount === null || lot === "odd" ? amount : amount / PAPER_LOT_SHARES;
}

/** An order's shares as text in its own unit ("3 張", "500 股"). */
export function paperOrderUnits(lot, shares) {
  return `${paperMoney(paperOrderUnitCount(lot, shares))} ${lot === "odd" ? "股" : "張"}`;
}
