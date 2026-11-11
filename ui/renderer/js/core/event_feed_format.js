import { escapeHtml } from "./utility.js";

function clockText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  // Canonical market timestamps are already normalized by the backend.  Extract
  // their wall-clock text without any browser host-timezone conversion.
  const matched = text.match(/(?:T|\s)(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (matched) return matched[1];
  const direct = text.match(/^(\d{2}:\d{2}:\d{2})/);
  return direct ? direct[1] : "";
}

// Rust B publishes rule events (docs/system-architecture/02 section 6) as records with rule_id / label / direction /
// trigger_minute / state. The feed renders rows with date / time (HH:MM:SS) / info / categories; this is the one
// adapter between the two. A REVOKED record (its condition no longer holds after a revision) is marked so the tape
// drops it rather than showing a withdrawn alert. Rust B is the only event producer: any other record (no
// analysis_runtime origin, no trigger_minute, no event_id) is refused with a warning and returns null.
export function normalizeMonitorEvent(event) {
  if (!event || typeof event !== "object") return null;
  const minute = Number(event.trigger_minute);
  if (String(event.event_origin || "") !== "analysis_runtime" || event.trigger_minute == null || !Number.isInteger(minute) || minute < 0) {
    console.warn("[event feed] event refused: not a Rust B rule record", event);
    return null;
  }
  if (!String(event.event_id || "")) {
    console.warn("[event feed] event refused: a Rust B record without event_id", event);
    return null;
  }
  // The second comes from B's triggered_at_ns (first sighting; an UPDATED revision moves as_of_ns, never this), so
  // the feed shows and sorts by the real trigger time. Market offsets are whole minutes, so the UTC second is the
  // market second. A minute B only caught up on carries no triggered_at_ns and shows :00.
  const triggeredNs = String(event.triggered_at_ns ?? "");
  const second = /^\d{10,}$/.test(triggeredNs) ? Number((BigInt(triggeredNs) / 1000000000n) % 60n) : 0;
  const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  const direction = String(event.direction || "").toLowerCase();
  const categories = direction === "up" ? ["up"] : direction === "down" ? ["down"] : [];
  // 量比: this event's volume against the usual volume of the same minutes (Rust B events.rs, past 22 sessions).
  const volumeRatio = Number(event.detail?.volume_ratio);
  return {
    ...event,
    date: event.trading_date,
    time,
    info: event.label,
    volume_ratio: Number.isFinite(volumeRatio) ? volumeRatio : null,
    categories,
    revoked: String(event.state || "").toUpperCase() === "REVOKED",
  };
}

// Rust B's rule records (rule_id / label / trigger_minute) carry no `info` and an HH:MM `time`; the live feed
// adapts them through normalizeMonitorEvent, the replay did not, so every row showed "--" and every marker read
// 「事件」. Same adapter here; revoked records are withdrawn and the newest revision of an event wins.
export function normalizeHistoryEvents(events = []) {
  const byId = new Map();
  for (const raw of Array.isArray(events) ? events : []) {
    const event = normalizeMonitorEvent(raw);
    if (!event) continue;
    const id = String(event.event_id);
    const previous = byId.get(id);
    if (!previous || Number(event.revision || 0) >= Number(previous.revision || 0)) byId.set(id, event);
  }
  return [...byId.values()].filter((event) => !event.revoked)
    .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
}

export function eventDisplayTime(event) {
  return clockText(event?.time) || "--";
}

// An event's identity: B's event_id (rule, instrument, session, trigger minute), which a revision keeps, and the only
// one: normalizeMonitorEvent refuses a record without it, so no row is ever identified by what it shows (two events
// with the same code, second and text were one row, and a click selected the first). The 即時資訊 rows, the tape and
// the history markers all key by it; "" for a record that has none.
export function eventFeedKey(event) {
  const id = String(event?.event_id || "");
  return id ? `id:${id}` : "";
}

// The row's colour is the event's direction; a rule without a direction is flat.
export function eventInfoClass(event) {
  const categories = Array.isArray(event?.categories) ? event.categories : [];
  const up = categories.includes("up"), down = categories.includes("down");
  if (up && !down) return "price-up";
  if (down && !up) return "price-down";
  return "price-flat";
}

function eventToken(text, className = "neutral") {
  return `<span class="event-feed-token ${className}">${escapeHtml(text)}</span>`;
}

export function renderEventInfoHtml(event) {
  const info = String(event?.info || "--");
  // 量比 on every price event that has one -- (0.6x) is information too (a move on little volume).
  const ratio = Number(event?.volume_ratio);
  const volume = event?.volume_ratio != null && Number.isFinite(ratio) ? eventToken(` (${ratio.toFixed(1)}x)`, "neutral") : "";
  // The label is B's rule label as written; its colour is the rule's direction, never read out of the text.
  const direction = event?.direction === "up" || event?.direction === "down" ? event.direction : "neutral";
  return eventToken(info, direction) + volume;
}
