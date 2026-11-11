// First: every later warning and error is recorded as text (js/core/console_relay.js).
import "./js/core/console_relay.js";
import { apiGet, apiJsonPost, apiPost } from "./js/core/api.js";
import { userFacingMessage } from "./js/core/user_action.js";
import { TradeEditor } from "./js/features/account/trade_editor_form.js";
import { accountSyncDeadlineMs } from "./js/features/account/account_sync_deadline.js";

// The standalone trade window: the shared TradeEditor form (window variant) whose new trades go to the Google Form
// and whose edits / deletes go to the actual ledger, then tell the main window.

let editor = null;
// The payload the form shows: mode, action, the trade to edit, and the market a new trade starts with.
let currentPayload = {};
let submissionUncertain = false;

let fitFrame = 0;
function scheduleFitWindow() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitFrame = requestAnimationFrame(() => {
      const shell = document.querySelector(".trade-window-shell");
      if (!shell || !window.desktopAPI?.fitTradeWindow) return;
      const rect = shell.getBoundingClientRect();
      const width = Math.ceil(Math.max(rect.width, shell.scrollWidth));
      const height = Math.ceil(Math.max(rect.height, shell.scrollHeight));
      window.desktopAPI.fitTradeWindow({ width, height }).catch((error) => console.warn("[trade window: fitting the window] failed", error));
    });
  });
}

function setMessage(text = "", isError = false) { editor?.setMessage(text, isError); }

// A ledger change that ran out of time may still have been applied by the server: the user is told to check before
// repeating it (core/api.js aborts the request at its deadline).
async function ledgerWrite(path, body) {
  try {
    return await apiJsonPost(path, body);
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    throw Object.assign(new Error(`request deadline exceeded: ${path}`, { cause: error }), {
      userMessage: "請求逾時；如已送出修改，請先核對帳務結果",
    });
  }
}


async function getGoogleFormConfig() {
  const config = await apiGet("/api/actual-account/config");
  if (config?.ok === false) throw new Error(config.error || "帳務設定讀取失敗");
  const ok = Boolean(
    config?.google_form_prefill_url
    && config?.google_form_param_trade_date
    && config?.google_form_param_market
    && config?.google_form_param_action
    && config?.google_form_param_code
    && config?.google_form_param_trade_info
    && config?.google_form_param_trade_time
  );
  if (!ok) throw new Error("Google Form 尚未設定完成。請先到主 App 的設定頁完成預填連結與對應參數。");
  return config;
}

// Why a sent form's outcome is unknown (ui/main/trade_form.js `reason`); each says to check before sending again.
const UNCERTAIN_MESSAGES = {
  TIMEOUT: "Google Form 逾時沒有回應，結果待確認；請先核對帳務再操作",
  HTTP_STATUS: "Google Form 回應錯誤狀態，結果待確認；請先核對帳務再操作",
  NOT_CONFIRMED: "已送出但沒有收到 Google Form 確認頁，結果待確認；請先核對帳務再操作",
  TRANSPORT: "Google Form 連線中斷，結果待確認；請先核對帳務再操作",
};

async function submitAddTrade(body) {
  setMessage("正在送出 Google Form…");
  const config = await getGoogleFormConfig();
  if (!window.desktopAPI?.submitGoogleFormTrade) throw new Error("Electron 交易送出功能尚未載入，請重新啟動 App");
  const result = await window.desktopAPI.submitGoogleFormTrade({
    prefill_url: config.google_form_prefill_url,
    mapping: {
      trade_date: config.google_form_param_trade_date,
      market: config.google_form_param_market,
      action: config.google_form_param_action,
      code: config.google_form_param_code,
      trade_info: config.google_form_param_trade_info,
      trade_time: config.google_form_param_trade_time,
    },
    trade: body,
  });
  if (!result?.ok) {
    submissionUncertain = Boolean(result?.uncertain);
    throw Object.assign(new Error(result?.error || "Google Form submit failed"), {
      userMessage: submissionUncertain
        ? (UNCERTAIN_MESSAGES[result?.reason] || UNCERTAIN_MESSAGES.TRANSPORT)
        : "Google Form 送出失敗，請稍後再試",
    });
  }
  editor.reset({ preserveDateMarket: true, action: currentPayload.action });
  setMessage("已送出，可繼續輸入下一筆（帳務背景同步中）");
  syncAfterAdd(config).then(() => setMessage("交易已送出，帳務同步完成")).catch((error) => {
    console.warn("[syncing the account after adding a trade] failed", error);
    return setMessage("交易已送出，但背景同步失敗；請到帳務頁重新同步，勿重送交易", true);
  });
  editor.focusFirst("Action");
}

// The ledger catches up with the sheet after a new trade: the account page's sync, waited for as long as the server
// says one can take (account_sync_deadline.js) -- a fixed 20 s reported a sync of ~22 s as failed while it completed.
// The phone publish is scheduled with it, and the main window refreshes once the ledger has the trade.
async function syncAfterAdd(config) {
  apiPost("/api/actual-account/mobile-publish/schedule")
    .catch((error) => console.warn("[trade window: scheduling the phone publish] failed", error));
  const result = await apiPost("/api/actual-account/sync", { timeoutMs: await accountSyncDeadlineMs(config) });
  if (!result?.ok) throw new Error(result?.error || "同步失敗");
  await window.desktopAPI?.notifyTradeWindowChanged?.({ kind: "add-synced" });
}

async function submitEditTrade(body) {
  setMessage("正在修改 Google Sheet…");
  const result = await ledgerWrite("/api/actual-account/trade/save", body);
  if (!result?.ok) throw new Error(result?.error || "交易儲存失敗");
  await window.desktopAPI?.notifyTradeWindowChanged?.({ kind: "edit", trade_id: body.trade_id });
  setMessage("交易已修改並重新計算");
  setTimeout(() => window.desktopAPI?.closeTradeWindow?.(), 180);
}

const windowAdapter = {
  // The main window decides it from Rust A's US session (trade_entry.js) and sends it with the payload.
  defaultMarket: () => currentPayload.market,
  knownName: () => "",
  // The window shows no title of its own: only the operating system's window title.
  onTitle({ mode, code, name, action }) {
    const detail = mode === "edit" && code ? `｜${code}${name ? ` ${name}` : ""} ${action}` : "";
    document.title = `${mode === "edit" ? "修改交易" : "新增交易"}${detail}`;
  },
  async beforeSubmit() {
    if (!submissionUncertain) return true;
    if (!(await window.desktopAPI.confirm("上筆交易結果待確認。請先核對 Google Form 回覆及帳務，確認未新增後才繼續送出。已確認未新增？"))) return false;
    submissionUncertain = false;
    return true;
  },
  submit: (body, { mode }) => (mode === "edit" ? submitEditTrade(body) : submitAddTrade(body)),
  async remove(tradeId) {
    if (!(await window.desktopAPI.confirm("確定要直接刪除這筆 Google Sheet 交易嗎？"))) return;
    setMessage("正在刪除 Google Sheet 交易…");
    const result = await ledgerWrite("/api/actual-account/trade/delete", { trade_id: tradeId });
    if (!result?.ok) throw new Error(result?.error || "刪除失敗");
    await window.desktopAPI?.notifyTradeWindowChanged?.({ kind: "delete", trade_id: tradeId });
    window.desktopAPI?.closeTradeWindow?.();
  },
  close: () => window.desktopAPI?.closeTradeWindow?.(),
  reportError(error, kind) {
    setMessage(kind === "delete"
      ? userFacingMessage(error, "刪除交易失敗，請稍後再試", { context: "TRADE_WINDOW_DELETE" })
      : userFacingMessage(error, "交易儲存失敗，請確認內容後再試", { context: "TRADE_WINDOW_SAVE" }), true);
  },
  layoutChanged: scheduleFitWindow,
};

function mountEditor() {
  if (!editor) editor = new TradeEditor({ host: document.querySelector(".trade-window-shell"), idPrefix: "tradeWindow", variant: "window", adapter: windowAdapter });
  return editor;
}

// Each payload is applied from its own value. Answers whether it was applied.
function applyPayload(payload = {}) {
  const next = payload && typeof payload === "object" ? payload : {};
  mountEditor();
  currentPayload = next;
  if (next.mode === "edit") editor.load(next.trade || {});
  else editor.reset({ action: next.action });
  editor.focusFirst();
  scheduleFitWindow();
  return true;
}

function submitTrade() { return mountEditor().submit(); }

window.addEventListener("DOMContentLoaded", () => {
  mountEditor();
  const shell = document.querySelector(".trade-window-shell");
  if (shell && typeof ResizeObserver === "function") new ResizeObserver(() => scheduleFitWindow()).observe(shell);
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") window.desktopAPI?.closeTradeWindow?.(); });
  window.desktopAPI?.onTradeWindowPayload?.((payload) => {
    try { applyPayload(payload); } catch (error) { console.error("[trade window: applying a payload] failed", { mode: payload?.mode || "add" }, error); }
  });
  scheduleFitWindow();
});

// Test-only surface: this file has no other module consumer -- trade_window.html loads it as the page's own
// script -- so these exports exist for a Node test harness to drive the real submit / payload flow.
export { submitTrade, applyPayload };
