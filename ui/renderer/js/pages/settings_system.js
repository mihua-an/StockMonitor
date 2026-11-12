// Settings page 系統: the services, their resources and their ports in one list (docs/system-architecture/06, 07).
//
// * One row per service: state, CPU, the last 2 minutes of CPU, memory and the port in use (✓ = seen listening).
//   The rows are the monitoring snapshot's services plus the network manifest's.
// * Ports (編輯連接埠): the draft is validated by settings_api (whole candidate, env overrides included), saved as a
//   versioned revision with expected_revision (a concurrent edit is a conflict), previewed, and applied by Health as
//   one operation (drain -> stop -> release -> bind -> verify). Saving is not applying: whether the saved revision is
//   in effect shows beside the services' title all the time, and the last operation's steps under each service.
// * Resources: Health's one shared monitoring snapshot through Electron main (never a per-window service scan).
//   Detail (CPU, memory) is requested only while this page is visible; missing values are shown as missing, never as
//   zero. The rows are morphed every 2 s, so a port being typed keeps its focus and its text.

import { morphInto } from "../core/dom_morph.js";
import { apiGetOk, apiJsonPost } from "../core/api.js";
import { $, escapeHtml } from "../core/utility.js";
import { fittedStatusHtml, setNote, setStatus, showToast } from "../core/settings_ui.js";
import { describeSettingsProblems, saveVersionedSetting } from "../core/settings_write.js";
import { createExpandMotion } from "../core/expand_motion.js";
import { createMonitoringTrend } from "../core/monitoring_trend.js";
import { bytesText } from "../core/diagnostics_format.js";

const REFRESH_MS = 2000;
const DETAIL_RENEW_MS = 4000;
const EDITABLE_KINDS = new Set(["api", "runtime", "controller", "provider", "external"]);
const STATE_LABEL = {
  RUNNING: "運行中", STARTING: "啟動中", STOPPING: "停止中", DISABLED: "停用",
  FAILED: "故障", UNKNOWN: "未知", STALE: "逾時", EXTERNAL: "外部程式", RESERVED: "保留",
};
const STATE_KIND = { RUNNING: "ok", FAILED: "error", STALE: "warn", UNKNOWN: "warn" };
const STEP_LABEL = { drain: "排空", stop: "停止", release_verified: "釋放 port", candidate_fenced: "確認舊實例結束", bind: "綁定", readiness: "就緒", identity_verified: "身分驗證", effective_recorded: "生效" };

let generation = 0;
const timers = new Set();
let network = null;          // GET /api/config/network
let snapshot = null;         // Health monitoring snapshot
const trend = createMonitoringTrend();   // Health's trend points (core/monitoring_trend.js)
const SPARK_SPAN_MS = 2 * 60 * 1000;
let lastOperation = null;
let busy = false;
let editing = false;
let portDraft = {};          // service_id -> the text in its 新連接埠 input ("" = default)

function fmtPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

// Every failure this page shows is also a record (the window's console warnings land in the run's error.log), named by
// the operation and the path or IPC it used.
function recordFailure(operation, target, detail) {
  console.warn(`[settings/system: ${operation} ${target}] failed`, detail);
}

// The note left of the port steps: what a check found, what is running, or an error (until the next step).
function setMessage(text, kind = "") {
  setNote($("systemPortsMessage"), text, kind === "error");
}

function manifestServices() {
  return (network?.manifest?.services || []).filter((s) => s.kind !== "worker");
}

function savedValues() {
  return JSON.parse(JSON.stringify(network?.latest?.values || { services: {} }));
}

function draftFromSaved() {
  const saved = savedValues().services || {};
  return Object.fromEntries(Object.entries(saved).map(([sid, entry]) => [sid, String(entry?.port ?? "")]));
}

function draftValues() {
  const services = {};
  for (const [sid, value] of Object.entries(portDraft)) {
    const text = String(value).trim();
    if (!text) continue;
    const port = Number(text);
    services[sid] = { port: Number.isInteger(port) ? port : text };
  }
  return { services };
}

function draftDiffers() {
  const saved = savedValues().services || {};
  const draft = draftValues().services;
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
  for (const key of keys) {
    if (Number(saved[key]?.port) !== Number(draft[key]?.port)) return true;
  }
  return false;
}

function pending() {
  const pointer = network?.pointer || {};
  return (pointer.latest || 0) !== (pointer.active || 0);
}

// The snapshot's services in its order, then the manifest's services it does not have.
function serviceList() {
  const specs = new Map(manifestServices().map((spec) => [spec.service_id, spec]));
  const live = snapshot?.services || [];
  const liveIds = new Set(live.map((svc) => svc.service_id));
  return [...live.map((svc) => ({ sid: svc.service_id, svc, spec: specs.get(svc.service_id) || null })),
    ...[...specs.values()].filter((spec) => !liveIds.has(spec.service_id)).map((spec) => ({ sid: spec.service_id, svc: null, spec }))];
}

function portText(spec, addresses) {
  if (spec?.kind === "runtime" && !spec.listener) return "本機程序／IPC";
  const effective = addresses.effective?.port;
  const observed = addresses.observed?.verified ? addresses.observed.port : null;
  if (effective === null || effective === undefined) return observed === null ? "" : `${observed} ✓`;
  if (observed === null) return String(effective);
  return observed === effective ? `${effective} ✓` : `${effective}（監聽 ${observed} ✓）`;
}

function serviceRowHtml({ sid, svc, spec }, cpuTrend) {
  const state = svc?.state || "UNKNOWN";
  const res = svc?.resources || {};
  const unavailable = !svc || (res.availability && res.availability !== "OK");
  const addresses = svc?.addresses || {};
  const key = escapeHtml(sid);
  const editable = spec && EDITABLE_KINDS.has(spec.kind) && spec.default_port !== null && spec.default_port !== undefined;
  const input = !editing ? ""
    : editable ? `<input class="settings-input is-short" type="text" inputmode="numeric" data-port-service="${key}" placeholder="${escapeHtml(addresses.default?.port ?? spec.default_port ?? "")}" value="${escapeHtml(portDraft[sid] ?? "")}"${busy ? " disabled" : ""} />`
      : '<span class="settings-num">—</span>';
  const cpu = unavailable ? (res.availability === "WARMING" || res.availability === "NO_SAMPLE" ? "暖機中" : "—") : fmtPct(res.cpu_percent);
  const row = `<div class="settings-item is-service${editing ? " is-editing" : ""}" data-morph-key="${key}">`
    + `<span class="settings-item-main"><b>${escapeHtml(svc?.display_name || spec?.display_name || sid)}</b></span>`
    + `<span class="settings-num is-state">${fittedStatusHtml(STATE_LABEL[state] || state, STATE_KIND[state] || "")}</span>`
    + `<span class="settings-num">${escapeHtml(cpu)}</span>`
    + `<span class="settings-num">${sparkline(cpuTrend)}</span>`
    + `<span class="settings-num">${(unavailable ? null : bytesText(res.memory_bytes)) ?? "--"}</span>`
    + `<span class="settings-num">${escapeHtml(portText(spec, addresses))}</span>`
    + `${input}</div>`;
  const steps = lastOperation?.services?.[sid]?.steps || [];
  return row + (steps.length ? `<div class="settings-item-sub" data-morph-key="${key}-steps">上次套用`
    + steps.map((s) => `<span class="settings-step${s.ok ? "" : " is-error"}">${escapeHtml(STEP_LABEL[s.step] || s.step)}</span>`).join("") + "</div>" : "");
}

function renderServices() {
  const pill = $("systemPortsPendingPill");
  if (pill && network) {
    if (pending()) setStatus(pill, `版本 ${network.pointer.latest} 待套用`, "warn");
    else setStatus(pill, "連接埠已同步", "ok");
  }
  const toggle = $("systemPortsEditToggle");
  if (toggle) toggle.textContent = editing ? "完成" : "編輯連接埠";
  $("systemTotalsRow")?.classList.toggle("is-editing", editing);
  drawEditBlocks();
  const pointer = network?.pointer || {};
  const revision = $("systemPortsRevision");
  if (revision) {
    revision.textContent = network ? `${snapshot?.config?.effective_revision ?? pointer.active ?? "預設"}（最新保存 ${pointer.latest ?? "無"}${pending() ? "，待套用" : ""}）` : "";
  }
  const rows = $("systemServiceRows");
  if (rows && (network || snapshot)) {
    const bySid = {};
    // 近 2 分鐘 CPU: the window is chosen by time over Health's points, never by a count of them.
    const from = Date.parse(snapshot?.sampled_at) - SPARK_SPAN_MS;
    for (const point of trend.points().filter((p) => !(p.t < from))) {
      for (const [sid, value] of Object.entries(point.services || {})) (bySid[sid] ||= []).push({ t: point.t, v: value.cpu ?? null });
    }
    morphInto(rows, serviceList().map((entry) => serviceRowHtml(entry, bySid[entry.sid] || [])).join(""));
  }
  updateActionState();
}

function renderTotals() {
  if (!snapshot) return;
  const totals = snapshot.totals || {};
  const cpu = $("systemTotalsCpu"), memory = $("systemTotalsMemory");
  const collected = Boolean(snapshot.detail_collected);
  if (cpu) cpu.textContent = collected ? fmtPct(totals.cpu_percent_unique_pids) : "—";
  if (memory) memory.textContent = (collected ? bytesText(totals.memory_bytes_unique_pids) : null) ?? "--";
}

function updateActionState() {
  const dirty = draftDiffers();
  const save = $("systemPortsSaveBtn");
  const apply = $("systemPortsApplyBtn");
  const validate = $("systemPortsValidateBtn");
  if (save) save.disabled = busy || !dirty;
  if (validate) validate.disabled = busy;
  if (apply) apply.disabled = busy || dirty || !pending();
}

// 編輯連接埠 opens the revision lines above the services and the steps below them.
const EDIT_BLOCKS = { info: "systemPortsEditInfo", actions: "systemPortsActions" };
const editMotion = createExpandMotion({ find: (key) => $(EDIT_BLOCKS[key]), redraw: () => drawEditBlocks() });

function drawEditBlocks() {
  for (const [key, id] of Object.entries(EDIT_BLOCKS)) {
    const block = $(id);
    if (block) block.hidden = !(editing || editMotion.closing(key));
  }
}

function setEditing(next) {
  if (Object.keys(EDIT_BLOCKS).some((key) => editMotion.busy(key))) return;
  Object.keys(EDIT_BLOCKS).forEach((key) => editMotion.start(key, next));
  editing = next;
  if (editing) portDraft = draftFromSaved();
  else setMessage("");
  renderServices();
  editMotion.play();
}

async function toggleEditing() {
  if (editing && draftDiffers() && !(await window.desktopAPI.confirm("有填了還沒儲存的新連接埠，要丟掉嗎？"))) return;
  setEditing(!editing);
}

async function loadNetwork(gen = generation) {
  const payload = await apiGetOk("/api/config/network");
  if (gen !== generation) return;
  const firstLoad = !network;
  network = payload;
  if (firstLoad || !editing) portDraft = draftFromSaved();
  renderServices();
}

async function validateDraft() {
  const result = await apiJsonPost("/api/config/network/validate", { values: draftValues() });
  if (!result?.ok) {
    setMessage(`驗證失敗：${describeSettingsProblems(result?.problems)}`, "error");
    return null;
  }
  const impact = result.impact || {};
  const changed = impact.changed_services || [];
  setMessage(changed.length
    ? `驗證通過。影響：${changed.join("、")}${impact.self_endpoint_change?.length ? "（包含設定服務／Health 自身，套用時整套受控重啟）" : ""}；生效方式：${impact.effect_mode}`
    : "驗證通過，與目前生效設定相同。");
  return result;
}

async function saveDraft() {
  const checked = await validateDraft();
  if (!checked) return;
  const outcome = await saveVersionedSetting({ path: "/api/config/network", expectedRevision: network?.pointer?.latest, values: draftValues(), recordFailure });
  if (outcome.ok) {
    setMessage("");
    showToast(`已保存為版本 ${outcome.result.revision.revision}（尚未套用）。按「3. 套用」由 Health 執行受控重啟。`);
  } else {
    setMessage(outcome.text, "error");
  }
  await loadNetwork();
  // Saved, or another window saved first: the inputs then show the saved revision. Refused for another reason: what
  // the user typed stays.
  if (outcome.ok || outcome.conflict) {
    portDraft = draftFromSaved();
    renderServices();
  }
}

// Single-flight: the lock is taken at the entry, before the preview round trip, so a second click while the first is
// still previewing or applying does nothing (the lock was taken only after the confirm, so a double click previewed
// and applied twice -- two operations). The buttons are disabled for as long as the lock is held.
async function applyLatest() {
  if (busy) return;
  const pointer = network?.pointer || {};
  if (!pointer.latest || pointer.latest === pointer.active) return;
  busy = true;
  renderServices();
  let applied = false;
  try {
    const preview = await window.desktopAPI.previewNetworkApply(pointer.latest);
    if (!preview?.ok) {
      recordFailure("previewing", `network revision ${pointer.latest}`, preview?.problems || preview?.error || preview);
      setMessage(`無法套用：${describeSettingsProblems(preview?.problems) || preview?.error || "預覽失敗"}`, "error");
      return;
    }
    const plan = preview.plan || {};
    const selfChange = (plan.self || []).length > 0;
    const confirmText = selfChange
      ? `套用版本 ${pointer.latest} 會變更設定服務／Health 自身的 port：整個 App 的背景服務會依序停止並以新設定重啟（介面會自動重新連線）。確定？`
      : `套用版本 ${pointer.latest}：依序重啟 ${plan.affected.join("、")}，其他服務不受影響。確定？`;
    if (!(await window.desktopAPI.confirm(confirmText))) return;
    setMessage(selfChange ? "Health 正在執行整套受控重啟…" : "Health 正在套用（排空 → 停止 → 釋放 → 綁定 → 驗證）…");
    applied = true;
    const result = await window.desktopAPI.applyNetworkRevision({ candidate_revision: pointer.latest, expected_active_revision: pointer.active ?? null });
    lastOperation = result?.operation || null;
    if (result?.pending_restart) {
      setMessage("");
      showToast("已開始整套受控重啟；完成後介面會重新載入。");
    } else if (result?.ok) {
      setMessage("");
      showToast(`版本 ${pointer.latest} 已套用並逐一驗證完成。`);
    } else {
      const state = lastOperation?.state;
      const reason = (lastOperation?.history || []).slice(-1)[0]?.reason || result?.error || "";
      recordFailure("applying", `network revision ${pointer.latest}`, { state, reason, problems: lastOperation?.problems || null });
      setMessage(`套用未完成（${state || "失敗"}）：${describeSettingsProblems(lastOperation?.problems) || reason}`, "error");
    }
  } finally {
    busy = false;
    renderServices();
    if (applied) {
      const [networkReload, snapshotReload] = await Promise.allSettled([loadNetwork(), refreshSnapshot()]);
      if (networkReload.status === "rejected") recordFailure("reloading after apply", "GET /api/config/network", networkReload.reason);
      if (snapshotReload.status === "rejected") recordFailure("reloading after apply", "monitoring snapshot", snapshotReload.reason);
    }
  }
}

// One service's CPU over Health's trend points ({ t, v }), each placed by its time: Health samples every 10 s while no
// page is open and every pass while one is. Every point is a real sample, so one without a value (the service was
// down or warming up) breaks the line, and each run starts with a moveto (a path beginning with "L" is invalid SVG).
export function sparkline(points) {
  const sampled = points.filter((p) => Number.isFinite(p?.v));
  if (sampled.length < 2) return '<span class="muted">—</span>';
  const max = Math.max(5, ...sampled.map((p) => p.v));
  const w = 90;
  const h = 20;
  const from = points[0].t;
  const span = Math.max(1, points.at(-1).t - from);
  let pen = "M";
  const path = points.map((p) => {
    if (!Number.isFinite(p?.v)) { pen = "M"; return ""; }
    const segment = `${pen}${(((p.t - from) / span) * w).toFixed(1)},${(h - (p.v / max) * h).toFixed(1)}`;
    pen = "L";
    return segment;
  }).filter(Boolean).join(" ");
  return `<svg class="settings-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

async function refreshSnapshot(gen = generation) {
  const payload = await window.desktopAPI?.getMonitoringSnapshot?.({ trendSince: trend.since() });
  if (gen !== generation || !payload) return;
  // Never an older sample over a newer one.
  if (payload.snapshot && snapshot && Date.parse(payload.snapshot.sampled_at) < Date.parse(snapshot.sampled_at)) return;
  if (!payload.ok || !payload.snapshot) {
    recordFailure("reading", "monitoring snapshot", payload.error || "Health has no snapshot yet");
    setNote($("systemWorkloadMessage"), `無法取得監控快照：${payload.error || "Health 尚未產生快照"}`, true);
    return;
  }
  setNote($("systemWorkloadMessage"), "");
  snapshot = payload.snapshot;
  trend.apply(snapshot);
  renderServices();
  renderTotals();
}

// One request at a time per poll: the next is scheduled only after the previous answered (an interval
// starting a refresh every tick lets slow answers overlap and land out of order).
function schedule(fn, ms, gen) {
  const run = async () => {
    if (gen !== generation) return;
    if (!document.hidden) {
      try { await fn(); } catch (error) { console.warn("[settings: a diagnostics poll] failed", error); }
    }
    if (gen !== generation) return;
    const id = setTimeout(() => { timers.delete(id); void run(); }, ms);
    timers.add(id);
  };
  void run();
}

// 開機自動啟動 (off by default): Windows' own login item, read back after each change.
async function loadAutostart(gen) {
  const box = $("systemAutostart"), message = $("systemAutostartMessage");
  if (!box) return;
  const status = await window.desktopAPI?.getAutostart?.();
  if (gen !== generation) return;
  box.checked = Boolean(status?.enabled);
  box.disabled = !status?.available;
  setNote(message, status?.available ? "" : `無法設定：${status?.reason || "未知原因"}`, true);
}

function bindAutostart(gen) {
  const box = $("systemAutostart"), message = $("systemAutostartMessage");
  box?.addEventListener("change", () => {
    const wanted = box.checked;
    box.disabled = true;
    setNote(message, "");
    void window.desktopAPI.setAutostart(wanted).then((status) => {
      if (gen !== generation) return;
      box.checked = Boolean(status?.enabled);
      showToast(status?.enabled ? "已設定：登入 Windows 時自動啟動" : "已取消開機自動啟動");
    }).catch((error) => {
      console.warn("[settings: setting autostart] failed", error);
      box.checked = !wanted;
      setNote(message, `設定失敗：${error?.message || error}`, true);
    }).finally(() => { if (gen === generation) box.disabled = false; });
  });
  void loadAutostart(gen).catch((error) => {
    console.warn("[settings: reading autostart] failed", error);
    setNote(message, `讀取失敗：${error?.message || error}`, true);
  });
}

export function initSystemSettings() {
  disposeSystemSettings();
  const gen = ++generation;
  editing = false;
  portDraft = {};
  bindAutostart(gen);
  const failed = (operation, target) => (e) => {
    recordFailure(operation, target, e);
    setMessage(String(e?.message || e), "error");
  };
  $("systemPortsEditToggle")?.addEventListener("click", () => {
    toggleEditing().catch((error) => console.warn("[settings: asking before dropping unsaved ports] failed", error));
  });
  $("systemServiceRows")?.addEventListener("input", (event) => {
    const sid = event.target.dataset?.portService;
    if (!sid) return;
    portDraft[sid] = event.target.value;
    updateActionState();
  });
  $("systemPortsValidateBtn")?.addEventListener("click", () => { setMessage(""); void validateDraft().catch(failed("validating", "POST /api/config/network/validate")); });
  $("systemPortsSaveBtn")?.addEventListener("click", () => { setMessage(""); void saveDraft().catch(failed("saving", "PUT /api/config/network")); });
  $("systemPortsApplyBtn")?.addEventListener("click", () => { void applyLatest().catch(failed("applying", "network revision")); });
  $("systemPortsResetBtn")?.addEventListener("click", () => {
    portDraft = {};
    renderServices();
    setMessage("草稿已清空（全部使用預設值），尚未保存。");
  });
  void loadNetwork(gen).catch((error) => {
    recordFailure("reading", "GET /api/config/network", error);
    // Said beside the services' title too: the steps' note is shown only while editing.
    if (gen === generation) setStatus($("systemPortsPendingPill"), `讀取網路設定失敗：${error?.message || error}`, "error");
    setMessage(`讀取網路設定失敗：${error?.message || error}`, "error");
  });
  void window.desktopAPI?.getNetworkOperations?.().then((ops) => {
    if (gen === generation) lastOperation = ops?.operations?.[0] || null;
  }).catch((error) => console.warn("[settings: reading network operations] failed", error));
  schedule(() => window.desktopAPI?.requestMonitoringDetail?.() || Promise.resolve(), DETAIL_RENEW_MS, gen);
  schedule(() => refreshSnapshot(gen), REFRESH_MS, gen);
}

export function disposeSystemSettings() {
  generation += 1;
  for (const id of timers) clearTimeout(id);
  timers.clear();
  trend.reset();
}
