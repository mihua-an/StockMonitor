// 帳務 交易編輯: the 帳務 page's edit trade modal -- the shared TradeEditor form (trade_editor_form.js) with this
// page's data: the account's market, the names its analytics know, the actual / paper ledger API, and the page's
// refresh after a change. It only edits a listed trade: an actual-ledger edit opens the standalone trade window
// instead, an actual trade is added through the dock's 新增交易, and a paper trade comes only from 即時報價's 下單.
import { apiJsonPost } from "../../core/api.js";
import { userFacingMessage } from "../../core/user_action.js";
import { $ } from "../../core/utility.js";
import { accountApiPath, accountStorageKey, currentAnalytics, isPaperWalletMode, ledgerMarkets, setMessage } from "./account_format.js";
import { account, accountHooks } from "./account_state.js";
import { TradeEditor } from "./trade_editor_form.js";

export { tradeInfoToFillRows } from "./trade_editor_form.js";

let editor = null;

function knownTradeName(code) {
  const key = String(code || "").trim().toUpperCase();
  if (!key) return "";
  const analytics = currentAnalytics();
  const stock = (Array.isArray(analytics?.stock_stats) ? analytics.stock_stats : [])
    .find((item) => String(item?.code || "").trim().toUpperCase() === key);
  if (stock?.name) return String(stock.name);
  const trade = (Array.isArray(account.dashboard?.raw_trades) ? account.dashboard.raw_trades : [])
    .find((item) => String(item?.code || "").trim().toUpperCase() === key && item?.name);
  return trade?.name ? String(trade.name) : "";
}

const modalAdapter = {
  // A new trade starts in the market the page shows.
  defaultMarket: () => account.market,
  markets: ledgerMarkets,
  knownName: knownTradeName,
  onTitle({ code, name }) {
    const title = $("actualTradeEditorTitle");
    if (!title) return;
    if (code) title.textContent = `${code}${name ? ` ${name}` : ""}`;
    else title.textContent = "編輯交易";
  },
  async submit(body) {
    setMessage(isPaperWalletMode() ? (body.trade_id ? "正在修改本機模擬交易…" : "正在新增本機模擬交易…") : (body.trade_id ? "正在修改 Google Sheet…" : "正在新增至 Google Sheet…"));
    const result = await apiJsonPost(accountApiPath("/trade/save"), body);
    if (!result?.ok) throw new Error(result?.error || "交易儲存失敗");
    account.market = body.market === "美股" ? "美股" : "台股";
    localStorage.setItem(accountStorageKey("market"), account.market);
    closeTradeModal();
    setMessage(body.trade_id ? "交易已修改並重新計算" : "交易已新增並重新計算");
    await accountHooks.refreshAfterChange();
  },
  async remove(tradeId) {
    if (!(await window.desktopAPI.confirm(isPaperWalletMode() ? "確定要刪除這筆本機模擬交易嗎？" : "確定要直接刪除這筆 Google Sheet 交易嗎？"))) return;
    const result = await apiJsonPost(accountApiPath("/trade/delete"), { trade_id: tradeId });
    if (!result?.ok) throw new Error(result?.error || "刪除失敗");
    closeTradeModal();
    setMessage("交易已刪除並重新計算");
    await accountHooks.refreshAfterChange();
  },
  close: () => closeTradeModal(),
  reportError(error, kind) {
    setMessage(kind === "delete"
      ? userFacingMessage(error, "刪除交易失敗，請稍後再試", { context: "ACCOUNT_TRADE_DELETE" })
      : userFacingMessage(error, "儲存交易失敗，請確認內容後再試", { context: "ACCOUNT_TRADE_SAVE" }), true);
  },
};

/** Builds the modal's form once (into the page's #actualTradeModal); later calls keep it. */
export function mountTradeEditor() {
  const host = $("actualTradeModal");
  if (!host) return;
  if (!editor || editor.host !== host || !host.contains(editor.el("SubmitBtn"))) {
    editor?.dispose();
    editor = new TradeEditor({ host, idPrefix: "actualTrade", variant: "modal", adapter: modalAdapter });
  }
  editor.reset();
}

function openTradeModal() {
  const modal = $("actualTradeModal");
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  editor?.focusFirst("Code");
}

export function closeTradeModal() {
  const modal = $("actualTradeModal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
}

export function isTradeModalOpen() {
  const modal = $("actualTradeModal");
  return Boolean(modal && !modal.hidden);
}

export function loadTradeIntoEditor(trade) {
  // An actual-ledger edit is the standalone trade window (an Electron BrowserWindow); the paper ledger edits here.
  if (!isPaperWalletMode() && window.desktopAPI?.openTradeWindow) {
    window.desktopAPI.openTradeWindow({
      mode: "edit",
      trade: trade && typeof trade === "object" ? { ...trade } : {},
    }).catch((error) => setMessage(userFacingMessage(error, "無法開啟修改交易視窗，請稍後再試", { context: "ACCOUNT_OPEN_TRADE_WINDOW" }), true));
    return;
  }
  if (!editor) return;
  editor.load(trade || {});
  openTradeModal();
}
