// A live view's identity: the normalized spec (market, code, source, session, trading date, channels, replay) and
// the key the store, Market Runtime's state and every consumer agree on. Pure.
function normalizeChannels(channels) {
  const source = Array.isArray(channels) && channels.length
    ? channels
    : ["summary", "trend", "trades", "orderbook", "tradeflow", "price_volume"];
  // Channel order is not part of view identity. Sorting lets two tabs asking
  // for the same channels share one subscription/cache entry.
  return [...new Set(source.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))].sort();
}

// The session a view spec means when it names none. For Shioaji STK / IDX and every Futu market it is the WAL
// session their events are written under (service/market/shared/session_identity_contract.py _WAL_SESSIONS: DAY for
// STK / IDX, FULL otherwise), so the spec names the state key its events carry -- not a second subscription that never
// binds. Shioaji FUT has no single WAL session (each event's time picks DAY or NIGHT); a FUT spec without one shows
// the day session: a display default, not a WAL identity. tests/renderer_view_spec_session_contract.mjs checks the
// Python table.
const DEFAULT_VIEW_SESSIONS = { "shioaji|STK": "DAY", "shioaji|IDX": "DAY", "shioaji|FUT": "DAY" };

function defaultViewSession(source, market) {
  return DEFAULT_VIEW_SESSIONS[`${source}|${market}`] || "FULL";
}

// A spec names its market (stock_view_spec.js and the other builders): a code alone does not say it, and a view
// subscribed under a guessed market is another instrument's, which never receives a frame.
export function normalizeSpec(spec = {}) {
  const code = String(spec.code || spec.instrument || "").trim().toUpperCase();
  const market = String(spec.market || "").trim().toUpperCase();
  if (!market) throw new TypeError(`a realtime view spec needs its market: ${code || "(no code)"}`);
  return {
    market,
    code,
    source: String(spec.source || (market === "US" || code.includes(".") ? "futu" : "shioaji")).trim().toLowerCase(),
    session: String(spec.session || defaultViewSession(
      String(spec.source || (market === "US" || code.includes(".") ? "futu" : "shioaji")).trim().toLowerCase(),
      market,
    )).trim().toUpperCase(),
    trading_date: String(spec.trading_date || "").slice(0, 10),
    channels: normalizeChannels(spec.channels),
    // 歷史回放: a view of one replay Market Runtime is playing (native/market_runtime/src/replay.rs), never of the
    // live market. Part of the identity: the same stock live and in a replay are two different views.
    ...(spec.replay_id ? { replay_id: String(spec.replay_id) } : {}),
  };
}

// `source` is part of the identity, not decoration. Market Runtime keys state on
// source:MARKET:CODE, so shioaji:US:SPCX and futu:US:SPCX are two different states -- but this
// key left source out, so both collapsed onto one renderer entry and whichever subscribed first
// decided which daemon state the other one silently read.
// A frozen spec cannot change, so its key is computed once (a page reads every product's view through the same
// frozen spec each frame).
const frozenSpecKeys = new WeakMap();
export function specKey(spec = {}) {
  const frozen = spec && typeof spec === "object" && Object.isFrozen(spec);
  if (frozen) { const known = frozenSpecKeys.get(spec); if (known !== undefined) return known; }
  const n = normalizeSpec(spec);
  const key = [n.source, n.market, n.code, n.trading_date, n.session, n.channels.join(","), n.replay_id || ""].join("|");
  if (frozen) frozenSpecKeys.set(spec, key);
  return key;
}
