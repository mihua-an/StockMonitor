// 設定 → 券商帳號 → 永豐行情連線 (config/broker_connection_settings.py, user 10-19): how many broker logins the App may
// use for market data and how many subscriptions each takes. One settings_api domain, `broker_connections`, active on
// save; the Shioaji provider reads it on its subscription loop (more room at once, less than what is in use by
// logging in again). Saved with expected_revision, so a second window's change is a conflict, never overwritten.
// The choices (defaults, ranges, the limits listed) are the domain's own, served with it (`choices`).
// The usage line is the provider's own report (GET /api/shioaji/status: subscription_connections).

import { apiGet } from "../core/api.js";
import { inFlight, runSingleFlight } from "../core/user_action.js";
import { $ } from "../core/utility.js";
import { setNote, showToast } from "../core/settings_ui.js";
import { saveVersionedSetting } from "../core/settings_write.js";

const PATH = "/api/config/broker_connections";

// Each visit of the page is a generation: work started for one never writes into the next.
let generation = 0;
let config = null;   // GET /api/config/broker_connections

// Every failure this page shows is also a record (the window's console warnings land in the run's error.log).
function recordFailure(operation, target, detail) {
  console.warn(`[settings/broker connections: ${operation} ${target}] failed`, detail);
}

// An error stays left of 儲存 until the next save; a success floats.
function setMessage(text, isError = false) {
  setNote($("brokerConnectionsMessage"), text, isError);
}

function choices() {
  const shioaji = config?.choices?.shioaji;
  return shioaji?.connections && shioaji?.per_connection_limit ? config.choices : null;
}

// The saved values, or the domain's defaults while nothing was saved.
function saved() {
  const entry = config?.latest?.values?.shioaji || choices()?.defaults?.shioaji || {};
  return { connections: Number(entry.connections), per_connection_limit: Number(entry.per_connection_limit) };
}

function fillSelect(select, values, current, label = String) {
  if (!select) return;
  const options = [...new Set([...values, current].filter(Number.isFinite))].sort((a, b) => a - b);
  const want = options.map(String).join(",");
  if (select.dataset.options !== want) {
    select.replaceChildren(...options.map((value) => new Option(label(value), String(value))));
    select.dataset.options = want;
  }
  select.value = String(current);
  select.disabled = !options.length;
}

function draft() {
  return { connections: Number($("brokerConnectionsMax")?.value), per_connection_limit: Number($("brokerConnectionsLimit")?.value) };
}

// 儲存's one writer: usable only with the domain's choices, while nothing is being saved, and when the draft differs
// from what is saved.
function updateSave() {
  const s = saved(), d = draft();
  const button = $("brokerConnectionsSaveBtn");
  if (!button) return;
  const dirty = s.connections !== d.connections || s.per_connection_limit !== d.per_connection_limit;
  button.disabled = !choices() || inFlight(button) || !dirty;
}

function render() {
  const range = choices()?.shioaji;
  const s = saved();
  const connections = range ? Array.from({ length: range.connections.max - range.connections.min + 1 }, (_, i) => range.connections.min + i) : [];
  fillSelect($("brokerConnectionsMax"), connections, range ? s.connections : NaN, (value) => `${value} 條`);
  fillSelect($("brokerConnectionsLimit"), range?.per_connection_limit.options || [], range ? s.per_connection_limit : NaN);
  updateSave();
}

// What the provider reports. A status that could not be read is said as such -- never as "not connected", which is
// a broker state only a successful report can give.
export function usageText(status) {
  if (!status || status.ok === false || typeof status.shioaji_connected !== "boolean") return "讀不到永豐連線狀態";
  if (!status.shioaji_connected) return "永豐尚未連線";
  const open = Array.isArray(status.subscription_connections?.open) ? status.subscription_connections.open : [];
  if (!open.length) return "";
  const rows = open.map((row) => `第 ${row.connection} 條 ${row.streams}／${row.room}`).join("、");
  return `${open.length} 條・${status.active_subscription_count} 個（${rows}）`;
}

async function loadUsage(gen) {
  let status = null;
  try {
    status = await apiGet("/api/shioaji/status");
  } catch (error) {
    recordFailure("reading", "GET /api/shioaji/status", error);
  }
  if (gen !== generation) return;
  if (status?.ok === false) recordFailure("reading", "GET /api/shioaji/status", status.error ?? status);
  const node = $("brokerConnectionsUsage");
  if (node) node.textContent = usageText(status);
}

async function load(gen) {
  const result = await apiGet(PATH);
  if (gen !== generation) return;
  config = result?.ok ? result : null;
  if (!config) {
    recordFailure("reading", `GET ${PATH}`, result?.error ?? result);
    setMessage(`讀取失敗：${result?.error || "設定服務沒有回應"}`, true);
  } else if (!choices()) {
    recordFailure("reading", `GET ${PATH}`, "the response holds no choices");
    setMessage("讀取失敗：設定服務沒有提供可選的值", true);
  }
  render();
  await loadUsage(gen);
}

// One save of the page visit `gen` (the click's): its outcome and the reload after it are shown only while that visit
// is still the page on screen.
async function save(gen) {
  const outcome = await saveVersionedSetting({ path: PATH, expectedRevision: config?.pointer?.latest, values: { shioaji: draft() }, recordFailure });
  if (gen !== generation) return;
  if (outcome.ok) showToast("已儲存並生效：增加的連線與訂閱數立即可用；比使用中少時會重新登入重新分配");
  else setMessage(outcome.text, true);
  await load(gen);
}

export function initBrokerConnectionSettings() {
  generation += 1;
  const gen = generation;
  $("brokerConnectionsMax")?.addEventListener("change", updateSave);
  $("brokerConnectionsLimit")?.addEventListener("change", updateSave);
  const button = $("brokerConnectionsSaveBtn");
  // One save at a time: a second click while one is on its way joins it instead of sending the same revision again.
  button?.addEventListener("click", () => {
    const clicked = generation;
    setMessage("");
    const flight = runSingleFlight(button, () => save(clicked));
    updateSave();
    flight
      .catch((error) => {
        recordFailure("reloading after saving", "broker connection settings", error);
        if (clicked === generation) setMessage(`讀取失敗：${error?.message || error}`, true);
      })
      .then(() => { if (clicked === generation) updateSave(); });
  });
  load(gen).catch((error) => {
    recordFailure("reading", "broker connection settings", error);
    if (gen === generation) setMessage(`讀取失敗：${error?.message || error}`, true);
  });
}

export function disposeBrokerConnectionSettings() {
  generation += 1;
}
