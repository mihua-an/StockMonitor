import assert from "node:assert/strict";

// AA-01 follow-up: the page-level freshness indicator was consolidated into
// the existing bottom-dock WebSocket status dot/text (core/status.js)
// instead of a separate top-of-page banner. This exercises the REAL
// setWebSocketOnline()/setWebSocketFreshness() functions against a minimal
// DOM stub, proving:
//   - the two functions never clobber each other's half of the dot state
//     (setWebSocketOnline is driven by app.js on every connection-state
//     transition/batch; setWebSocketFreshness is driven by
//     pages/realtime.js's freshness recompute -- both can fire in either
//     order without one erasing what the other just set).
//   - "reconnecting" and "connected-but-stale" are visibly distinguishable
//     from a flat online/offline, using the existing .degraded dot class.

function makeElement(id) {
  const classes = new Set();
  return { id, textContent: "", title: "", classList: {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    contains(name) { return classes.has(name); },
  } };
}

const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}
// core/status.js pulls in market_data/realtime.js (for
// getRealtimeViewStats(), used only by the diagnostics popover this test
// never opens) which in turn touches several browser-only globals at module
// load time -- stub the minimal set other renderer tests already use for
// this same dependency chain (see renderer_realtime_frame_parse_error_contract.mjs).
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.document = { getElementById: (id) => el(id), querySelectorAll: () => [] };
globalThis.window = { desktopAPI: {}, dispatchEvent() {}, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };

const { setWebSocketOnline, setWebSocketFreshness } = await import("../ui/renderer/js/core/status.js");

function dotState(id = "wsStatusDot") {
  const dot = el(id);
  return { online: dot.classList.contains("online"), offline: dot.classList.contains("offline"), degraded: dot.classList.contains("degraded") };
}

// --- 1. plain connect/disconnect (app.js's existing behavior) is unaffected ---
setWebSocketOnline(false);
assert.deepEqual(dotState(), { online: false, offline: true, degraded: false });
assert.equal(el("wsStatusText").textContent, "WebSocket 未連線");

setWebSocketOnline(true);
assert.deepEqual(dotState(), { online: true, offline: false, degraded: false });
assert.equal(el("wsStatusText").textContent, "WebSocket 已連線");

// --- 2. connected + stale (the new AA-01 case): the dot must turn
// degraded/amber and the text must say so, without needing a second element ---
setWebSocketFreshness({ tone: "stale", detail: "行情資料未同步，目前畫面可能不是最新資料" });
assert.deepEqual(dotState(), { online: false, offline: false, degraded: true }, "connected+stale must read as degraded, not plain online");
assert.equal(el("wsStatusText").textContent, "WebSocket 已連線（資料未同步）");
assert.equal(el("wsStatusDot").title, "", "no hover text: the label says it (user 10-20)");

// --- 3. app.js's own frequent setWebSocketOnline(true) calls (e.g. from
// every realtime batch carrying connection info) must NOT silently clear
// the freshness degradation that's still in effect ---
setWebSocketOnline(true);
assert.deepEqual(dotState(), { online: false, offline: false, degraded: true }, "a routine setWebSocketOnline(true) call must not erase an active staleness warning");

// --- 4. fresh tick arrives -> pages/realtime.js clears freshness -> dot
// returns to a plain online state ---
setWebSocketFreshness({ tone: null, detail: "" });
assert.deepEqual(dotState(), { online: true, offline: false, degraded: false });
assert.equal(el("wsStatusText").textContent, "WebSocket 已連線");
assert.equal(el("wsStatusDot").title, "");

// --- 5. reconnecting must be visibly distinct from a flat "disconnected" ---
setWebSocketOnline(false);
setWebSocketFreshness({ tone: "reconnecting", detail: "重新連線中，目前畫面為最後收到的行情，非即時資料" });
assert.deepEqual(dotState(), { online: false, offline: false, degraded: true });
assert.equal(el("wsStatusText").textContent, "WebSocket 重新連線中");

// --- 6. disconnected tone needs no special-casing: plain offline label is
// already correct once wsOnline is false ---
setWebSocketFreshness({ tone: "disconnected", detail: "連線已中斷，目前畫面為最後收到的行情，非即時資料" });
assert.deepEqual(dotState(), { online: false, offline: true, degraded: false });
assert.equal(el("wsStatusText").textContent, "WebSocket 未連線");

// --- 7. order independence: setWebSocketFreshness arriving BEFORE
// setWebSocketOnline for the same transition must still land correctly
// (the two subscribers to subscribeRealtimeConnectionState in app.js and
// pages/realtime.js are not guaranteed to fire in a fixed relative order) ---
setWebSocketFreshness({ tone: "stale", detail: "test" });
setWebSocketOnline(true);
assert.deepEqual(dotState(), { online: false, offline: false, degraded: true });
setWebSocketOnline(true);
setWebSocketFreshness({ tone: "stale", detail: "test" });
assert.deepEqual(dotState(), { online: false, offline: false, degraded: true });

console.log("WebSocket status consolidation contract passed: online/offline, stale, reconnecting all render from the one dot without either setter clobbering the other");
