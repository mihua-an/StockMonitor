// User-triggered Google Form submission; no scheduler or process owner. The ledger sync that follows a new trade is
// the trade window's own (/api/actual-account/sync, waited for the server's sync deadline).
const fs = require("node:fs");
const { withTimeout } = require("../../service/platform/js/fetch_timeout");

// The form's address and its field mapping come from the saved account settings, read here with the client
// credential: the renderer sends only the trade, so a page cannot choose where a trade is sent.
const FORM_FIELDS = ["trade_date", "market", "action", "code", "trade_info", "trade_time"];
// The same links api's save_config accepts (service/account/actual_account_sync.py form_prefill_url_problem): a
// prefilled viewform link, or a forms.gle short link that must lead to one.
const FORM_PATH = /^\/forms\/d\/(?:e\/)?[A-Za-z0-9_-]+\/viewform$/;
const FORM_SHORT_PATH = /^\/[A-Za-z0-9_-]+$/;

function plainHttps(url) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash;
}

// fetch: Electron main's authenticated fetch (client_auth.js); urlFor(path): the business API URL of a path.
// unconfirmedPagePath(name): where an answer that is not the confirmation page is kept (the run's log folder).
function createTradeForm({ fetch: transport, urlFor, timeoutMs = 20000, unconfirmedPagePath = null }) {
  async function fetch(url, options) {
    try {
      return await withTimeout(timeoutMs, async (signal) => {
        const response = await transport(url, { ...options, signal });
        const text = await response.text();
        return { ok: response.ok, status: response.status, url: response.url,
          text: async () => text, json: async () => JSON.parse(text) };
      });
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
      // not an error: reported to the form as this timeout
      throw Object.assign(new Error(`no answer within ${timeoutMs} ms`), { reason: "TIMEOUT" });
    }
  }
  // The saved Google Form settings: its prefilled link and the placeholder of each trade field.
  async function readFormSettings() {
    const response = await fetch(urlFor("/api/actual-account/config"), { method: "GET", cache: "no-store" });
    if (!response.ok) throw new Error(`帳務設定讀取失敗：HTTP ${response.status}`);
    const config = await response.json();
    const mapping = Object.fromEntries(FORM_FIELDS.map((key) => [key, String(config?.[`google_form_param_${key}`] || "")]));
    const prefillUrl = String(config?.google_form_prefill_url || "").trim();
    if (!prefillUrl || FORM_FIELDS.some((key) => !mapping[key].trim())) {
      throw new Error("Google Form 尚未設定完成。請先到主 App 的設定頁完成預填連結與對應參數。");
    }
    return { prefillUrl, mapping };
  }

  async function resolveGoogleFormPrefillUrl(prefillUrl) {
    let parsed;
    try {
      parsed = new URL(prefillUrl);
    } catch (_error) {
      throw new Error("Google Form 預填連結格式不正確");
    }

    // 若使用者貼 forms.gle 短網址，先跟隨一次 redirect 取得完整 Google Form URL。
    // 參數對應仍以最後的完整預填 URL 為準。
    if (plainHttps(parsed) && parsed.hostname === "forms.gle" && FORM_SHORT_PATH.test(parsed.pathname) && !parsed.search) {
      const response = await fetch(parsed.toString(), { method: "GET", redirect: "follow" });
      if (!response.ok) throw new Error(`Google Form 短網址解析失敗：HTTP ${response.status}`);
      parsed = new URL(response.url);
    }

    if (!plainHttps(parsed) || parsed.hostname !== "docs.google.com" || !FORM_PATH.test(parsed.pathname)) {
      throw new Error("Google Form 預填連結必須是 https://docs.google.com/forms/d/<表單 ID>/viewform?... 的預填連結");
    }
    return parsed;
  }

  function resolveGoogleFormEntryKey(prefill, marker, label) {
    const token = String(marker || "").trim();
    if (!token) throw new Error(`${label}參數尚未設定`);

    // 也容許進階使用者直接填 entry.123456，除了 placeholder token 外不多做限制。
    if (/^entry\.\d+(?:_[A-Za-z0-9]+)?$/i.test(token)) return token;

    for (const [key, value] of prefill.searchParams.entries()) {
      if (key.startsWith("entry.") && String(value).trim() === token) return key;
    }
    throw new Error(`預填連結找不到「${label}」參數值：${token}`);
  }

  // Google Form 這兩欄是文字欄位，送出前再做一次格式正規化，
  // 避免 renderer 或瀏覽器元件帶入其他日期格式 / 秒數。
  function normalizeGoogleFormTradeDate(value) {
    const text = String(value || "").trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) throw new Error("交易日期格式必須是 YYYY-MM-DD，例如 2026-08-07");

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new Error("交易日期不是有效日期");
    }
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  function normalizeGoogleFormTradeTime(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const digits = text.replace(/\D/g, "");
    if (digits.length !== 4) throw new Error("交易時間請輸入 4 個數字，例如 2211");

    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2, 4));
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error("交易時間不是有效時間，例如最晚為 23:59");
    }
    return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  }

  async function submitGoogleFormTrade(payload) {
    let submitted = false;
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      const trade = body.trade && typeof body.trade === "object" ? body.trade : {};
      const { prefillUrl, mapping } = await readFormSettings();
      const prefill = await resolveGoogleFormPrefillUrl(prefillUrl);

      const keys = {
        trade_date: resolveGoogleFormEntryKey(prefill, mapping.trade_date, "交易日期"),
        market: resolveGoogleFormEntryKey(prefill, mapping.market, "市場"),
        action: resolveGoogleFormEntryKey(prefill, mapping.action, "交易類型"),
        code: resolveGoogleFormEntryKey(prefill, mapping.code, "股號"),
        trade_info: resolveGoogleFormEntryKey(prefill, mapping.trade_info, "交易資訊"),
        trade_time: resolveGoogleFormEntryKey(prefill, mapping.trade_time, "交易時間"),
      };

      const required = ["trade_date", "market", "action", "code", "trade_info"];
      for (const key of required) {
        if (!String(trade[key] || "").trim()) throw new Error(`新增交易缺少 ${key}`);
      }
      if (!["台股", "美股"].includes(String(trade.market))) throw new Error("市場必須是台股或美股");
      if (!["買進", "賣出"].includes(String(trade.action))) throw new Error("交易類型必須是買進或賣出");

      // 保留預填連結裡其他固定的 entry 值；六個 placeholder 欄位再用使用者輸入覆蓋。
      const formBody = new URLSearchParams();
      for (const [key, value] of prefill.searchParams.entries()) {
        if (key.startsWith("entry.")) formBody.append(key, value);
      }
      const normalizedTradeDate = normalizeGoogleFormTradeDate(trade.trade_date);
      const normalizedTradeTime = normalizeGoogleFormTradeTime(trade.trade_time);

      formBody.set(keys.trade_date, normalizedTradeDate);
      formBody.set(keys.market, String(trade.market || ""));
      formBody.set(keys.action, String(trade.action || ""));
      formBody.set(keys.code, String(trade.code || "").trim());
      formBody.set(keys.trade_info, String(trade.trade_info || "").trim());
      // Google Form 的交易時間是「簡答文字」，固定送 HH:MM，例如 21:09。
      formBody.set(keys.trade_time, normalizedTradeTime);

      const responseUrl = new URL(prefill.toString());
      responseUrl.search = "";
      responseUrl.hash = "";
      responseUrl.pathname = responseUrl.pathname.replace(/\/viewform$/, "/formResponse");

      submitted = true;
      const response = await fetch(responseUrl.toString(), {
        method: "POST",
        redirect: "follow",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "StockMonitor-GoogleForm/1.0",
        },
        body: formBody.toString(),
      });

      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { reason: "HTTP_STATUS", detail: { status: response.status } });
      }

      const finalUrl = new URL(response.url);
      const content = await response.text();
      // The confirmation page: the classic page names its message element; the current one has no such class but
      // links "提交其他回應" back to the form with usp=form_confirm. A refused answer (a field that failed the form's
      // validation) is the form again, with neither.
      const detail = {
        status: response.status,
        // Origin and path only: the query of a Google redirect can carry the form's values.
        final_url: `${finalUrl.origin}${finalUrl.pathname}`,
        expected_url: `${responseUrl.origin}${responseUrl.pathname}`,
        marker: /class=["'][^"']*\bfreebirdFormviewerViewResponseConfirmationMessage\b/.test(content),
        another_response_link: /[?&;]usp=form_confirm\b/.test(content),
        body_bytes: content.length,
        title: (/<title[^>]*>([^<]{0,120})/i.exec(content) || [])[1] || null,
      };
      if (detail.final_url !== detail.expected_url || !(detail.marker || detail.another_response_link)) {
        // The page is kept on this machine so the next unrecognized answer can be read; it holds the trade just sent.
        if (unconfirmedPagePath) {
          try {
            const file = unconfirmedPagePath(`google-form-unconfirmed-${Date.now()}.html`);
            fs.writeFileSync(file, content, "utf8");
            detail.saved_page = file;
          } catch (error) {
            console.error(`[GOOGLE FORM] keeping the unrecognized answer page failed: ${error?.message || error}`);
          }
        }
        throw Object.assign(new Error("the answer is not the form's confirmation page"), { reason: "NOT_CONFIRMED", detail });
      }

      return { ok: true, status: response.status };
    } catch (error) {
      const reason = error?.reason || (submitted ? "TRANSPORT" : "INVALID_REQUEST");
      console.error(`[GOOGLE FORM] submit failed: reason=${reason} submitted=${submitted} ${error?.message || error}`
        + (error?.detail ? ` ${JSON.stringify(error.detail)}` : ""));
      return { ok: false, uncertain: submitted, reason, error: error?.message || String(error) };
    }
  }

  return { submitGoogleFormTrade };
}
module.exports = { createTradeForm };
