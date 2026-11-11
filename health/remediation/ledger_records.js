"use strict";

// The remediation ledger's record shapes and pure folds (no I/O): file schemas and names, the local day of an event,
// what counts as an occurrence, and one day's per-mechanism counts with their summary form. Used by the writer, the
// recovery, the summary index and the facade (ledger.js) alike, so a replayed event and a live one fold the same way.

const crypto = require("crypto");

const HEADER_SCHEMA = "stock-monitor-remediation-ledger-header-v1";
const MARKER_SCHEMA = "stock-monitor-remediation-ledger-marker-v1";
const SUMMARY_SCHEMA = "stock-monitor-remediation-daily-summary-v1";
const CHECKPOINT_SCHEMA = "stock-monitor-remediation-ledger-checkpoint-v1";
const FILE_PATTERN = /^remediation-(\d{8})-(\d{3})\.jsonl$/;
const DEDUPE_LIMIT = 20_000;

const pad = (value, width = 2) => String(value).padStart(width, "0");
function localDay(date = new Date()) { return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`; }
// The local date (this machine's, like every producer's) of the event's instant. Parsed, not sliced: `at` carries the
// producer's offset, and Rust producers write UTC ("Z") -- std has no local time zone.
function eventDay(event) { return localDay(new Date(event.at)); }
function shiftDay(day, delta) {
  const date = new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) + delta);
  return localDay(date);
}

// One remediation occurrence = a started event, or a one-shot terminal event (no operation). Results of an
// operation are counted as outcomes, not as further occurrences.
function isOccurrence(event) { return event.outcome === "started" || event.operation_id === null; }

function boundedAdd(set, value, limit = DEDUPE_LIMIT) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

// `services`: occurrences per service the event names (detail.service_id -- Health's automatic restarts, forced
// terminations), so 系統拓樸 can say which service was restarted, today and over 7 days.
function emptyDayStats() {
  return { attempts: 0, successes: 0, failures: 0, abandoned: 0, suppressed: 0, identities: new Set(), max_attempt: 0,
    first_at: null, last_at: null, reasons: new Map(), services: new Map() };
}

// An identity is counted by a digest of it: a day of per-view remediations has tens of thousands of identities, and
// the checkpoint keeps every retained day's set.
function identityKey(identity) { return crypto.createHash("sha1").update(JSON.stringify(identity)).digest("hex").slice(0, 16); }

function foldDay(stats, event) {
  if (isOccurrence(event)) {
    stats.attempts += 1;
    stats.reasons.set(event.trigger_reason, (stats.reasons.get(event.trigger_reason) || 0) + 1);
    stats.identities.add(identityKey(event.identity));
    const service = event.detail?.service_id;
    if (typeof service === "string" && service) stats.services.set(service, (stats.services.get(service) || 0) + 1);
  }
  if (event.outcome === "succeeded") stats.successes += 1;
  else if (event.outcome === "failed") stats.failures += 1;
  else if (event.outcome === "abandoned") stats.abandoned += 1;
  else if (event.outcome === "suppressed") stats.suppressed += 1;
  if (Number.isInteger(event.attempt)) stats.max_attempt = Math.max(stats.max_attempt, event.attempt);
  if (!stats.first_at || event.at < stats.first_at) stats.first_at = event.at;
  if (!stats.last_at || event.at > stats.last_at) stats.last_at = event.at;
}

function statsToJson(stats) {
  return { ...stats, identities: [...stats.identities], reasons: Object.fromEntries(stats.reasons), services: Object.fromEntries(stats.services) };
}
function statsFromJson(value) {
  return { ...emptyDayStats(), ...value, identities: new Set(value.identities || []), reasons: new Map(Object.entries(value.reasons || {})),
    services: new Map(Object.entries(value.services || {})) };
}

function summarizeDay(day, mechanismId, stats, mechanism) {
  return {
    date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`, mechanism_id: mechanismId, attempts: stats.attempts,
    successes: stats.successes, failures: stats.failures, abandoned: stats.abandoned, suppressed: stats.suppressed,
    unique_identity_count: stats.identities.size, max_attempt: stats.max_attempt, first_at: stats.first_at, last_at: stats.last_at,
    top_trigger_reasons: [...stats.reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
      .map(([reason, count]) => ({ reason, count })),
    zero_expected_violation: Boolean(mechanism?.zero_expected) && stats.attempts > 0,
    by_service: Object.fromEntries(stats.services),
  };
}

module.exports = {
  HEADER_SCHEMA, MARKER_SCHEMA, SUMMARY_SCHEMA, CHECKPOINT_SCHEMA, FILE_PATTERN, DEDUPE_LIMIT,
  pad, localDay, eventDay, shiftDay, isOccurrence, boundedAdd, emptyDayStats, foldDay, statsToJson, statsFromJson, summarizeDay,
};
