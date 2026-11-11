// 設定 > 帳務: the actual-account bridge -- the Google Apps Script (GAS) sheet it syncs from, the Google Form it
// prefills for a new trade, and the phone data it publishes -- with the sync, rebuild and publish actions. The three
// actions can run at the same time (one click each), so each owns its note left of the group's buttons: what is
// running or why it failed; a finished one clears its note and floats its result. A damaged config file has a note of
// its own there too.

import { apiGet, apiJsonPost, apiPost } from "../core/api.js";
import { $ } from "../core/utility.js";
import { inFlight, runSingleFlight, userFacingMessage } from "../core/user_action.js";
import { formatLastSync } from "../features/account/last_sync_format.js";
import { accountSyncDeadlineMs } from "../features/account/account_sync_deadline.js";
import { setNote, setStatus, showToast } from "../core/settings_ui.js";
import { createExpandMotion } from "../core/expand_motion.js";

let generation = 0;
let editing = false;
let snapshot = null;
let formOpen = false;

// The Google Form fields: config key -> input id.
const FORM_FIELDS = {
  google_form_prefill_url: "actualAccountSettingsFormPrefillUrl",
  google_form_param_trade_date: "actualAccountSettingsFormParamDate",
  google_form_param_market: "actualAccountSettingsFormParamMarket",
  google_form_param_action: "actualAccountSettingsFormParamAction",
  google_form_param_code: "actualAccountSettingsFormParamCode",
  google_form_param_trade_info: "actualAccountSettingsFormParamInfo",
  google_form_param_trade_time: "actualAccountSettingsFormParamTime",
};

// One note per owner; an action writes only its own, so it never hides another action that is still running.
const NOTE_IDS = {
  config: "actualAccountSettingsMessage",
  sync: "actualAccountSyncMessage",
  publish: "actualAccountMobilePublishMessage",
  rebuild: "actualAccountRebuildMessage",
};

function setActionNote(owner, text, isError = false) {
  setNote($(NOTE_IDS[owner]), text, isError);
}

// A damaged config file loads as defaults; say so instead of looking "not configured", until a load or save is clean.
function showConfigProblem(config) {
  const problem = config?.config_error || "";
  setActionNote("config", problem ? `${problem}。重新儲存設定即可覆寫。` : "", Boolean(problem));
}

function setEditMessage(text, isError = false) {
  setNote($("actualAccountSettingsEditMessage"), text, isError);
}

// Google Form 新增交易 opens under its row (the group stays in the page, shown or hidden).
const FORM_KEY = "google-form";
const formMotion = createExpandMotion({ find: () => $("actualAccountSettingsFormGroup"), redraw: () => drawForm() });

function drawForm() {
  const group = $("actualAccountSettingsFormGroup");
  if (group) group.hidden = !(formOpen || formMotion.closing(FORM_KEY));
  const toggle = $("actualAccountSettingsFormToggle");
  toggle?.setAttribute("aria-expanded", String(formOpen));
  const chevron = $("actualAccountSettingsFormChevron");
  if (chevron) chevron.textContent = formOpen ? "⌄" : "›";
}

function toggleForm() {
  if (!formMotion.start(FORM_KEY, !formOpen)) return;
  formOpen = !formOpen;
  drawForm();
  formMotion.play();
}

function applyConfig(config) {
  snapshot = {
    gas_url: config?.gas_url || "",
    has_token: Boolean(config?.has_token),
    auto_sync_on_page_open: Boolean(config?.auto_sync_on_page_open),
    ...Object.fromEntries(Object.keys(FORM_FIELDS).map((key) => [key, config?.[key] || ""])),
  };

  const url = $("actualAccountSettingsGasUrl");
  const token = $("actualAccountSettingsGasToken");
  const autoSync = $("actualAccountSettingsAutoSync");
  const status = $("actualAccountSettingsStatus");
  const formStatus = $("actualAccountSettingsFormStatus");

  if (url) url.value = snapshot.gas_url;
  if (token) {
    token.value = "";
    token.placeholder = snapshot.has_token ? "已設定；留空可保留" : "未設定";
  }
  if (autoSync) autoSync.checked = snapshot.auto_sync_on_page_open;
  for (const [key, id] of Object.entries(FORM_FIELDS)) {
    const field = $(id);
    if (field) field.value = snapshot[key];
  }
  if (status) {
    const configured = Boolean(snapshot.gas_url);
    const ready = configured && snapshot.has_token;
    setStatus(status, ready ? "已設定" : configured ? "缺少 GAS Token" : "尚未設定", ready ? "ok" : "warn");
  }
  if (formStatus) {
    const configured = Object.keys(FORM_FIELDS).every((key) => Boolean(snapshot[key]));
    setStatus(formStatus, configured ? "已設定" : "尚未設定", configured ? "ok" : "warn");
  }
}

function setEditMode(next) {
  editing = Boolean(next);
  const url = $("actualAccountSettingsGasUrl");
  const editBtn = $("actualAccountSettingsEditBtn");
  const actions = $("actualAccountSettingsEditActions");
  for (const id of ["actualAccountSettingsGasUrl", "actualAccountSettingsGasToken", "actualAccountSettingsAutoSync", ...Object.values(FORM_FIELDS)]) {
    const field = $(id);
    if (field) field.disabled = !editing;
  }
  if (editBtn) editBtn.hidden = editing;
  if (actions) actions.hidden = !editing;
  if (editing) url?.focus();
}

// ---- phone data (mobile_api.py bundle published to GAS)
function formatPublishTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-TW", { hour12: false });
}

function applyMobilePublishStatus(status) {
  const el = $("actualAccountMobilePublishStatus");
  if (!el) return;
  const last = formatPublishTime(status?.last_publish_at);
  const parts = [last ? `已上傳 ${last}` : "尚未上傳"];
  if (status?.last_publish_error) parts.push(`上次失敗：${status.last_publish_error}`);
  if (status?.scheduled && status?.due_at) parts.push(`預計 ${formatPublishTime(status.due_at)} 自動上傳`);
  el.textContent = parts.join("｜");
  el.classList.toggle("is-error", Boolean(status?.last_publish_error));
}

async function loadMobilePublishStatus(at = generation) {
  try {
    const payload = await apiGet("/api/actual-account/bridge/status");
    if (at === generation) applyMobilePublishStatus(payload?.mobile_publish);
  } catch (error) { console.warn("[reading the mobile publish status] failed", error);
    if (at === generation) applyMobilePublishStatus(null);
  }
}

async function publishMobileDataNow() {
  setActionNote("publish", "正在上傳手機資料…");
  let result;
  try {
    result = await apiPost("/api/actual-account/mobile-publish/now");
  } finally {
    void loadMobilePublishStatus();
  }
  if (!result?.ok) throw new Error(result?.error || "上傳失敗");
  setActionNote("publish", "");
  showToast(`手機資料已上傳（${result.entry_count ?? 0} 份）`);
}

async function loadActualAccountSyncStatus(at = generation) {
  const el = $("actualAccountSettingsLastSync");
  if (!el) return;
  try {
    const status = await apiGet("/api/actual-account/status");
    if (at !== generation) return;
    el.textContent = formatLastSync(status);
  } catch (error) { console.warn("[reading the account sync status] failed", error);
    if (at === generation) el.textContent = "";
  }
}

function cancelEdit() {
  applyConfig(snapshot || {});
  setEditMessage("");
  setEditMode(false);
}

async function saveActualAccountSettings() {
  const body = {
    gas_url: $("actualAccountSettingsGasUrl")?.value?.trim() || "",
    gas_token: $("actualAccountSettingsGasToken")?.value?.trim() || "",
    auto_sync_on_page_open: Boolean($("actualAccountSettingsAutoSync")?.checked),
    ...Object.fromEntries(Object.entries(FORM_FIELDS).map(([key, id]) => [key, $(id)?.value?.trim() || ""])),
  };

  const result = await apiJsonPost("/api/actual-account/config", body);
  if (!result?.ok) throw new Error(result?.error || "儲存失敗");

  applyConfig(result);
  showConfigProblem(result);
  setEditMode(false);
  setEditMessage("");
  showToast("GAS 連線設定已儲存");
}

async function syncActualAccountNow() {
  setActionNote("sync", "正在同步 Google Sheet…");
  let result;
  try {
    result = await apiPost("/api/actual-account/sync", { timeoutMs: await accountSyncDeadlineMs() });
  } finally {
    void loadActualAccountSyncStatus();
  }
  if (!result?.ok) throw new Error(result?.error || "同步失敗");
  setActionNote("sync", "");
  showToast(`同步完成：${result.remote_rows ?? 0} 筆原始交易`);
}

async function rebuildActualAccountNow() {
  setActionNote("rebuild", "正在重新計算…");
  const result = await apiPost("/api/actual-account/rebuild");
  if (!result?.ok) throw new Error(result?.error || "重新計算失敗");
  setActionNote("rebuild", "");
  showToast(`重新計算完成：${result.realized_matches ?? 0} 筆已實現配對`);
}

export function initActualAccountSettings() {
  generation += 1;
  setEditMode(false);
  formOpen = false;
  drawForm();
  $("actualAccountSettingsFormToggle")?.addEventListener("click", toggleForm);
  $("actualAccountSettingsEditBtn")?.addEventListener("click", () => {
    setEditMessage("");
    setEditMode(true);
  });
  $("actualAccountSettingsSyncBtn")?.addEventListener("click", () => {
    runAction("actualAccountSettingsSyncBtn", syncActualAccountNow)
      .catch((error) => setActionNote("sync", userFacingMessage(error, "同步實際帳務失敗，請稍後再試", { context: "SETTINGS_ACCOUNT_SYNC" }), true));
  });
  $("actualAccountMobilePublishBtn")?.addEventListener("click", () => {
    runAction("actualAccountMobilePublishBtn", publishMobileDataNow)
      .catch((error) => setActionNote("publish", userFacingMessage(error, "上傳手機資料失敗，請稍後再試", { context: "SETTINGS_MOBILE_PUBLISH" }), true));
  });
  $("actualAccountSettingsRebuildBtn")?.addEventListener("click", () => {
    runAction("actualAccountSettingsRebuildBtn", rebuildActualAccountNow)
      .catch((error) => setActionNote("rebuild", userFacingMessage(error, "重新計算實際帳務失敗，請稍後再試", { context: "SETTINGS_ACCOUNT_REBUILD" }), true));
  });
  $("actualAccountSettingsCancelBtn")?.addEventListener("click", cancelEdit);
  $("actualAccountSettingsSaveBtn")?.addEventListener("click", () => {
    setEditMessage("");
    runAction("actualAccountSettingsSaveBtn", saveActualAccountSettings)
      .catch((error) => setEditMessage(userFacingMessage(error, "儲存實際帳務設定失敗，請稍後再試", { context: "SETTINGS_ACCOUNT_SAVE" }), true));
  });
}

const ACTION_BUTTONS = ["actualAccountSettingsSyncBtn", "actualAccountMobilePublishBtn", "actualAccountSettingsRebuildBtn", "actualAccountSettingsSaveBtn"];

// The action buttons' one writer of `disabled`: each is pressed again only once its own operation has settled.
function syncActionButtons() {
  for (const id of ACTION_BUTTONS) {
    const button = $(id);
    if (button) button.disabled = inFlight(button);
  }
}

// One operation per button at a time: a second press while one is out joins it.
function runAction(id, operation) {
  const flight = runSingleFlight($(id), operation);
  syncActionButtons();
  return flight.finally(syncActionButtons);
}

export async function refreshActualAccountSettings() {
  const at = ++generation;
  try {
    const config = await apiGet("/api/actual-account/config");
    if (at !== generation) return;
    applyConfig(config);
    setEditMode(false);
    showConfigProblem(config);
    void loadActualAccountSyncStatus(at);
    void loadMobilePublishStatus(at);
  } catch (error) {
    const text = userFacingMessage(error, "讀取帳務設定失敗，請稍後再試", { context: "SETTINGS_ACCOUNT_LOAD" });
    if (at === generation) setActionNote("config", text, true);
  }
}

export function disposeActualAccountSettings() {
  generation += 1;
  editing = false;
}
