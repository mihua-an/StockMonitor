// Taiwan market time, independent of the computer's time zone. 台股 timestamps from the backend are either ISO with an
// offset or naive Taipei wall-clock text; both mean Asia/Taipei (UTC+8, no daylight saving), never the machine's zone.

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/** An ISO timestamp -> epoch ms; text without an offset is Taipei wall-clock. null when it is not a timestamp. */
export function parseTaipeiTimestampMs(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let iso = text.replace(" ", "T");
  if (!HAS_ZONE.test(iso)) {
    if (!ISO_LOCAL.test(text)) return null;
    if (!iso.includes("T")) iso += "T00:00:00";
    iso += "+08:00";
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms -> the Taipei wall clock {year, month, day, hour, minute, second, secondsOfDay}; null for a non-finite ms. */
export function taipeiParts(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  const d = new Date(value + TAIPEI_OFFSET_MS);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour, minute, second, secondsOfDay: hour * 3600 + minute * 60 + second,
  };
}

/** Epoch ms -> "YYYY-MM-DD" in Taipei; "" for a non-finite ms. */
export function taipeiDateKey(ms) {
  const p = taipeiParts(ms);
  if (!p) return "";
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Epoch ms -> "HH:MM" (or "HH:MM:SS" with seconds) in Taipei; "--" for a non-finite ms. */
export function taipeiClockText(ms, { seconds = false } = {}) {
  const p = taipeiParts(ms);
  if (!p) return "--";
  const parts = [p.hour, p.minute].concat(seconds ? [p.second] : []);
  return parts.map((n) => String(n).padStart(2, "0")).join(":");
}

/** The epoch ms of Taipei midnight that starts the day containing `ms`. */
export function taipeiDayStartMs(ms) {
  return Math.floor((Number(ms) + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS;
}

const EXCHANGE_CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const CLOCK_IN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/;

/**
 * An exchange clock -> {hour, minute, second, secondsOfDay}, or null when it is not a valid 24-hour clock.
 * Accepts "H:MM", "HH:MM", "HH:MM:SS" (fraction ignored) and a timestamp "YYYY-MM-DD HH:MM:SS" / ISO, whose clock part
 * is read as written (the exchange's own wall clock); anything else, or an hour > 23 / minute or second > 59, is null.
 */
export function parseExchangeClock(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const clock = EXCHANGE_CLOCK.test(text) ? text : (text.match(CLOCK_IN_TIMESTAMP)?.[1] || "");
  const match = clock.match(EXCHANGE_CLOCK);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] == null ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second, secondsOfDay: hour * 3600 + minute * 60 + second };
}
