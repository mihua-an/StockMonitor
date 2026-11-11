import { numberOrNull as finiteNumberOrNull } from "./numbers.js";

/** A trade row's place in the WAL: `ingest_sequence`, the durable sequence every producer sends (Rust A's live tape,
 * the stored pages, history replay). One domain, so live and stored rows order and merge on it. */
export function tradeRowSequence(row = {}) {
  return finiteNumberOrNull(row?.ingest_sequence);
}

function exchangeNsToTaipeiText(value) {
  const ns = Number(value);
  if (!Number.isFinite(ns) || ns <= 0) return "";
  // Native Shioaji timestamps are Unix epoch nanoseconds.  Use UTC getters
  // after applying the fixed Taiwan offset so this does not depend on the
  // workstation timezone or Date.parse's ambiguous handling of bare text.
  const date = new Date(ns / 1_000_000 + 8 * 60 * 60 * 1_000);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part, width = 2) => String(part).padStart(width, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

// Rust/Shioaji frames carry the authoritative exchange clock as Unix epoch
// nanoseconds.  Older adapters may also leave a textual `time`/`datetime`
// field behind (often formatted in UTC, e.g. 05:xx for a 13:xx Taiwan trade).
// When the row is identified as a Shioaji/native frame, the epoch value must
// win so the UI cannot regress to that stale textual representation.
function isShioajiEpochRow(row = {}) {
  const ns = Number(row?.exchange_ts_ns);
  if (!Number.isFinite(ns) || ns <= 0) return false;
  const source = String(row?.source || row?.provider || row?.data_source || "").toLowerCase();
  if (source.includes("futu") || source.includes("moomoo")) return false;
  if (source.includes("shioaji") || source.includes("native")) return true;
  const exchange = String(row?.exchange || "").toLowerCase();
  if (exchange === "tse" || exchange === "otc" || exchange === "taifex") return true;
  // Native focus restore rows from older daemons did not carry `source` or
  // `exchange`, but their instrument identity is still unambiguously Taiwan.
  const market = String(row?.market || row?.security_type || "").toUpperCase();
  const code = String(row?.code || row?.logical_code || "").trim().toUpperCase();
  return ["STK", "IDX", "FUT", "TXF"].includes(market)
    || code === "TXFR1"
    || /^\d{4,6}$/.test(code);
}

export function tradeRowTimestamp(row = {}) {
  if (isShioajiEpochRow(row)) {
    const epochText = exchangeNsToTaipeiText(row.exchange_ts_ns);
    if (epochText) return epochText;
  }
  const text = String(row?.trade_timestamp || row?.datetime || row?.timestamp || row?.exchange_time || row?.time || "");
  return text || exchangeNsToTaipeiText(row?.exchange_ts_ns);
}

/**
 * What a rendered trade row shows, as the parts of a render signature. Shared by every trade table, so a field that
 * is displayed is also one that invalidates: the workspace table kept its own list and missed the quantity scale
 * it formats volumes with (N02).
 */
export function tradeRowDisplayParts(row = {}) {
  return [
    tradeRowDisplayTime(row), row?.price ?? "", row?.volume ?? "",
    row?.tradeSide ?? row?.trade_side ?? row?.side ?? "", row?.quantityScale ?? row?.quantity_scale ?? "",
  ];
}

// A trade row is never modified once it exists (the view state is immutable; a merge builds a new object), so what
// it displays is derived once per row object. Sorting a page compares each row many times, and every update of a
// trade table formats every row it shows.
const displayTimes = new WeakMap();
const canonicalStamps = new WeakMap();

export function tradeRowDisplayTime(row = {}) {
  if (!row || typeof row !== "object") return displayTimeOf(row);
  let text = displayTimes.get(row);
  if (text === undefined) { text = displayTimeOf(row); displayTimes.set(row, text); }
  return text;
}

function displayTimeOf(row = {}) {
  // TradeDetail rows may expose a bare exchange_time, HH:MM:SS, or a full
  // trade_timestamp/datetime. Never slice the first 8 characters from an ISO
  // timestamp (that produces YYYY-MM- instead of the exchange clock time).
  if (isShioajiEpochRow(row)) {
    const epochText = exchangeNsToTaipeiText(row.exchange_ts_ns);
    if (epochText) return epochText.slice(11, 19);
  }
  const candidates = [
    row?.exchange_time,
    row?.time,
    row?.trade_timestamp,
    row?.datetime,
    row?.timestamp,
  ];
  for (const value of candidates) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const embedded = text.match(/(?:T|\s)(\d{2}:\d{2}:\d{2})(?:[.Z+\-]|$)/);
    if (embedded) return embedded[1];
    const clock = text.match(/^(\d{2}:\d{2}:\d{2})(?:[.Z+\-]|$)/);
    if (clock) return clock[1];
  }
  const fallback = exchangeNsToTaipeiText(row?.exchange_ts_ns);
  if (fallback) return fallback.slice(11, 19);
  return "--:--:--";
}

export function canonicalTradeTimestamp(row = {}) {
  if (!row || typeof row !== "object") return canonicalStampOf(row);
  let stamp = canonicalStamps.get(row);
  if (stamp === undefined) { stamp = canonicalStampOf(row); canonicalStamps.set(row, stamp); }
  return stamp;
}

function canonicalStampOf(row = {}) {
  const raw = tradeRowTimestamp(row).trim().replace(" ", "T");
  if (!raw) return "";
  return raw.replace(/\.(\d+)(?=$|Z|[+-]\d\d:?\d\d$)/, (_match, fraction) => `.${String(fraction).padEnd(6, "0").slice(0, 6)}`);
}

export function tradeRowKey(row = {}) {
  // A print's identity is Market Runtime's durable sequence: the live view's rows and the durable page's rows both
  // carry it. `sequence` is not one domain (the view's state version live, the producer's sequence on a stored row),
  // so keying on it showed one print twice once a session was materialized.
  const durable = tradeRowSequence(row);
  if (durable != null && durable > 0) return `d:${durable}`;
  return [
    canonicalTradeTimestamp(row),
    finiteNumberOrNull(row?.price ?? row?.current ?? row?.close) ?? "",
    Number(row?.volume || 0),
  ].join("|");
}

export function compareTradeRowsNewestFirst(a = {}, b = {}) {
  // Exchange time is authoritative across durable Page1 rows and live frames.
  const stampOrder = canonicalTradeTimestamp(b).localeCompare(canonicalTradeTimestamp(a));
  if (stampOrder) return stampOrder;
  const ingestA = tradeRowSequence(a), ingestB = tradeRowSequence(b);
  if (ingestA != null && ingestB != null && ingestA !== ingestB) return ingestB - ingestA;
  return tradeRowKey(b).localeCompare(tradeRowKey(a));
}
