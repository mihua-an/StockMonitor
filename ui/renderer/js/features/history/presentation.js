/** Pure formatting policies shared by history replay views. 歷史回放 replays 台股 only. */
import { numberOrNull } from "../../core/numbers.js";

/** A 台股 trade price on the replay chart's marker: up to 2 decimals, "--" when missing (never 0). */
export function historyTradePriceText(value) {
  const number = numberOrNull(value);
  return number === null ? "--" : number.toLocaleString("zh-TW", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
