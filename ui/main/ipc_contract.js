"use strict";

// The one contract of every renderer <-> Electron main channel: its kind, the pages allowed to use it and its payload
// schema. The authorizer (ipc_security.js) checks every event against it, the router (ipc_router.js) refuses to
// install a handler for a channel it does not list and reports a listed one that has none, and the preload contract
// test checks that preload.js uses exactly these channels. A payload a handler receives has passed this schema; a
// handler does not re-validate it under another rule.
//
// kind: "invoke" (ipcRenderer.invoke -> handle), "send" (ipcRenderer.send -> on, no answer), "sync"
// (ipcRenderer.sendSync -> on with returnValue), "push" (main -> renderer webContents.send; never authorized here).

const DETACHED_WINDOWS = require("./detached_windows.json");

const ALL = Object.freeze(["index.html", "trade_window.html", "watch_pages_window.html", "workspace_view.html", "detached_view.html"]);
const MAIN = Object.freeze(["index.html"]);
const TRADE = Object.freeze(["index.html", "trade_window.html"]);
const EDITOR = Object.freeze(["watch_pages_window.html"]);
// The pages that load market_data/realtime.js, the only user of the market_runtime viewer credential.
const LIVE_VIEWER = Object.freeze(["index.html", "workspace_view.html", "detached_view.html"]);
// The components a detached window can host, with their window sizes: detached_windows.json is the one list.
const DETACHED_COMPONENT_IDS = Object.freeze(Object.keys(DETACHED_WINDOWS));

/** Bytes of a value as it crosses IPC or reaches a file (UTF-8 JSON), not JavaScript string length. */
function wireBytes(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
}

const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const string = (v, max = 512) => typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v);
const symbol = (v) => string(v, 64) && /^[A-Za-z0-9][A-Za-z0-9._^-]*$/.test(v);
const keys = (v, allowed) => record(v) && Object.keys(v).every((k) => allowed.includes(k));
const empty = (v) => v === undefined;
// Bound arbitrary display/diagnostic metadata before it reaches downstream code.
function bounded(value, depth = 0, budget = { left: 20000 }) {
  if (--budget.left < 0 || depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 16384;
  if (Array.isArray(value)) return value.length <= 5000 && value.every((v) => bounded(v, depth + 1, budget));
  return record(value) && Object.entries(value).every(([k, v]) =>
    !["__proto__", "prototype", "constructor"].includes(k) && bounded(v, depth + 1, budget));
}
const object = (v) => record(v) && bounded(v);
const optionalObject = (v) => v === undefined || object(v);

function form(v) {
  const fields = ["trade_date", "market", "action", "code", "trade_info", "trade_time"];
  if (!keys(v, ["prefill_url", "mapping", "trade"]) || !string(v.prefill_url, 16384)
      || !keys(v.mapping, fields) || !fields.every((k) => string(v.mapping[k]) && v.mapping[k].trim())
      || !keys(v.trade, [...fields, "trade_id"])) return false;
  const t = v.trade;
  if (!fields.every((k) => string(t[k], k === "trade_info" ? 8192 : 128))
      || !/^\d{4}-\d{2}-\d{2}$/.test(t.trade_date)
      || new Date(`${t.trade_date}T00:00:00Z`).toISOString().slice(0, 10) !== t.trade_date
      || !["台股", "美股"].includes(t.market) || !["買進", "賣出"].includes(t.action)
      || !symbol(t.code) || !t.trade_info.trim()
      || !/^(?:|(?:[01]\d|2[0-3]):?[0-5]\d)$/.test(t.trade_time)
      || !(t.trade_id == null || string(t.trade_id))) return false;
  const url = new URL(v.prefill_url);
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && ((["docs.google.com", "forms.google.com"].includes(url.hostname) && url.pathname.startsWith("/forms/"))
      || (url.hostname === "forms.gle" && /^\/[A-Za-z0-9_-]+$/.test(url.pathname)));
}

// A detached view: which component, in which context, following the selection or pinned to one symbol. Every field
// is required; an empty list is a valid descriptor.
const VIEW_DESCRIPTOR_VERSION = 1;
function viewDescriptorErrors(v) {
  if (!keys(v, ["version", "componentId", "contextMode", "contextId", "symbolMode", "symbol"])) return ["unknown_fields"];
  const errors = [];
  if (v.version !== VIEW_DESCRIPTOR_VERSION) errors.push("unsupported_version");
  if (!DETACHED_COMPONENT_IDS.includes(v.componentId)) errors.push("component_not_allowed");
  if (!["live", "replay"].includes(v.contextMode)) errors.push("invalid_context_mode");
  if (!string(v.contextId) || !v.contextId.trim()) errors.push("context_id_required");
  if (!["follow", "pinned"].includes(v.symbolMode)) errors.push("invalid_symbol_mode");
  if (!(v.symbol === undefined || v.symbol === "" || symbol(v.symbol))) errors.push("invalid_symbol");
  if (v.symbolMode === "pinned" && !symbol(v.symbol)) errors.push("pinned_symbol_required");
  return errors;
}

// A renderer's remediation event: everything but `process`, which Electron main stamps from the
// sending page; Health's ledger then checks the event against the contract.
const REMEDIATION_FIELDS = ["schema", "event_id", "at", "component", "mechanism_id", "trigger_reason", "identity", "attempt",
  "outcome", "related_upstream_event_id", "operation_id", "detail", "page_instance_id"];
const REMEDIATION_MAX_BYTES = 64 * 1024;
const revision = (v) => Number.isInteger(v) && v >= 1 && v <= 1e9;
// The color store sanitizes each value (an invalid one keeps its default); the channel bounds the shape.
const colors = (v) => keys(v, ["priceUpColor", "priceDownColor", "priceFlatColor"]) && Object.values(v).every((c) => string(c, 64));

const CHANNELS = Object.freeze({
  // One snapshot a preload reads before the page runs: mode, sources, colors, endpoints and the live connection.
  "runtime:get-bootstrap": { kind: "sync", pages: ALL },
  "preferences:set-colors": { kind: "invoke", pages: ALL, schema: colors },
  "startup:get-state": { kind: "invoke", pages: ALL },
  // Resolves with Market Runtime's start outcome ({ status, detail }) once Health has one: the /live connection waits.
  "startup:market-runtime": { kind: "invoke", pages: ALL },
  // The same for the Futu provider: the Futu product store's /api/futu/* reads wait for it.
  "startup:futu-provider": { kind: "invoke", pages: ALL },
  "health-supervisor:get": { kind: "invoke", pages: ALL },
  "renderer:health": { kind: "send", pages: ALL, schema: object },
  // A window's answer to app:closing: its live transports are stopped (ShutdownController waits for it).
  "app:closing-done": { kind: "send", pages: ALL },
  "remediation:report": { kind: "send", pages: ALL, schema: (v) => keys(v, REMEDIATION_FIELDS) && object(v)
    && string(v.page_instance_id, 128) && !!v.page_instance_id && string(v.mechanism_id, 128) && wireBytes(v) <= REMEDIATION_MAX_BYTES },
  "window:release-page-width-lock": { kind: "invoke", pages: MAIN },
  "watch-pages-window:open": { kind: "invoke", pages: MAIN },
  // 設定 → 資料儲存: the native folder picker (returns a path only; nothing is read or written).
  "dialog:pick-folder": { kind: "invoke", pages: MAIN },
  // A yes/no question before a destructive or repeated action (the renderer never uses window.confirm).
  "dialog:confirm": { kind: "invoke", pages: TRADE, schema: (v) => keys(v, ["message"]) && string(v.message, 1024) && !!v.message.trim() },
  "window:fit-page-content": { kind: "invoke", pages: MAIN, schema: object },
  "startup:renderer-step": { kind: "invoke", pages: MAIN, schema: object },
  "detached-view:open": { kind: "invoke", pages: ["index.html", "detached_view.html"], schema: (v) => viewDescriptorErrors(v).length === 0 },
  "google-form:submit-trade": { kind: "invoke", pages: TRADE, schema: form },
  "trade-window:open": { kind: "invoke", pages: MAIN, schema: (v) => keys(v, ["mode", "action", "market", "trade"])
    && (v.mode === undefined || ["add", "edit"].includes(v.mode))
    && (v.action === undefined || ["買進", "賣出"].includes(v.action))
    && (v.market === undefined || ["台股", "美股"].includes(v.market))
    && (v.trade === undefined || object(v.trade)) },
  "trade-window:close": { kind: "invoke", pages: ["trade_window.html"] },
  "trade-window:changed": { kind: "invoke", pages: TRADE, schema: (v) => keys(v, ["kind", "trade_id"])
    && ["add", "edit", "delete", "add-synced"].includes(v.kind)
    && (v.trade_id === undefined || string(v.trade_id)) },
  "trade-window:fit-content": { kind: "invoke", pages: ["trade_window.html"], schema: (v) => keys(v, ["width", "height"])
    && [v.width, v.height].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 16384) },
  "watch-pages:load-local": { kind: "invoke", pages: ["index.html", ...EDITOR] },
  "product-catalog:search-local": { kind: "invoke", pages: ["index.html", ...EDITOR, "workspace_view.html"], schema: optionalObject },
  // instrument_names.js, loaded by every live view page: the catalog names of these codes.
  "product-catalog:names": { kind: "invoke", pages: LIVE_VIEWER, schema: (v) => keys(v, ["source", "codes"])
    && ["shioaji", "futu"].includes(v.source) && Array.isArray(v.codes) && v.codes.length <= 5000 && v.codes.every(symbol) },
  // 商品頁設定 and 設定 → 訂閱管理 both save the pages and the 訂閱偏好: every other window reads them again.
  "watch-pages-window:changed": { kind: "invoke", pages: ["index.html", ...EDITOR], schema: (v) => keys(v, ["kind"]) && ["saved", "page-order"].includes(v.kind) },
  "layout-editor:open": { kind: "invoke", pages: MAIN, schema: (v) => keys(v, []) },
  "workspace-view:open": { kind: "invoke", pages: MAIN, schema: (v) => keys(v, ["seedSymbol"])
    && (v.seedSymbol === undefined || v.seedSymbol === "" || symbol(v.seedSymbol)) },
  // Settings page (06, 07): Health's monitoring snapshot and network operations, main window only.
  "monitoring:snapshot": { kind: "invoke", pages: MAIN, schema: (v) => keys(v, ["trendSince"]) && (v.trendSince === undefined || (Number.isFinite(v.trendSince) && v.trendSince >= 0)) },
  "monitoring:request-detail": { kind: "invoke", pages: MAIN },
  "network:operations": { kind: "invoke", pages: MAIN },
  "network:preview": { kind: "invoke", pages: MAIN, schema: (v) => keys(v, ["candidate_revision"]) && revision(v.candidate_revision) },
  "network:apply": { kind: "invoke", pages: MAIN, schema: (v) => keys(v, ["candidate_revision", "expected_active_revision", "operation_id"])
    && revision(v.candidate_revision)
    && (v.expected_active_revision === null || v.expected_active_revision === undefined || revision(v.expected_active_revision))
    && (v.operation_id === undefined || (string(v.operation_id, 80) && /^[A-Za-z0-9._-]+$/.test(v.operation_id))) },
  "autostart:get": { kind: "invoke", pages: MAIN },
  "autostart:set": { kind: "invoke", pages: MAIN, schema: (v) => keys(v, ["enabled"]) && typeof v.enabled === "boolean" },
  "provider-sdk:status": { kind: "invoke", pages: MAIN },
  "provider-sdk:install": { kind: "invoke", pages: MAIN, schema: (v) => keys(v, ["provider"]) && ["shioaji", "futu"].includes(v.provider) },
  // 新版提示: what the installed App last learned of its newest release, and opening that release's page in the browser.
  "app-update:get": { kind: "invoke", pages: MAIN },
  "app-update:open": { kind: "invoke", pages: MAIN },
  // Main -> renderer.
  "app-update:changed": { kind: "push" },
  "preferences:colors-changed": { kind: "push" },
  "provider-sdk:progress": { kind: "push" },
  "app:closing": { kind: "push" },
  "workspace-view:seed": { kind: "push" },
  "detached-view:descriptor": { kind: "push" },
  "trade-window:payload": { kind: "push" },
  "watch-pages-window:changed:push": { kind: "push", wire: "watch-pages-window:changed" },
  "product-catalog:changed": { kind: "push" },
  "trade-window:changed:push": { kind: "push", wire: "trade-window:changed" },
  "backend-ready": { kind: "push" },
  "startup-progress": { kind: "push" },
});

for (const [channel, rule] of Object.entries(CHANNELS)) {
  if (!["invoke", "send", "sync", "push"].includes(rule.kind)) throw new Error(`IPC channel ${channel}: unknown kind ${rule.kind}`);
  if (rule.kind !== "push" && !Array.isArray(rule.pages)) throw new Error(`IPC channel ${channel}: no pages`);
}

/** The rule of a renderer -> main channel, or null (a push channel is never something a renderer sends). */
function channelRule(channel) {
  const rule = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : null;
  return rule && rule.kind !== "push" ? { pages: rule.pages, kind: rule.kind, schema: rule.schema || empty } : null;
}

/** The wire names main pushes on (a push may share its name with an invoke channel). */
const PUSH_CHANNELS = Object.freeze(Object.entries(CHANNELS).filter(([, r]) => r.kind === "push").map(([name, r]) => r.wire || name));

module.exports = {
  CHANNELS, channelRule, PUSH_CHANNELS, PAGES: Object.freeze({ ALL, MAIN, TRADE, EDITOR, LIVE_VIEWER }),
  DETACHED_WINDOWS, DETACHED_COMPONENT_IDS, VIEW_DESCRIPTOR_VERSION, viewDescriptorErrors, wireBytes,
};
