// 設定 > 券商: the Shioaji API key pair, kept in Windows Credential Manager by the backend. This page only sends a new
// pair or a clear and shows whether one is stored; the keys are never read back. 清除金鑰 asks once more first.
//
// One controller owns the status and message nodes: every read, save and clear runs through its queue one after
// another, in the order they were asked for. A mutation never draws its own answer as the status; when it ends (done or
// failed, a partial delete also changes what is stored) the controller reads the backend's status again and draws that.
// So the status always shows what the last finished operation left in the store, whatever order the answers arrive in.

import { apiDelete, apiGetOk, apiJsonPut } from "../core/api.js";
import { $ } from "../core/utility.js";
import { inFlight, runSingleFlight, userFacingMessage } from "../core/user_action.js";
import { setNote, setStatus, showToast } from "../core/settings_ui.js";

const CREDENTIALS_PATH = "/api/settings/shioaji/credentials";

// Bumped when the page is shown or left: an operation asked for under an older generation still runs (the user asked
// for it), but draws nothing; the page's own refresh, queued after it, draws the status.
let generation = 0;
let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {
    // not an error: the task reports its own failure and its caller still sees it through `run`; the queue only orders.
  });
  return run;
}

function setMessage(text, isError = false) {
  setNote($("shioajiCredentialsMessage"), text, isError);
}

function drawStatus(payload) {
  const status = $("shioajiCredentialsStatus");
  if (!status) return;
  if (payload?.backend_available === false) {
    setStatus(status, "無法使用", "error");
    setMessage(payload?.backend_error || "Windows Credential Manager 不可用", true);
    return;
  }
  const configured = Boolean(payload?.configured);
  setStatus(status, configured ? "已儲存" : "未設定", configured ? "ok" : "warn");
}

function clearKeyInputs() {
  const apiKey = $("shioajiApiKey");
  const secretKey = $("shioajiSecretKey");
  if (apiKey) apiKey.value = "";
  if (secretKey) secretKey.value = "";
}

async function readStatus(at) {
  try {
    const payload = await apiGetOk(CREDENTIALS_PATH);
    if (at === generation) drawStatus(payload);
  } catch (error) {
    const text = userFacingMessage(error, "讀取 Shioaji 憑證狀態失敗，請稍後再試", { context: "SETTINGS_SHIOAJI_LOAD" });
    if (at !== generation) return;
    setStatus($("shioajiCredentialsStatus"), "讀取失敗", "error");
    setMessage(text, true);
  }
}

// A mutation, then the authoritative status. `send` returns the backend's answer; `report` shows a successful one.
function mutate({ send, report, failure, context }) {
  const at = generation;
  return enqueue(async () => {
    if (at === generation) setMessage("");
    try {
      const result = await send();
      if (!result?.ok) throw new Error(result?.error || failure);
      if (at === generation) {
        clearKeyInputs();
        syncButtons();
        report(result);
      }
    } catch (error) {
      const text = userFacingMessage(error, failure, { context });
      if (at === generation) setMessage(text, true);
    }
    await readStatus(at);
  });
}

function saveCredentials(apiKeyValue, secretKeyValue) {
  return mutate({
    send: async () => {
      if (!apiKeyValue || !secretKeyValue) {
        const missing = new Error("missing API key or secret key");
        missing.userMessage = "API Key 與 Secret Key 都必須輸入";
        throw missing;
      }
      return apiJsonPut(CREDENTIALS_PATH, { api_key: apiKeyValue, secret_key: secretKeyValue });
    },
    report: (result) => {
      if (result.reconnect_ok === false) {
        setMessage(`憑證已儲存，但 Shioaji 重新連線失敗：${result.reconnect_error || "未知錯誤"}`, true);
      } else {
        showToast("金鑰已儲存，正在重新連線");
      }
    },
    failure: "儲存 Shioaji 憑證失敗，請確認輸入後再試",
    context: "SETTINGS_SHIOAJI_SAVE",
  });
}

function clearCredentials() {
  return mutate({
    send: () => apiDelete(CREDENTIALS_PATH),
    report: (result) => {
      if (result.reconnect_ok === false) {
        setMessage(`憑證已清除，但舊的 Shioaji 連線未能中斷：${result.reconnect_error || "未知錯誤"}`, true);
      } else {
        showToast("金鑰已清除");
      }
    },
    failure: "清除 Shioaji 憑證失敗，請稍後再試",
    context: "SETTINGS_SHIOAJI_CLEAR",
  });
}

// The two buttons' one writer of `disabled`: each is pressed again only once its own operation has settled, and
// 儲存並重新連線 only with a new pair typed in (user 11-06: with nothing new there is nothing to save).
function keysTyped() {
  return Boolean($("shioajiApiKey")?.value?.trim() && $("shioajiSecretKey")?.value?.trim());
}

function syncButtons() {
  const save = $("shioajiCredentialsSaveBtn");
  if (save) save.disabled = inFlight(save) || !keysTyped();
  const clear = $("shioajiCredentialsClearBtn");
  if (clear) clear.disabled = inFlight(clear);
}

// One operation per button at a time: a second press while one is out joins it.
function run(button, operation) {
  const flight = runSingleFlight(button, operation);
  syncButtons();
  return flight.finally(syncButtons);
}

export function initShioajiCredentialSettings() {
  generation += 1;
  for (const id of ["shioajiApiKey", "shioajiSecretKey"]) $(id)?.addEventListener("input", syncButtons);
  syncButtons();
  $("shioajiCredentialsSaveBtn")?.addEventListener("click", () => {
    // The keys are taken at the click: a save queued behind a clear sends what was typed, not what is left after it.
    const apiKeyValue = $("shioajiApiKey")?.value?.trim() || "";
    const secretKeyValue = $("shioajiSecretKey")?.value?.trim() || "";
    run($("shioajiCredentialsSaveBtn"), () => saveCredentials(apiKeyValue, secretKeyValue));
  });
  $("shioajiCredentialsClearBtn")?.addEventListener("click", () => {
    window.desktopAPI.confirm("確定要清除永豐 API 金鑰？清除後永豐行情與帳務會中斷，要重新輸入金鑰才能連線。").then((yes) => {
      if (yes) run($("shioajiCredentialsClearBtn"), clearCredentials);
    }).catch((error) => console.warn("[settings: asking before clearing the Shioaji keys] failed", error));
  });
}

export function refreshShioajiCredentialSettings() {
  const at = generation;
  return enqueue(() => readStatus(at));
}

export function disposeShioajiCredentialSettings() {
  generation += 1;
}
