// A ledger's figures as text, on every page that shows one.
import { numberOrNull } from "./numbers.js";

/**
 * 模擬帳務's figures (模擬下單's ticket, 模擬帳務's ledger, 委託紀錄): plain numbers up to 2 decimals, "--" when the value
 * is missing or not a number (read through numberOrNull, so true / "" are missing, never 1 / 0).
 */
export function ledgerMoney(value) {
  const amount = numberOrNull(value);
  return amount === null ? "--" : amount.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
}

/** A signed 模擬帳務 figure: its size only, the direction is the colour (signedValueClass). */
export function ledgerSignedMoney(value) {
  const amount = numberOrNull(value);
  return amount === null ? "--" : ledgerMoney(Math.abs(amount));
}
