import { apiGet } from "../../core/api.js";
import { apiUrl } from "../../core/state.js";
import { startSseStream } from "../../core/sse_stream.js";
import { canonicalMoomooCode } from "../../market_data/moomoo_symbol.js";

// The product lists' holdings pages: 實際庫存 (the actual ledger) and 模擬庫存 (the paper wallet), TW and US each.
// One implementation over both ledgers; they differ only in where the positions are read.

function isUsMarket(value) {
  const market = String(value || "").trim().toLowerCase();
  return market === "美股" || market === "us" || market === "usa";
}

export function parsePositionsChangeEvents(buffer) {
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
    if (name === "positions.changed" && data.length) {
      try { events.push(JSON.parse(data.join("\n"))); } catch (error) { console.warn("[holdings: decoding a positions.changed frame] failed", error); }
    }
    boundary = rest.indexOf("\n\n");
  }
  return { events, rest };
}

// 持倉變動: app_api pushes a ledger's positions revision over Server-Sent Events -- once on connect, then on every
// ledger change (a trade added in any window, a background GAS sync, a rebuild). One stream per ledger and window,
// open while the ledger has subscribers; a newer revision re-reads the positions. The first event after a (re)connect
// carries the current revision, so a change missed while disconnected is caught then. Never a poll.
const STREAM_SILENCE_MS = 60000;  // the server sends a heartbeat every 20 s
const STREAM_HEARTBEAT_MS = 20000;

// The stream's life -- breaks told apart, recorded, backoff reset only by a connection that held -- is the shared SSE
// owner's (core/sse_stream.js); this module only reads its blocks.
export function startPositionsChangeStream({ path = "/api/actual-account/positions/events", name = "positions",
  fetchImpl = (...args) => fetch(...args), urlOf = apiUrl, onRevision, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  record } = {}) {
  let lastRevision = null;
  return startSseStream({
    url: urlOf(path), name, silenceMs: STREAM_SILENCE_MS, heartbeatMs: STREAM_HEARTBEAT_MS,
    fetchImpl, wait, ...(record ? { record } : {}),
    lastIdentity: () => ({ revision: lastRevision }),
    onBlock: (buffer) => {
      const parsed = parsePositionsChangeEvents(buffer);
      for (const event of parsed.events) {
        lastRevision = event?.revision ?? lastRevision;
        onRevision?.(event?.revision);
      }
      return parsed.rest;
    },
  });
}

// `markets`: the holdings pages the ledger has ("tw", "us"); the paper ledger is 台股 only (service/account/capital.py).
function createLedgerHoldings({ ledger, apiPrefix, name, markets = ["tw", "us"] }) {
  const pageIds = { tw: `system-${ledger}-holdings-tw`, us: `system-${ledger}-holdings-us` };
  const tag = `[${ledger.toUpperCase()} HOLDINGS]`;
  const emptyPage = (market) => ({
    id: pageIds[market], name, market, ledger, source: market === "us" ? "futu" : "shioaji",
    codes: [], items: [], count: 0, virtual: true, system: true,
  });

  function buildPage(positions, market) {
    const seen = new Set();
    const items = [];
    for (const position of positions) {
      if ((market === "us") !== isUsMarket(position?.market)) continue;
      if (!Number(position?.qty)) continue;  // a short (sold first, not bought back) is held too, qty < 0
      const raw = String(position?.code || "").trim().toUpperCase();
      const code = market === "us" ? canonicalMoomooCode(raw) : raw;
      if (!code || seen.has(code)) continue;
      seen.add(code);
      items.push({
        code,
        name: String(position?.name || raw),
        market,
        source: market === "us" ? "futu" : "shioaji",
        position_qty: Number(position?.qty) || 0,
        avg_cost: Number(position?.avg_cost) || 0,
        cost_amount: Number.isFinite(Number(position?.cost_amount)) ? Number(position.cost_amount) : null,
        closing_terms: position?.closing_terms ?? null,
        system: true,
      });
    }
    return { ...emptyPage(market), items, codes: items.map((item) => item.code), count: items.length };
  }

  let current = { tw: emptyPage("tw"), us: emptyPage("us"), revision: 0, loadedAt: 0 };
  let loading = null;
  let requestedRevision = 0;
  // The positions stream runs while someone listens: started by the first listener, stopped when the last one leaves.
  let stopStream = null;
  const listeners = new Set();

  const pages = () => ({ tw: current.tw, us: current.us, revision: current.revision, loadedAt: current.loadedAt });

  function notify() {
    for (const listener of [...listeners]) {
      try { listener(pages()); } catch (error) { console.warn(`${tag} listener failed`, error); }
    }
  }

  async function refresh({ force = false, expectedRevision = 0 } = {}) {
    requestedRevision = Math.max(requestedRevision, Number(expectedRevision) || 0);
    if (!force && current.loadedAt && Date.now() - current.loadedAt < 5000) return pages();
    if (loading) {
      await loading;
      if (requestedRevision > current.revision) return refresh({ force: true, expectedRevision: requestedRevision });
      return pages();
    }
    loading = (async () => {
      const payload = await apiGet(`${apiPrefix}/positions`);
      const positions = Array.isArray(payload?.positions) ? payload.positions : [];
      const next = { tw: buildPage(positions, "tw"), us: buildPage(positions, "us"), revision: Number(payload?.revision) || 0, loadedAt: Date.now() };
      // Every field an item carries is shown somewhere (即時持倉: 持股／成本/股／成本), so the comparison is over the
      // whole item as buildPage made it -- a fee recalculation that only moves cost_amount is a change too.
      const signature = (page) => JSON.stringify(page.items);
      const changed = signature(next.tw) !== signature(current.tw) || signature(next.us) !== signature(current.us);
      current = next;
      // Subscribing the holdings is not this window's job: settings_api follows each ledger and lists them for
      // Market Runtime, whether or not a window is open.
      if (changed) notify();
      return pages();
    })().finally(() => { loading = null; });
    const result = await loading;
    if (requestedRevision > current.revision) return refresh({ force: true, expectedRevision: requestedRevision });
    return result;
  }

  function applyRevision(revision) {
    const value = Number(revision);
    if (!Number.isFinite(value) || (current.loadedAt && value === current.revision)) return;
    refresh({ force: true, expectedRevision: value }).catch((error) => console.warn(`${tag} change refresh failed`, error));
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    if (!stopStream && typeof fetch === "function") {
      stopStream = startPositionsChangeStream({ path: `${apiPrefix}/positions/events`, name: `${ledger}-positions`, onRevision: applyRevision });
    }
    return () => {
      if (!listeners.delete(listener) || listeners.size || !stopStream) return;
      // Nobody shows these holdings any more: the stream stops. A later listener opens a new one, whose first event
      // carries the current revision, so a change made meanwhile is read then.
      const stop = stopStream;
      stopStream = null;
      stop();
    };
  }

  return { ledger, name, markets, pageIds, pages, refresh, subscribe };
}

export const actualHoldings = createLedgerHoldings({ ledger: "actual", apiPrefix: "/api/actual-account", name: "實際庫存" });
export const paperHoldings = createLedgerHoldings({ ledger: "paper", apiPrefix: "/api/paper-wallet", name: "模擬庫存", markets: ["tw"] });
// Tab order: 實際庫存, then 模擬庫存.
export const HOLDINGS_LEDGERS = Object.freeze([actualHoldings, paperHoldings]);
// The Futu product list's holdings pages: the ledgers with US holdings.
export const US_HOLDINGS_LEDGERS = Object.freeze(HOLDINGS_LEDGERS.filter((ledger) => ledger.markets.includes("us")));

/** The ledger whose holdings page `pageId` is (TW or US), or null for an ordinary product page. */
export function holdingsLedgerOfPage(pageId) {
  const id = String(pageId || "");
  return HOLDINGS_LEDGERS.find((ledger) => ledger.pageIds.tw === id || ledger.pageIds.us === id) || null;
}
