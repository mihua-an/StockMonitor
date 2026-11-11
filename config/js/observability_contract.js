"use strict";

// Monitoring and apply-operation shapes (docs/system-architecture/07 section 2, 06 section 5), shared by Health,
// Electron main and the settings renderer. Python mirror: config/observability_contract.py (same field names, same
// validation, a missing sampled_at filled with the current time in both), proven equal on the complete serialized
// metric by the shared cases in tests/fixtures/observability_metric_cases.json (tests/observability_contract_contract.cjs
// and tests/test_observability_contract_cases.py).
//
// Rules encoded here, not re-decided by each consumer:
// * a metric's absence is an availability reason, never a zero (07 section 2);
// * a percentage exists only when the capacity is known (07 section 3);
// * a service's run state and its pending-config state are separate fields (07 section 2).

const { contract } = require("./system_contract.js");

const DESCRIPTOR_SCHEMA = "stock-monitor-service-descriptor-v1";
const METRIC_SCHEMA = "stock-monitor-metric-snapshot-v1";
const OPERATION_SCHEMA = "stock-monitor-apply-operation-v1";

const c = contract();
const SERVICE_STATES = new Set(c.service_states);
const AVAILABILITY = new Set(c.metric_availability);
const KINDS = new Set(c.metric_kinds);
const OPERATION_STATES = new Set(c.operation_states);
const STEP_NAMES = new Set(c.operation_service_steps);

function serviceDescriptor({
  serviceId, workerId = null, displayName, parent = null, instanceId = null, pid = null,
  protocol = null, addresses = {}, configRevision = null, pendingOperation = null, state = "UNKNOWN",
  stateReason = null, observedAt = null,
}) {
  if (!serviceId && !workerId) throw new Error("service_id or worker_id is required");
  if (!SERVICE_STATES.has(state)) throw new Error(`unknown service state ${state}`);
  const address = (value) => (value === undefined ? null : value);
  return {
    schema: DESCRIPTOR_SCHEMA, service_id: serviceId || null, worker_id: workerId, display_name: displayName || serviceId,
    parent, instance_id: instanceId, pid, protocol,
    addresses: {
      default: address(addresses.default), saved: address(addresses.saved),
      effective: address(addresses.effective), observed: address(addresses.observed),
    },
    config_revision: configRevision, pending_operation: pendingOperation,
    state, state_reason: stateReason, observed_at: observedAt,
  };
}

// value === null requires a non-OK availability; an OK value must be a finite number.
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function metric({ name, serviceId, instanceId = null, stream = null, sampledAt = null, windowMs = null, value = null,
  unit, availability = null, reason = null, kind = "gauge", capacity = null, extra = {} }) {
  const hasValue = isNumber(value);
  if (typeof unit !== "string" || !unit) throw new Error(`metric ${name}: unit must be a non-empty string`);
  if (!KINDS.has(kind)) throw new Error(`metric ${name}: unknown kind ${kind}`);
  if (windowMs !== null && !(Number.isInteger(windowMs) && windowMs >= 0)) {
    throw new Error(`metric ${name}: window_ms must be a non-negative integer or None`);
  }
  if (capacity !== null && !(isNumber(capacity) && capacity >= 0)) {
    throw new Error(`metric ${name}: capacity must be a non-negative number or None`);
  }
  if (sampledAt !== null && !(typeof sampledAt === "string" && sampledAt)) {
    throw new Error(`metric ${name}: sampled_at must be a timestamp string`);
  }
  const resolved = availability || (hasValue ? "OK" : "NO_SAMPLE");
  if (!AVAILABILITY.has(resolved)) throw new Error(`unknown availability ${resolved}`);
  if (resolved === "OK" && !hasValue) throw new Error(`metric ${name}: OK requires a finite value`);
  if (resolved !== "OK" && resolved !== "STALE" && hasValue) throw new Error(`metric ${name}: ${resolved} must not carry a value`);
  const out = {
    schema: METRIC_SCHEMA, name, service_id: serviceId, instance_id: instanceId, stream, sampled_at: sampledAt || new Date().toISOString(),
    window_ms: windowMs, value: hasValue ? value : null, unit, availability: resolved, reason, kind, ...extra,
  };
  if (capacity !== null) {
    out.capacity = capacity;
    out.utilization = hasValue && capacity > 0 ? value / capacity : null;
  }
  return out;
}

// A failed sample keeps the last value but marks only that metric stale (CFG-05).
function staleMetric(previous, { reason, sampledAt }) {
  if (!previous) return null;
  return { ...previous, availability: "STALE", reason, stale_since: previous.stale_since || sampledAt };
}

function operation({ operationId, kind, expectedActiveRevision, candidateRevision, previousRevision, requestedBy,
  preview = null, state = "PENDING", services = {}, createdAt = new Date().toISOString() }) {
  if (!operationId) throw new Error("operation_id is required");
  if (!OPERATION_STATES.has(state)) throw new Error(`unknown operation state ${state}`);
  return {
    schema: OPERATION_SCHEMA, operation_id: operationId, kind, expected_active_revision: expectedActiveRevision ?? null,
    candidate_revision: candidateRevision, previous_revision: previousRevision ?? null, requested_by: requestedBy,
    preview, state, services, created_at: createdAt, updated_at: createdAt, history: [{ at: createdAt, state }],
  };
}

function recordStep(op, serviceId, step, { ok, detail = null, at = new Date().toISOString() }) {
  if (!STEP_NAMES.has(step)) throw new Error(`unknown operation step ${step}`);
  const entry = op.services[serviceId] || (op.services[serviceId] = { steps: [], state: "PENDING" });
  entry.steps.push({ step, ok: Boolean(ok), detail, at });
  if (!ok) entry.state = "FAILED";
  else if (step === "effective_recorded") entry.state = "APPLIED";
  else if (entry.state !== "FAILED") entry.state = "RUNNING";
  op.updated_at = at;
  return op;
}

function transition(op, state, { reason = null, at = new Date().toISOString() } = {}) {
  if (!OPERATION_STATES.has(state)) throw new Error(`unknown operation state ${state}`);
  op.state = state;
  op.updated_at = at;
  op.history.push({ at, state, reason });
  return op;
}

// The global verdict is derived from per-service results, never asserted: one failed service is never APPLIED.
function verdict(op) {
  const entries = Object.values(op.services);
  if (!entries.length) return "PENDING";
  const applied = entries.filter((e) => e.state === "APPLIED").length;
  const failed = entries.filter((e) => e.state === "FAILED").length;
  if (applied === entries.length) return "APPLIED";
  if (failed && applied) return "PARTIALLY_APPLIED";
  if (failed) return "FAILED";
  return "RUNNING";
}

module.exports = {
  DESCRIPTOR_SCHEMA, METRIC_SCHEMA, OPERATION_SCHEMA, serviceDescriptor, metric, staleMetric, operation, recordStep,
  transition, verdict,
};
