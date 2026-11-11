// A window's remediation events (the remediation event contract in docs/BACKLOG.md).
//
// Every reconnect, resync, refetch or retry a window performs is recorded in Health's ledger. A renderer cannot reach
// the ledger itself: events go through the narrow `remediation:report` IPC, Electron main stamps them with the sending
// page's process identity, and Health checks them against config/remediation_registry.json. The event shape is the
// one config/js/remediation_contract.js builds; IDENTITY_FIELDS mirrors the registry's identity_fields
// (tests/renderer_remediation_contract.mjs keeps the two equal).
//
// emitRemediation() records a one-shot remediation. beginRemediation() announces one that runs over time and returns
// a handle whose finish() records its single terminal outcome; one still open when the page goes away is recorded as
// abandoned. Reporting never throws into the caller.

const SCHEMA = "stock-monitor-remediation-event-v1";
export const IDENTITY_FIELDS = Object.freeze(["source", "market", "code", "session", "trading_date", "view_id", "subscription_id", "connection_id"]);

function newId() {
  try { return crypto.randomUUID(); } catch (_error) { /* not an error: no crypto.randomUUID: a time-and-random id is used */ return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 14)}`; }
}

// One id per page load: the renderer's "instance".
const PAGE_INSTANCE_ID = newId();
const open = new Set();

function localIso(date = new Date()) {
  const pad = (value, width = 2) => String(Math.trunc(Math.abs(value))).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    + `:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function scalarDetail(detail) {
  const out = {};
  for (const [key, value] of Object.entries(detail || {}).slice(0, 32)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") out[key] = Number.isNaN(value) ? null : value;
    else out[key] = String(value).slice(0, 500);
  }
  return out;
}

function report(event, transport) {
  try { transport({ ...event, page_instance_id: PAGE_INSTANCE_ID }); } catch (error) { console.warn("[remediation: reporting an event] failed", error); }
}

function defaultTransport(payload) {
  window.desktopAPI?.reportRemediation?.(payload);
}

export function buildRemediationEvent({ component, mechanismId, triggerReason, identity = {}, attempt = null, outcome,
  operationId = null, relatedUpstreamEventId = null, detail = {} }) {
  return {
    schema: SCHEMA, event_id: newId(), at: localIso(), component, mechanism_id: mechanismId, trigger_reason: triggerReason,
    identity: Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field] === undefined || identity[field] === null
      || identity[field] === "" ? null : String(identity[field]).slice(0, 256)])),
    attempt: attempt === null || attempt === undefined ? null : Math.max(0, Math.trunc(Number(attempt)) || 0),
    outcome, related_upstream_event_id: relatedUpstreamEventId, operation_id: operationId, detail: scalarDetail(detail),
  };
}

export function emitRemediation(fields, transport = defaultTransport) {
  const event = buildRemediationEvent(fields);
  report(event, transport);
  return event;
}

export function beginRemediation({ component, mechanismId, triggerReason, identity = {}, detail = {} }, transport = defaultTransport) {
  const operationId = newId();
  const started = emitRemediation({ component, mechanismId, triggerReason, identity, attempt: 0, outcome: "started", operationId, detail }, transport);
  let finished = null;
  const handle = {
    operationId,
    startedEvent: started,
    get finished() { return finished !== null; },
    finish(outcome, { attempt = null, detail: resultDetail = {} } = {}) {
      if (finished) return finished;
      open.delete(handle);
      finished = emitRemediation({ component, mechanismId, triggerReason, identity, attempt, outcome, operationId,
        relatedUpstreamEventId: started.event_id, detail: resultDetail }, transport);
      return finished;
    },
  };
  open.add(handle);
  return handle;
}

// A remediation still running when the page unloads ends here, as abandoned -- never as silence.
try {
  window.addEventListener("pagehide", () => {
    for (const handle of [...open]) handle.finish("abandoned", { detail: { reason: "page unloaded" } });
  });
} catch (_error) { /* not an error: no window (tests): nothing to hook */ }
