// 模擬下單's orders for every screen of this window (docs/system-architecture/11): the 模擬帳務 component and 帳務 →
// 模擬帳務 → 委託紀錄 read the same state. app_api pushes a revision over Server-Sent Events
// (/api/paper-wallet/orders/events: placed, read, entered, filled, finished); a newer revision re-reads the day's
// orders. One stream per window, open while anything listens. Never a poll.
//
// New orders come from 模擬帳務's 下單 panel (its search box opens it); place() sends one to the desk.
import { apiGet, apiJsonPost, apiPost } from "./api.js";
import { apiUrl } from "./state.js";
import { startSseStream } from "./sse_stream.js";

const LIVE_BASE = "/api/paper-wallet/orders";
const STREAM_SILENCE_MS = 60000;  // the server sends a heartbeat every 20 s
const STREAM_HEARTBEAT_MS = 20000;

/** `event: <name>` blocks of an SSE buffer, decoded; the incomplete rest is returned to be continued. */
export function parseSseEvents(buffer, eventName) {
  const events = [];
  let rest = String(buffer || "").replace(/\r\n/g, "\n");
  let boundary = rest.indexOf("\n\n");
  while (boundary >= 0) {
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    let name = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (name === eventName && data.length) {
      try { events.push(JSON.parse(data.join("\n"))); } catch (error) { console.warn(`[sse: decoding a ${eventName} frame] failed`, error); }
    }
    boundary = rest.indexOf("\n\n");
  }
  return { events, rest };
}

function createPaperOrdersStore({ get = apiGet, post = apiJsonPost, postEmpty = apiPost, stream = startSseStream, urlOf = apiUrl } = {}) {
  const BASE = LIVE_BASE;
  let state = { orders: [], tradingDate: "", matcher: {}, revision: -1, loaded: false, error: "" };
  const listeners = new Set();
  let stopStream = null;
  let loading = null;
  let wanted = 0;

  function notify() {
    for (const listener of [...listeners]) {
      try { listener(state); } catch (error) { console.warn("[paper orders: listener] failed", error); }
    }
  }

  async function refresh() {
    if (loading) { wanted += 1; return loading; }
    loading = (async () => {
      try {
        const result = await get(BASE);
        if (result?.ok === false) throw new Error(result.error || "讀取委託失敗");
        state = { orders: result.orders || [], tradingDate: result.trading_date || "",
          matcher: result.matcher || {}, revision: Number(result.revision ?? state.revision), loaded: true, error: "" };
      } catch (error) {
        console.warn("[paper orders: reading GET /api/paper-wallet/orders] failed", error);
        state = { ...state, loaded: true, error: String(error?.message || error) };
      } finally {
        loading = null;
      }
      notify();
      if (wanted) { wanted = 0; await refresh(); }
    })();
    return loading;
  }

  function start() {
    if (stopStream) return;
    stopStream = stream({
      url: urlOf(`${BASE}/events`), name: "paper-orders", silenceMs: STREAM_SILENCE_MS, heartbeatMs: STREAM_HEARTBEAT_MS,
      lastIdentity: () => ({ revision: state.revision }),
      onBlock: (buffer) => {
        const parsed = parseSseEvents(buffer, "orders.changed");
        if (parsed.events.some((event) => Number(event?.revision) !== state.revision)) void refresh();
        return parsed.rest;
      },
    });
  }

  function stop() {
    stopStream?.();
    stopStream = null;
  }

  async function act(path, body) {
    const result = body === undefined ? await postEmpty(path) : await post(path, body);
    if (result?.ok === false) throw new Error(result.error || "操作失敗");
    void refresh();
    return result;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) { start(); void refresh(); } else listener(state);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stop();
      };
    },
    current: () => state,
    refresh,
    place: (order) => act(BASE, order),
    cancel: (orderId) => act(`${BASE}/${encodeURIComponent(orderId)}/cancel`),
    reduce: (orderId, qty) => act(`${BASE}/${encodeURIComponent(orderId)}/reduce`, { qty }),
    replace: (orderId, price) => act(`${BASE}/${encodeURIComponent(orderId)}/replace`, { price }),
    fills: (date = "") => get(`${BASE}/fills${date ? `?date=${encodeURIComponent(date)}` : ""}`),
    funds: () => get(`${BASE}/funds`),
    /** The paper ledger's day (its trades and the pairs realized that day: 已實現). */
    day: (date) => get(`/api/paper-wallet/day?market=${encodeURIComponent("台股")}&date=${encodeURIComponent(date)}`),
  };
}

export const paperOrdersStore = createPaperOrdersStore();
export { createPaperOrdersStore };
