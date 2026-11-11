"use strict";

// The remediation event contract (docs/system-architecture/07_monitoring.md section 5): one event schema, one registry
// (config/remediation_registry.json), one writer (Health, health/remediation/ledger.js), reached through one local
// pipe. This module is what every Node participant shares -- the writer validates with it, the Node client
// (service/platform/js/remediation_client.js) builds events and frames with it. service/platform/remediation.py and
// native/market_runtime/src/remediation.rs implement the same frame and the same event shape.
//
// Frame: a 4-byte little-endian length, then that many bytes of UTF-8 JSON (one event). Bounded by limits.frame_bytes.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "..", "remediation_registry.json");
const PIPE_ENV = "STOCK_MONITOR_REMEDIATION_PIPE";
// What a secret is (a key name, or a value: query token, Authorization/Bearer, JWT, private key): config/secret_scrub.json.
// The client scrubs detail with it; the writer refuses an event that still carries one.
const { secretName, secretSpans, scrubText, scrubValue } = require("./secret_scrub.js");
const { pathKey } = require("./path_policy.js");

let registry = null;
function loadRegistry() {
  if (!registry) registry = Object.freeze(JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")));
  return registry;
}

// One writer per installation: derived from where the logs go, so a process that outlived a Health restart (Rust A/B,
// the provider daemons) and a re-opened UI reach the next Health on the same name.
function pipePath({ logsRoot, platform = process.platform } = {}) {
  if (!logsRoot) throw new Error("pipePath needs the resolved logs root");
  const key = crypto.createHash("sha256").update(pathKey(logsRoot, platform)).digest("hex").slice(0, 16);
  return platform === "win32" ? `\\\\.\\pipe\\stock-monitor-remediation-${key}`
    : path.join(os.tmpdir(), `stock-monitor-remediation-${key}.sock`);
}

function emptyIdentity() {
  return Object.fromEntries(loadRegistry().identity_fields.map((field) => [field, null]));
}

function boundedString(value, limit) {
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// A detail scalar as written: null/boolean/finite number kept, a string scrubbed, a nested structure scrubbed at every
// depth and written as JSON, anything else as its scrubbed text -- all bounded to limit characters.
function scalarOrText(value, limit) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") return boundedString(JSON.stringify(scrubValue(value, 1)), limit);
  return boundedString(scrubText(String(value)), limit);
}

// Detail is diagnostic context: scalars (and short scalar arrays) only, bounded, with no secret anywhere in it --
// secret keys dropped at every depth and every string scrubbed by value (config/secret_scrub.json).
function sanitizeDetail(detail) {
  const { limits } = loadRegistry();
  const out = {};
  const totals = {};
  for (const [key, value] of Object.entries(detail || {}).slice(0, limits.detail_keys)) {
    if (secretName(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 16).map((item) => scalarOrText(item, 128));
      if (value.length > 16) totals[`${key}_total`] = value.length;
    } else {
      out[key] = scalarOrText(value, limits.string_chars);
    }
  }
  // Never a silent cut: how many items a list had when it had more than were kept, within the key limit.
  for (const [key, total] of Object.entries(totals)) {
    if (Object.keys(out).length >= limits.detail_keys) break;
    if (!(key in out)) out[key] = total;
  }
  return out;
}

// Builds a complete event. process: { service_id, instance_id, pid, runtime }. Unknown identity fields stay null.
function createEvent({ process: proc, component, mechanismId, triggerReason, identity = {}, attempt = null, outcome,
  operationId = null, relatedUpstreamEventId = null, detail = {}, at = new Date() }) {
  const reg = loadRegistry();
  const fullIdentity = emptyIdentity();
  for (const field of reg.identity_fields) {
    if (identity[field] !== undefined && identity[field] !== null) fullIdentity[field] = boundedString(identity[field], 256);
  }
  return {
    schema: reg.event_schema,
    event_id: crypto.randomUUID(),
    at: localIso(at),
    process: { service_id: proc.service_id, instance_id: proc.instance_id, pid: proc.pid ?? null, runtime: proc.runtime },
    component,
    mechanism_id: mechanismId,
    trigger_reason: triggerReason,
    identity: fullIdentity,
    attempt: attempt === null || attempt === undefined ? null : Number(attempt),
    outcome,
    related_upstream_event_id: relatedUpstreamEventId,
    operation_id: operationId,
    detail: sanitizeDetail(detail),
  };
}

// ISO-8601 with the local offset (the contract's "2026-10-07T15:04:05.123+08:00").
function localIso(date = new Date()) {
  const pad = (value, width = 2) => String(Math.trunc(Math.abs(value))).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    + `:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const isNullableString = (value) => value === null || (typeof value === "string" && value.length > 0 && value.length <= 256);

// The writer's admission check. Returns null when the event is valid, else the reason it is refused.
function validateEvent(event) {
  const reg = loadRegistry();
  if (!event || typeof event !== "object" || Array.isArray(event)) return "event is not an object";
  if (event.schema !== reg.event_schema) return `schema must be ${reg.event_schema}`;
  if (typeof event.event_id !== "string" || !/^[0-9A-Za-z-]{8,64}$/.test(event.event_id)) return "event_id missing or malformed";
  if (typeof event.at !== "string" || !ISO_AT.test(event.at) || Number.isNaN(Date.parse(event.at))) return "at is not an ISO-8601 timestamp";
  const proc = event.process;
  if (!proc || typeof proc !== "object") return "process missing";
  if (typeof proc.service_id !== "string" || !proc.service_id) return "process.service_id missing";
  if (typeof proc.instance_id !== "string" || !proc.instance_id) return "process.instance_id missing";
  if (!(proc.pid === null || (Number.isInteger(proc.pid) && proc.pid > 0))) return "process.pid must be a positive integer or null";
  if (!reg.runtimes.includes(proc.runtime)) return `process.runtime must be one of ${reg.runtimes.join(", ")}`;
  if (typeof event.component !== "string" || !event.component) return "component missing";
  const mechanism = reg.mechanisms[event.mechanism_id];
  if (!mechanism) return `unregistered mechanism_id ${String(event.mechanism_id).slice(0, 80)}`;
  if (!mechanism.trigger_reasons.includes(event.trigger_reason)) return `trigger_reason ${String(event.trigger_reason).slice(0, 80)} is not registered for ${event.mechanism_id}`;
  if (!reg.outcomes.includes(event.outcome)) return `outcome must be one of ${reg.outcomes.join(", ")}`;
  const identity = event.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return "identity missing";
  for (const field of reg.identity_fields) {
    if (!(field in identity)) return `identity.${field} missing (unknown is null, never omitted)`;
    if (!isNullableString(identity[field])) return `identity.${field} must be a string or null`;
  }
  for (const field of Object.keys(identity)) if (!reg.identity_fields.includes(field)) return `identity.${field} is not a contract field`;
  if (!(event.attempt === null || (Number.isInteger(event.attempt) && event.attempt >= 0))) return "attempt must be a non-negative integer or null";
  if (!isNullableString(event.operation_id)) return "operation_id must be a string or null";
  if (!isNullableString(event.related_upstream_event_id)) return "related_upstream_event_id must be a string or null";
  // A remediation that runs over time is announced (started) and closed (one terminal outcome) under one
  // operation_id, the result pointing back at the started event. A one-shot remediation is a single terminal event
  // with neither.
  if (event.outcome === "started") {
    if (event.operation_id === null) return "a started event must carry the operation_id its result will share";
    if (event.related_upstream_event_id !== null) return "a started event is the trigger; it has no related_upstream_event_id";
  } else if ((event.operation_id === null) !== (event.related_upstream_event_id === null)) {
    return "a result carries operation_id and related_upstream_event_id together (an operation's result) or neither (a one-shot event)";
  }
  const detail = event.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "detail must be an object";
  const keys = Object.keys(detail);
  if (keys.length > reg.limits.detail_keys) return "detail has too many keys";
  for (const key of keys) {
    if (secretName(key)) return `detail.${key} looks like a credential`;
    const value = detail[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return `detail.${key} must be a scalar`;
    if (typeof value === "string" && value.length > reg.limits.string_chars) return `detail.${key} is too long`;
    const texts = Array.isArray(value) ? value.filter((item) => typeof item === "string") : typeof value === "string" ? [value] : [];
    if (Array.isArray(value) && value.some((item) => item !== null && typeof item === "object")) return `detail.${key} must hold scalars only`;
    if (texts.some((text) => secretSpans(text).length)) return `detail.${key} carries a credential value`;
  }
  return null;
}

function encodeFrame(event) {
  const body = Buffer.from(JSON.stringify(event), "utf8");
  if (body.length > loadRegistry().limits.frame_bytes) {
    const error = new Error(`remediation frame of ${body.length} bytes exceeds ${loadRegistry().limits.frame_bytes}`);
    error.code = "FRAME_TOO_LARGE";
    throw error;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Incremental decoder for one connection. onFrame(event|null, error|null) per frame; a length beyond the limit
// poisons the connection (the caller closes it): the stream can no longer be re-synchronized.
function createFrameDecoder(onFrame) {
  const limit = loadRegistry().limits.frame_bytes;
  let buffer = Buffer.alloc(0);
  let poisoned = false;
  return {
    push(chunk) {
      if (poisoned) return false;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (size === 0 || size > limit) { poisoned = true; onFrame(null, `frame length ${size} outside 1..${limit}`); return false; }
        if (buffer.length < 4 + size) break;
        const body = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        let event = null;
        try { event = JSON.parse(body.toString("utf8")); } catch (error) { /* not an error: handed to onFrame as the frame's refusal, which the ledger records */ onFrame(null, `frame is not JSON: ${error.message}`); continue; }
        onFrame(event, null);
      }
      return true;
    },
  };
}

module.exports = {
  REGISTRY_PATH, PIPE_ENV, loadRegistry, pipePath, emptyIdentity, sanitizeDetail, createEvent, localIso,
  validateEvent, encodeFrame, createFrameDecoder,
};
