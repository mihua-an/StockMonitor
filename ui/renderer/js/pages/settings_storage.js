// 設定 → 資料儲存: how much raw history (tick / bidask partitions) each source keeps, and where everything that grows
// without bound lives (the storage location: raw history, B's rule events, the model datasets and registry).
//
// Four settings_api domains: `storage_retention` (config/storage_settings.py) takes effect on save (Market Runtime
// applies it at its next prune -- each pre-open and once a minute); `training_data` (config/training_data_settings.py:
// how long the derived training data is kept, how many trading dates a training run uses) takes effect at the next
// training run; `kbar_retention` (config/kbar_retention_settings.py: how many months each intraday K timeframe is kept)
// takes effect at the next close-of-day materialization; `query_cache` (config/query_cache_settings.py: how many days a
// closed session fetched for a view stays on disk) at the next session's materialization; `storage_location` is saved as the desired folder: Health copies the stored data there while the App runs (on another drive) and switches at a
// full start. Each saves with expected_revision, so a second window's change is a conflict, never silently overwritten.
// The location is changed only by choosing a folder (or 改回預設): one row with its path, and a line under it only
// while the chosen or saved folder is not the one in use, with the copy's progress (polled while there is one).

import { apiGet } from "../core/api.js";
import { $, escapeHtml } from "../core/utility.js";
import { morphInto } from "../core/dom_morph.js";
import { middleEllipsis, setNote, showToast } from "../core/settings_ui.js";
import { saveVersionedSetting } from "../core/settings_write.js";
import { gbText } from "../core/diagnostics_format.js";

const SOURCES = [
  { id: "shioaji", label: "Shioaji", markets: "台股、台指期" },
  { id: "futu", label: "Futu", markets: "美股" },
];
// Shioaji's 要儲存哪些 (config/storage_settings.py CATEGORIES): one row per group, a pill per kind of data.
const KEEP_ROWS = [
  { label: "大盤", pills: [["index", "指數"]] },
  { label: "台指", pills: [["txf_near", "近月"], ["txf_far", "遠月"]] },
  { label: "個股", pills: [["stock", "現貨"]] },
];
const KEEP_CATEGORIES = KEEP_ROWS.flatMap((row) => row.pills.map(([id]) => id));
// 個股期貨 is never kept (docs/decisions.md 哪些行情會留在本地): no pill, every save names it not kept.
const NEVER_KEPT = { stock_futures: false };
const DAY_OPTIONS = [1, 2, 3, 5, 10, 20, 60, 120, 250];
const TRAINING_RETENTION_OPTIONS = [20, 60, 120, 250, 500, 1000];
const TRAINING_WINDOW_OPTIONS = [3, 5, 10, 20, 40, 60, 120, 250];
const QUERY_CACHE_OPTIONS = [1, 3, 5, 7, 14, 30, 60, 90];
const FOREVER = "forever";
const LOCATION_POLL_MS = 2000;
// The stored K timeframes (config/system_contract.json kbar_retention_months). 3 minutes is read from the 1-minute rows,
// so the two share one row.
const KBAR_TIERS = [["1", "1、3 分 K"], ["5", "5 分 K"], ["15", "15 分 K"], ["30", "30 分 K"], ["60", "60 分 K"]];
const KBAR_MONTH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18, 24, 36, 60, 120];

let generation = 0;
let retention = null;   // GET /api/config/storage_retention
let training = null;    // GET /api/config/training_data
let location = null;    // GET /api/config/storage_location
let kbar = null;        // GET /api/config/kbar_retention
let queryCache = null;  // GET /api/config/query_cache
let closingData = null;  // GET /api/config/closing_data
let draft = null;
let locationPoll = null;

// Every failure this page shows is also a record (the window's console warnings land in the run's error.log), named by
// the operation and the path it used.
function recordFailure(operation, target, detail) {
  console.warn(`[settings/storage: ${operation} ${target}] failed`, detail);
}

// An error stays left of 儲存 until the next save; a success floats.
function setMessage(text, isError = false) {
  setNote($("storageMessage"), text, isError);
}

function valuesOf(payload) {
  return payload?.latest?.values || {};
}

function savedDraft() {
  const sources = valuesOf(retention).sources || {};
  return {
    sources: Object.fromEntries(SOURCES.map(({ id }) => [id, {
      persist: Boolean(sources[id]?.persist),
      retention_days: sources[id]?.retention_days ?? null,
      // Shioaji only; a revision without `keep` keeps every kind.
      ...(id === "shioaji" ? { keep: { ...Object.fromEntries(KEEP_CATEGORIES.map((c) => [c, sources[id]?.keep?.[c] ?? true])), ...NEVER_KEPT } } : {}),
    }])),
    training: {
      retention_days: valuesOf(training).retention_days ?? null,
      window_trading_days: valuesOf(training).window_trading_days ?? null,
    },
    historical_root: valuesOf(location).historical_root || "",
    kbar_months: { ...(valuesOf(kbar).months || {}) },
    query_cache_days: valuesOf(queryCache).retention_days ?? null,
    closing_data_url: valuesOf(closingData).url ?? "",
  };
}

function closingDataChanged() {
  return savedDraft().closing_data_url !== draft.closing_data_url.trim();
}

function queryCacheChanged() {
  return savedDraft().query_cache_days !== draft.query_cache_days;
}

function kbarChanged() {
  const saved = savedDraft().kbar_months;
  return KBAR_TIERS.some(([tier]) => saved[tier] !== draft.kbar_months[tier]);
}

function trainingChanged() {
  const saved = savedDraft().training;
  return saved.retention_days !== draft.training.retention_days || saved.window_trading_days !== draft.training.window_trading_days;
}

function retentionChanged() {
  const saved = savedDraft();
  return SOURCES.some(({ id }) => saved.sources[id].persist !== draft.sources[id].persist
    || saved.sources[id].retention_days !== draft.sources[id].retention_days
    || KEEP_CATEGORIES.some((c) => saved.sources[id].keep?.[c] !== draft.sources[id].keep?.[c]));
}

// A kept Shioaji: which kinds of data, one row per group, above 保存.
function keepRows(source, keep) {
  return KEEP_ROWS.map(({ label, pills }) => `<div class="settings-item" data-morph-key="${source}-keep-${escapeHtml(label)}" data-storage-source="${source}">`
    + `<span class="settings-item-main is-nested"><b>${escapeHtml(label)}</b></span><span class="settings-pills">`
    + pills.map(([id, name]) => `<button type="button" class="settings-pill${keep[id] ? " is-active" : ""}" data-storage-keep="${id}" aria-pressed="${keep[id] ? "true" : "false"}">${escapeHtml(name)}</button>`).join("")
    + `</span></div>`).join("");
}

function locationChanged() {
  return (savedDraft().historical_root || "") !== (draft.historical_root || "").trim();
}

// Each source is a switch (keep its history or not); a kept one has its 保存 row under it.
function renderRetention() {
  const group = $("storageRetentionGroup");
  if (!group || !draft) return;
  morphInto(group, SOURCES.map(({ id, label, markets }) => {
    const entry = draft.sources[id];
    const value = entry.retention_days == null ? FOREVER : String(entry.retention_days);
    const options = [...DAY_OPTIONS.map((d) => `<option value="${d}"${value === String(d) ? " selected" : ""}>${d} 個交易日</option>`),
      `<option value="${FOREVER}"${value === FOREVER ? " selected" : ""}>永久</option>`].join("");
    const source = escapeHtml(id);
    return `<label class="settings-item" data-morph-key="${source}" data-storage-source="${source}">`
      + `<span class="settings-item-main"><b>${escapeHtml(label)}</b><span class="settings-item-code">${escapeHtml(markets)}</span></span>`
      + `<span class="settings-item-value">${entry.persist ? "" : "只保留當盤"}</span>`
      + `<input class="settings-switch" type="checkbox" data-storage-field="persist"${entry.persist ? " checked" : ""} /></label>`
      + (entry.persist && entry.keep ? keepRows(source, entry.keep) : "")
      + (entry.persist ? `<label class="settings-item" data-morph-key="${source}-days" data-storage-source="${source}">`
        + `<span class="settings-item-main is-nested"><b>保存</b></span>`
        + `<span class="settings-select"><select data-storage-field="days">${options}</select></span></label>` : "");
  }).join(""));
}

function selectOptions(values, current, label, forever) {
  const value = current == null ? FOREVER : String(current);
  // A saved value outside the usual choices is shown as it is, never replaced by one of them.
  const all = current == null || values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  return [...all.map((d) => `<option value="${d}"${value === String(d) ? " selected" : ""}>${escapeHtml(label(d))}</option>`),
    ...(forever ? [`<option value="${FOREVER}"${value === FOREVER ? " selected" : ""}>永久</option>`] : [])].join("");
}

function renderTraining() {
  const keep = $("trainingRetentionSelect");
  const span = $("trainingWindowSelect");
  if (!keep || !span || !draft) return;
  morphInto(keep, selectOptions(TRAINING_RETENTION_OPTIONS, draft.training.retention_days, (d) => `${d} 個交易日`, true));
  morphInto(span, selectOptions(TRAINING_WINDOW_OPTIONS, draft.training.window_trading_days, (d) => `${d} 個交易日`, false));
}

// One row per stored timeframe, then the daily bars, which are always kept.
function renderKbar() {
  const group = $("kbarRetentionGroup");
  if (!group || !draft) return;
  morphInto(group, KBAR_TIERS.map(([tier, label]) => `<label class="settings-item" data-morph-key="kbar-${tier}">`
    + `<span class="settings-item-main"><b>${escapeHtml(label)}</b></span>`
    + `<span class="settings-select"><select data-kbar-tier="${tier}">${selectOptions(KBAR_MONTH_OPTIONS, draft.kbar_months[tier], (m) => `${m} 個月`, false)}</select></span></label>`).join("")
    + `<div class="settings-item" data-morph-key="kbar-day"><span class="settings-item-main"><b>日、週、月 K</b></span><span class="settings-item-value">永久</span></div>`);
}

function renderQueryCache() {
  const select = $("queryCacheRetentionSelect");
  if (select && draft) morphInto(select, selectOptions(QUERY_CACHE_OPTIONS, draft.query_cache_days, (d) => `${d} 天`, false));
  const closing = $("closingDataUrl");
  if (closing && draft && document.activeElement !== closing) closing.value = draft.closing_data_url;
}

const shown = (root) => root || "預設位置";

// What the saved folder is waiting for (the journal, config/js/storage_settings.js), or "" when nothing is.
function savedLocationNote(active) {
  const pointer = location?.pointer || {};
  const op = location?.apply_operation;
  if (op?.state === "activated") return `已切換到新資料夾，正在背景刪除舊資料夾。${op.error ? `（${op.error}）` : ""}`;
  if (pointer.latest == null || pointer.latest === pointer.active) return "";
  const current = op && op.revision === pointer.latest ? op : null;
  const using = `目前使用 ${active}`;
  if (current?.state === "synced") return `已複製完成並持續同步，下次完整關閉重開時切換（${using}）。`;
  if (current?.state === "copying") {
    const progress = current.progress;
    const amount = progress?.state === "copying" && Number(progress.bytes_total) > 0
      ? `${gbText(progress.bytes_done) ?? "--"} / ${gbText(progress.bytes_total)}（${Math.floor((Number(progress.bytes_done) / Number(progress.bytes_total)) * 100)}%）`
      : "比對中";
    return `背景複製到這裡：${amount}，App 可照常使用，完成後下次完整關閉重開時切換（${using}）。${current.error ? `（${current.error}）` : ""}`;
  }
  if (current && ["refused", "rolled_back", "rollback_failed", "unreadable"].includes(current.state)) {
    return `已儲存，但搬移沒有完成（${current.error || current.state}），仍使用原位置，舊資料未變動；下次完整重開或重新儲存時再試。`;
  }
  return `已儲存，下次完整關閉重開時改用這裡（${using}）。`;
}

// The row shows the folder this page would save (the chosen one, else the saved one). The line under it says why it
// is not the folder in use yet: chosen and not saved, or saved and on its way there.
function renderLocation() {
  const path = $("storageLocationPath");
  const pending = $("storageLocationPending");
  if (!path || !pending) return;
  const chosen = (draft?.historical_root || "").trim();
  path.textContent = middleEllipsis(shown(chosen));
  const reset = $("storageLocationDefaultBtn");
  if (reset) reset.disabled = !draft || !chosen;
  const active = shown(location?.active?.values?.historical_root || "");
  const note = draft && locationChanged() ? `按「儲存」後資料會在背景複製到這裡，App 可照常使用，完成後完整關閉重開時切換（目前使用 ${active}）`
    : savedLocationNote(active);
  pending.hidden = !note;
  pending.textContent = note;
}

// While the saved folder is on its way, the journal changes without this page doing anything.
function scheduleLocationPoll(gen) {
  clearTimeout(locationPoll);
  locationPoll = null;
  const pointer = location?.pointer;
  const underWay = pointer && ((pointer.latest != null && pointer.latest !== pointer.active) || location?.apply_operation?.state === "activated");
  if (gen === generation && underWay) locationPoll = setTimeout(() => void refreshLocation(gen), LOCATION_POLL_MS);
}

async function refreshLocation(gen) {
  let payload = null;
  try { payload = await apiGet("/api/config/storage_location"); }
  catch (error) { recordFailure("reading", "GET /api/config/storage_location", error); }
  if (gen !== generation) return;
  if (payload?.ok) { location = payload; renderLocation(); }
  else if (payload) recordFailure("reading", "GET /api/config/storage_location", payload?.error ?? payload);
  scheduleLocationPoll(gen);
}

function updateSave() {
  const button = $("storageSaveBtn");
  if (button) button.disabled = !draft || (!retentionChanged() && !trainingChanged() && !locationChanged() && !kbarChanged() && !queryCacheChanged() && !closingDataChanged());
}

function render() {
  renderRetention();
  renderTraining();
  renderKbar();
  renderQueryCache();
  renderLocation();
  updateSave();
}

// `keep`: draft fields to carry over the reload (a domain whose save failed keeps what the user entered).
async function load(gen = generation, keep = {}) {
  const [r, t, l, k, q, c] = await Promise.all([apiGet("/api/config/storage_retention"), apiGet("/api/config/training_data"),
    apiGet("/api/config/storage_location"), apiGet("/api/config/kbar_retention"), apiGet("/api/config/query_cache"), apiGet("/api/config/closing_data")]);
  if (gen !== generation) return;
  retention = r?.ok ? r : null;
  training = t?.ok ? t : null;
  location = l?.ok ? l : null;
  kbar = k?.ok ? k : null;
  queryCache = q?.ok ? q : null;
  closingData = c?.ok ? c : null;
  if (!retention) recordFailure("reading", "GET /api/config/storage_retention", r?.error ?? r);
  if (!training) recordFailure("reading", "GET /api/config/training_data", t?.error ?? t);
  if (!location) recordFailure("reading", "GET /api/config/storage_location", l?.error ?? l);
  if (!kbar) recordFailure("reading", "GET /api/config/kbar_retention", k?.error ?? k);
  if (!queryCache) recordFailure("reading", "GET /api/config/query_cache", q?.error ?? q);
  if (!closingData) recordFailure("reading", "GET /api/config/closing_data", c?.error ?? c);
  if (!retention || !training || !location || !kbar || !queryCache || !closingData) setMessage(`讀取失敗：${r?.error || t?.error || l?.error || k?.error || q?.error || c?.error || "設定服務沒有回應"}`, true);
  draft = { ...savedDraft(), ...keep };
  render();
  scheduleLocationPoll(gen);
}

// Retention, training data and location are separate settings, each with its own revision: each is saved on its own
// and reports its own outcome, so a save where one went through and another did not says exactly that (and the one
// that failed keeps what the user entered after the reload).
async function saveDomain({ label, path, expectedRevision, values, applied }) {
  const outcome = await saveVersionedSetting({ label, path, expectedRevision, values, recordFailure });
  return { ok: outcome.ok, text: outcome.ok ? applied : outcome.text };
}

async function save() {
  if (!draft) return;
  const outcomes = [];
  const keep = {};
  if (retentionChanged()) {
    const outcome = await saveDomain({ label: "保存天數", path: "/api/config/storage_retention",
      expectedRevision: retention?.pointer?.latest, values: { sources: draft.sources },
      applied: "保存天數已生效（下一次修剪時套用，每分鐘一次）" });
    if (!outcome.ok) keep.sources = draft.sources;
    outcomes.push(outcome);
  }
  if (trainingChanged()) {
    const outcome = await saveDomain({ label: "訓練資料", path: "/api/config/training_data",
      expectedRevision: training?.pointer?.latest, values: { ...draft.training },
      applied: "訓練資料設定已儲存（下次訓練時生效）" });
    if (!outcome.ok) keep.training = { ...draft.training };
    outcomes.push(outcome);
  }
  if (kbarChanged()) {
    const outcome = await saveDomain({ label: "K 棒保存", path: "/api/config/kbar_retention",
      expectedRevision: kbar?.pointer?.latest, values: { months: { ...draft.kbar_months } },
      applied: "K 棒保存已儲存（下次收盤整理時生效）" });
    if (!outcome.ok) keep.kbar_months = { ...draft.kbar_months };
    outcomes.push(outcome);
  }
  if (queryCacheChanged()) {
    const outcome = await saveDomain({ label: "查詢快取", path: "/api/config/query_cache",
      expectedRevision: queryCache?.pointer?.latest, values: { retention_days: draft.query_cache_days },
      applied: "查詢快取保存天數已儲存（下次收盤整理時生效）" });
    if (!outcome.ok) keep.query_cache_days = draft.query_cache_days;
    outcomes.push(outcome);
  }
  if (closingDataChanged()) {
    const outcome = await saveDomain({ label: "收盤資料來源", path: "/api/config/closing_data",
      expectedRevision: closingData?.pointer?.latest, values: { url: draft.closing_data_url.trim() },
      applied: "收盤資料來源已儲存" });
    if (!outcome.ok) keep.closing_data_url = draft.closing_data_url;
    outcomes.push(outcome);
  }
  if (locationChanged()) {
    const root = (draft.historical_root || "").trim();
    const outcome = await saveDomain({ label: "資料夾", path: "/api/config/storage_location",
      expectedRevision: location?.pointer?.latest, values: { historical_root: root || null },
      applied: "資料夾已儲存，資料會在背景複製，完成後完整關閉重開時切換" });
    if (!outcome.ok) keep.historical_root = draft.historical_root;
    outcomes.push(outcome);
  }
  // All saved: one floating message. Anything refused: every outcome stays left of 儲存, what went through included.
  if (outcomes.every((outcome) => outcome.ok)) {
    setMessage("");
    showToast(outcomes.map((outcome) => outcome.text).join("；"));
  } else {
    setMessage(outcomes.map((outcome) => outcome.text).join("；"), true);
  }
  await load(generation, keep);
}

function onChange(event) {
  const row = event.target.closest?.("[data-storage-source]");
  if (!row || !draft) return;
  const entry = draft.sources[row.dataset.storageSource];
  const field = event.target.dataset.storageField;
  if (field === "persist") {
    entry.persist = Boolean(event.target.checked);
    if (entry.persist && entry.retention_days == null && savedDraft().sources[row.dataset.storageSource].retention_days == null) entry.retention_days = 3;
  }
  if (field === "days") entry.retention_days = event.target.value === FOREVER ? null : Number(event.target.value);
  render();
}

function onKeepClick(event) {
  const pill = event.target.closest?.("[data-storage-keep]");
  const row = pill?.closest("[data-storage-source]");
  if (!pill || !row || !draft) return;
  const keep = draft.sources[row.dataset.storageSource].keep;
  keep[pill.dataset.storageKeep] = !keep[pill.dataset.storageKeep];
  render();
}

function onTrainingChange(event) {
  const field = event.target.dataset.trainingField;
  if (!field || !draft) return;
  draft.training[field] = event.target.value === FOREVER ? null : Number(event.target.value);
  render();
}

function onClosingDataInput(event) {
  if (!draft) return;
  draft.closing_data_url = event.target.value;
  render();
}

function onQueryCacheChange(event) {
  if (!draft) return;
  draft.query_cache_days = Number(event.target.value);
  render();
}

function onKbarChange(event) {
  const tier = event.target.dataset.kbarTier;
  if (!tier || !draft) return;
  draft.kbar_months[tier] = Number(event.target.value);
  render();
}

export function initStorageSettings() {
  generation += 1;
  $("kbarRetentionGroup")?.addEventListener("change", onKbarChange);
  $("queryCacheRetentionSelect")?.addEventListener("change", onQueryCacheChange);
  $("closingDataUrl")?.addEventListener("input", onClosingDataInput);
  $("storageRetentionGroup")?.addEventListener("change", onChange);
  $("storageRetentionGroup")?.addEventListener("click", onKeepClick);
  $("trainingRetentionSelect")?.addEventListener("change", onTrainingChange);
  $("trainingWindowSelect")?.addEventListener("change", onTrainingChange);
  $("storageLocationPickBtn")?.addEventListener("click", async () => {
    try {
      const picked = await window.desktopAPI?.pickFolder?.();
      if (picked && draft) { draft.historical_root = picked; render(); }
    } catch (error) {
      recordFailure("picking", "a folder", error);
      setMessage(`選擇資料夾失敗：${error?.message || error}`, true);
    }
  });
  $("storageLocationDefaultBtn")?.addEventListener("click", () => { if (draft) { draft.historical_root = ""; render(); } });
  $("storageSaveBtn")?.addEventListener("click", () => {
    setMessage("");
    void save().catch((error) => {
      recordFailure("reloading after saving", "storage settings", error);
      setMessage(`讀取失敗：${error?.message || error}`, true);
    });
  });
  load().catch((error) => {
    recordFailure("reading", "storage settings", error);
    setMessage(`讀取失敗：${error?.message || error}`, true);
  });
}

export function disposeStorageSettings() {
  generation += 1;
  clearTimeout(locationPoll);
  locationPoll = null;
}
