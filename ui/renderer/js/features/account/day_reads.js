// 帳務's on-demand ledger reads: one day of one market (每日明細 / 配對明細, `<ledger>/day`), every trade of one
// market (交易資料, `<ledger>/trades`), one stock's realized pairs (個股數據, `<ledger>/pairs`) and one mode's 當沖分析
// (`<ledger>/daytrade-analysis`). The dashboard carries none of these; a view asks when it shows them.
//
// Answers are kept per dashboard: a new dashboard (the ledger changed, the page reloaded, the other ledger) starts
// empty, so what is shown is always the ledger the dashboard describes. A read that failed stays failed for that
// dashboard (shown, recorded) rather than being retried on every render.
import { apiGet } from "../../core/api.js";
import { accountApiPath } from "./account_format.js";
import { account } from "./account_state.js";

const readsByDashboard = new WeakMap();

function readsOfDashboard() {
  const dashboard = account.dashboard;
  if (!dashboard) return null;
  let reads = readsByDashboard.get(dashboard);
  if (!reads) {
    reads = new Map();
    readsByDashboard.set(dashboard, reads);
  }
  return reads;
}

// The read for `key`: { state: "loading" | "ready" | "unavailable" | "failed", data, error }. Every `onSettled`
// given while the read is loading is called once it settles (two views can wait on one day), and only while the same
// dashboard is still shown.
function read(key, path, onSettled) {
  const reads = readsOfDashboard();
  if (!reads) return { state: "loading" };
  const known = reads.get(key);
  if (known) {
    if (known.state === "loading" && onSettled) known.waiting.push(onSettled);
    return known;
  }
  const entry = { state: "loading", data: null, error: "", waiting: onSettled ? [onSettled] : [] };
  reads.set(key, entry);
  const fail = (message) => {
    entry.state = "failed";
    entry.error = message;
    console.error(`[account read] ${path} failed: ${message}`);
  };
  Promise.resolve()
    .then(() => apiGet(accountApiPath(path)))
    .then((answer) => {
      if (answer?.ok === true && answer.available === false) {
        // A ledger awaiting its rebuild answers no pairs: said so, never drawn as zero figures.
        entry.state = "unavailable";
        entry.error = String(answer.ledger_state?.reason || "帳務需要重新計算");
      } else if (answer?.ok === true) {
        entry.state = "ready";
        entry.data = answer;
      } else fail(String(answer?.error || answer?.message || "讀取失敗"));
    }, (error) => fail(String(error?.message || error)))
    .finally(() => {
      const waiting = entry.waiting.splice(0);
      if (readsOfDashboard() !== reads) return;
      for (const settled of waiting) {
        try {
          settled();
        } catch (error) {
          console.error(`[account read] redraw after ${path} failed:`, error);
        }
      }
    });
  return entry;
}

/** One day of `market`: data = { trades, pairs } once ready. */
export function accountDay(market, date, onSettled) {
  const query = `market=${encodeURIComponent(market)}&date=${encodeURIComponent(date)}`;
  return read(`day|${market}|${date}`, `/day?${query}`, onSettled);
}

/** Every trade of `market`, newest first: data = { items } once ready. */
export function marketTrades(market, onSettled) {
  return read(`trades|${market}`, `/trades?market=${encodeURIComponent(market)}`, onSettled);
}

/** `market`'s realized pairs of one stock: data = { items } (analytics rows, newest first) once ready. */
export function stockPairs(market, code, onSettled) {
  const query = `market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}`;
  return read(`pairs|${market}|code|${code}`, `/pairs?${query}`, onSettled);
}

/** `market`'s 當沖分析 in `mode` (overview / long / short), computed by the ledger: data = { summary, mini_report,
 * periods, weekdays, bands, hold_time, entry_time, matrix, top_wins, top_losses, pairs } once ready; every group names
 * its pairs by id. */
export function daytradeAnalysis(market, mode, onSettled) {
  const query = `market=${encodeURIComponent(market)}&mode=${encodeURIComponent(mode)}`;
  return read(`daytrade|${market}|${mode}`, `/daytrade-analysis?${query}`, onSettled);
}

// A trade or a pair the page already read (a row's edit / replay buttons name them by id).
function readyAnswers() {
  return [...(readsOfDashboard()?.values() || [])].filter((entry) => entry.state === "ready").map((entry) => entry.data);
}

export function readTrade(tradeId) {
  const id = String(tradeId);
  for (const data of readyAnswers()) {
    const trade = [...(data.trades || []), ...(data.items || [])].find((item) => String(item.trade_id) === id);
    if (trade) return trade;
  }
  return null;
}

export function readPair(pairId) {
  const id = String(pairId);
  for (const data of readyAnswers()) {
    const pair = (data.pairs || []).find((item) => String(item.id) === id);
    if (pair) return pair;
  }
  return null;
}
