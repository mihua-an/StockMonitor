"use strict";

// Node half of the one effective-network resolver (docs/system-architecture/06 section 3). The rules are
// config/network_config.py's, line for line; tests/network_config_parity_contract.cjs runs the shared cases in
// tests/fixtures/network_config/cases.json through both languages and requires identical results.
//
// Order: install manifest defaults -> ACTIVE saved "network" revision -> STOCK_MONITOR_PORT_OVERRIDES. A value that
// fails validation never becomes effective. No auto-increment on conflict. Must never require("electron").

const fs = require("fs");
const path = require("path");

const EFFECTIVE_SCHEMA = "stock-monitor-effective-network-v1";
const MANIFEST_SCHEMA = "stock-monitor-network-manifest-v2";
const OVERRIDE_ENV = "STOCK_MONITOR_PORT_OVERRIDES";
const REVISION_ENV = "STOCK_MONITOR_NETWORK_REVISION";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
// A service a renderer may address (manifest "renderer_client": true) must speak one of these.
const RENDERER_PROTOCOLS = ["http", "ws", "http+ws"];

function manifestPath(env = process.env) {
  const resources = process.resourcesPath || String(env.STOCK_MONITOR_RESOURCES_PATH || "").trim();
  if (resources) {
    const packaged = path.join(resources, "app-runtime", "config", "network_manifest.json");
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.resolve(__dirname, "..", "network_manifest.json");
}

const KINDS = ["api", "runtime", "controller", "provider", "external", "worker"];
const SERVICE_ID = /^[a-z][a-z0-9_]{0,40}$/;

// Every problem of the install manifest, the same strings as manifest_problems in config/network_config.py (shared
// cases: tests/fixtures/network_config/cases.json "manifest"). Each service's fields are checked, then the defaults
// are bound together as one candidate: without a saved layer they are the effective network.
function manifestProblems(manifest) {
  if (!isObject(manifest)) return ["manifest must be an object"];
  const problems = [];
  if (manifest.schema !== MANIFEST_SCHEMA) problems.push(`schema must be ${MANIFEST_SCHEMA}`);
  if (!LOOPBACK_HOSTS.has(manifest.loopback_host)) problems.push("loopback_host must be one of 127.0.0.1, localhost, ::1");
  let low = 1024, high = 65535, reserved = new Set();
  const policy = manifest.port_policy;
  if (!isObject(policy)) problems.push("port_policy must be an object");
  else {
    const { min_port: lowValue, max_port: highValue, reserved_ports: ports } = policy;
    if (isInt(lowValue) && isInt(highValue) && lowValue >= 1 && lowValue <= highValue && highValue <= 65535) [low, high] = [lowValue, highValue];
    else problems.push("port_policy: min_port and max_port must be integers with 1 <= min_port <= max_port <= 65535");
    if (Array.isArray(ports) && ports.every(isInt)) reserved = new Set(ports);
    else problems.push("port_policy: reserved_ports must be a list of integers");
  }
  const specs = manifest.services;
  if (!Array.isArray(specs) || !specs.length) {
    problems.push("services must be a non-empty list");
    return problems;
  }
  const ids = new Set(specs.filter(isObject).map((spec) => spec.service_id));
  const seen = new Set();
  specs.forEach((spec, index) => {
    if (!isObject(spec)) { problems.push(`services[${index}] must be an object`); return; }
    const sid = spec.service_id;
    if (typeof sid !== "string" || !SERVICE_ID.test(sid)) { problems.push(`services[${index}]: service_id must be lower-case letters, digits and _`); return; }
    if (seen.has(sid)) { problems.push(`duplicate service_id ${sid}`); return; }
    seen.add(sid);
    problems.push(...serviceProblems(spec, low, high, reserved, ids).map((problem) => `${sid}: ${problem}`));
  });
  if (!problems.length) problems.push(...validateValues(manifest, {}).map((p) => `defaults: ${p.message}`));
  if (!problems.length) problems.push(...topologyProblems(manifest));
  return problems;
}

function serviceProblems(spec, low, high, reserved, ids) {
  const problems = [];
  const kind = spec.kind;
  if (!KINDS.includes(kind)) problems.push(`kind must be one of ${KINDS.join(", ")}`);
  for (const field of ["display_name", "protocol"]) {
    if (typeof spec[field] !== "string" || !spec[field].trim()) problems.push(`${field} must be a non-empty string`);
  }
  for (const field of ["listener", "managed"]) {
    if (typeof spec[field] !== "boolean") problems.push(`${field} must be true or false`);
  }
  const depends = "depends_on" in spec ? spec.depends_on : [];
  if (!Array.isArray(depends) || !depends.every((d) => typeof d === "string")) problems.push("depends_on must be a list of service_ids");
  else {
    for (const dependency of depends) {
      if (dependency === spec.service_id) problems.push("depends_on names the service itself");
      else if (!ids.has(dependency)) problems.push(`depends_on names unknown service ${dependency}`);
    }
  }
  const port = spec.default_port;
  if (spec.listener === true || kind === "external") {
    if (!isInt(port)) problems.push("listener without integer default_port");
    else if (!(port >= low && port <= high)) problems.push(`default_port ${port} is outside ${low}-${high}`);
    else if (reserved.has(port) && kind !== "external") problems.push(`default_port ${port} is reserved`);
  } else if (port !== null && port !== undefined) problems.push("a no-listener service must not declare a port");
  const reads = "reads_addresses_at_start" in spec ? spec.reads_addresses_at_start : [];
  if (!Array.isArray(reads) || !reads.every((r) => typeof r === "string")) problems.push("reads_addresses_at_start must be a list of service_ids");
  if (typeof ("self_handoff" in spec ? spec.self_handoff : false) !== "boolean") problems.push("self_handoff must be true or false");
  const client = "renderer_client" in spec ? spec.renderer_client : false;
  if (typeof client !== "boolean") problems.push("renderer_client must be true or false");
  else if (client && (spec.listener !== true || !RENDERER_PROTOCOLS.includes(spec.protocol))) {
    problems.push(`renderer_client needs a listener speaking one of ${RENDERER_PROTOCOLS.join(", ")}`);
  }
  return problems;
}

// The services a renderer may address, in manifest order (manifest "renderer_client": true).
function rendererServices(manifest) {
  return (manifest.services || []).filter((spec) => spec.renderer_client === true).map((spec) => spec.service_id);
}

// The service graph the manifest declares (its "topology" note): managed services with an entry, their start order,
// who reads whose address at start, and which endpoints are Health's own. Same result as config/network_config.py.
function topologyOf(manifest) {
  const specs = manifest.services || [];
  const managed = specs.filter((spec) => spec.managed && spec.entry).map((spec) => spec.service_id);
  const after = Object.fromEntries(specs.map((spec) => [spec.service_id,
    [...new Set([...(spec.depends_on || []), ...(spec.reads_addresses_at_start || [])])]]));
  const clients = {};
  for (const spec of specs) {
    for (const target of spec.reads_addresses_at_start || []) (clients[target] = clients[target] || []).push(spec.service_id);
  }
  const startOrder = [];
  const placed = new Set();
  while (startOrder.length < managed.length) {
    const next = managed.find((sid) => !placed.has(sid) && after[sid].every((dep) => placed.has(dep) || !managed.includes(dep)));
    if (!next) return { managed, clients, startOrder: null, selfServices: [] };
    startOrder.push(next);
    placed.add(next);
  }
  const selfServices = specs.filter((spec) => spec.self_handoff === true).map((spec) => spec.service_id);
  return { managed, clients, startOrder, selfServices };
}

function topologyProblems(manifest) {
  const ids = new Set((manifest.services || []).map((spec) => spec.service_id));
  const problems = [];
  for (const spec of manifest.services || []) {
    for (const field of ["depends_on", "reads_addresses_at_start"]) {
      for (const target of spec[field] || []) {
        if (!ids.has(target)) problems.push(`${spec.service_id}: ${field} names unknown service ${target}`);
        if (target === spec.service_id) problems.push(`${spec.service_id}: ${field} names itself`);
      }
    }
  }
  if (!problems.length && topologyOf(manifest).startOrder === null) problems.push("depends_on / reads_addresses_at_start has a cycle");
  return problems;
}

/** { managed, clients: {service_id: [readers]}, startOrder, selfServices } of a valid manifest. */
function topology(manifest) {
  const problems = topologyProblems(manifest);
  if (problems.length) throw new Error(`Invalid network topology: ${problems.join("; ")}`);
  return topologyOf(manifest);
}

const cache = new Map();
function loadManifest(file = manifestPath()) {
  if (!cache.has(file)) {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const problems = manifestProblems(manifest);
    if (problems.length) throw new Error(`Invalid network manifest ${file}: ${problems.join("; ")}`);
    cache.set(file, manifest);
  }
  return JSON.parse(JSON.stringify(cache.get(file)));
}

function services(manifest) {
  return Object.fromEntries((manifest.services || []).map((spec) => [spec.service_id, { ...spec }]));
}

const problem = (code, serviceId, message, extra = {}) => ({ code, service_id: serviceId, message, ...extra });
const isInt = (value) => Number.isInteger(value) && typeof value === "number";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function hostProblem(spec, host, loopback) {
  if (typeof host !== "string" || !host.trim()) return "host must be a non-empty string";
  if (spec.kind === "external" && spec.host_configurable) return null;
  if (host !== loopback) return `formal services listen on loopback ${loopback} only`;
  return null;
}

function validateValues(manifest, values) {
  const table = services(manifest);
  const policy = manifest.port_policy || {};
  const low = Number(policy.min_port ?? 1024);
  const high = Number(policy.max_port ?? 65535);
  const reserved = new Set(policy.reserved_ports || []);
  const loopback = String(manifest.loopback_host || "127.0.0.1");
  const problems = [];
  const candidate = {};
  for (const [sid, spec] of Object.entries(table)) {
    if ((spec.listener || spec.kind === "external") && isInt(spec.default_port)) {
      candidate[sid] = [loopback, spec.default_port];
    }
  }
  for (const [sid, entry] of Object.entries(values || {})) {
    const spec = table[sid];
    if (!spec) { problems.push(problem("UNKNOWN_SERVICE", sid, "no such service_id in the manifest")); continue; }
    if (!isObject(entry)) { problems.push(problem("INVALID_ENTRY", sid, "entry must be an object")); continue; }
    const unknown = Object.keys(entry).filter((key) => !["port", "host"].includes(key)).sort();
    if (unknown.length) problems.push(problem("UNKNOWN_FIELD", sid, `only port/host are editable, got ${JSON.stringify(unknown)}`));
    if (!spec.listener && spec.kind !== "external") {
      problems.push(problem("NO_LISTENER", sid, "this service has no listener; a port cannot be assigned"));
      continue;
    }
    let [host, port] = candidate[sid] || [loopback, spec.default_port];
    if ("port" in entry) {
      port = entry.port;
      if (!isInt(port)) { problems.push(problem("PORT_NOT_INTEGER", sid, "port must be an integer")); continue; }
      if (!(port >= low && port <= high)) { problems.push(problem("PORT_OUT_OF_RANGE", sid, `port must be within ${low}-${high}`, { port })); continue; }
      if (reserved.has(port) && spec.kind !== "external") { problems.push(problem("PORT_RESERVED", sid, `${port} is reserved/unassigned`, { port })); continue; }
    }
    if ("host" in entry) {
      host = entry.host;
      const reason = hostProblem(spec, host, loopback);
      if (reason) { problems.push(problem("HOST_NOT_ALLOWED", sid, reason, { host })); continue; }
    }
    candidate[sid] = [String(host), Number(port)];
  }
  const byPort = new Map();
  for (const [sid, [, port]] of Object.entries(candidate)) {
    if (table[sid].kind === "external") continue;
    if (!byPort.has(port)) byPort.set(port, []);
    byPort.get(port).push(sid);
  }
  for (const port of [...byPort.keys()].sort((a, b) => a - b)) {
    const owners = byPort.get(port);
    if (owners.length > 1) {
      const sorted = [...owners].sort();
      problems.push(problem("DUPLICATE_BINDING", null, `port ${port} is assigned to ${JSON.stringify(sorted)}`, { port, services: sorted }));
    }
  }
  return problems;
}

function parseEnvOverrides(raw) {
  const values = {};
  const problems = [];
  for (const item of String(raw || "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const index = item.indexOf("=");
    const sid = (index >= 0 ? item.slice(0, index) : item).trim();
    if (index < 0 || !sid) { problems.push(problem("OVERRIDE_SYNTAX", sid || null, `expected service_id=port, got ${JSON.stringify(item)}`)); continue; }
    const text = item.slice(index + 1).trim();
    if (!/^[+-]?\d+$/.test(text)) { problems.push(problem("PORT_NOT_INTEGER", sid, `override ${JSON.stringify(item)} is not an integer port`)); continue; }
    values[sid] = { port: Number.parseInt(text, 10) };
  }
  return { values, problems };
}

function resolve(manifest, { saved = null, env = process.env } = {}) {
  const table = services(manifest);
  const loopback = String(manifest.loopback_host || "127.0.0.1");
  const effective = {};
  for (const [sid, spec] of Object.entries(table)) {
    effective[sid] = {
      service_id: sid, kind: spec.kind, display_name: spec.display_name, protocol: spec.protocol,
      listener: Boolean(spec.listener), managed: Boolean(spec.managed), renderer_client: spec.renderer_client === true,
      default_port: spec.default_port ?? null, host: loopback, port: spec.default_port ?? null, source: "default",
    };
  }
  const problems = [];
  const overrides = [];
  const rejected = [];
  let revision = null;

  // Same rule as config/network_config.py: a layer applies as a WHOLE or not at all.
  function layer(values, source, priorProblems = []) {
    const found = priorProblems.map((p) => ({ ...p, layer: source }));
    for (const [sid, entry] of Object.entries(values)) {
      found.push(...validateValues(manifest, { [sid]: entry }).filter((p) => p.code !== "DUPLICATE_BINDING")
        .map((p) => ({ ...p, layer: source })));
    }
    const trial = {};
    for (const [sid, e] of Object.entries(effective)) {
      if (e.port !== null && (e.listener || e.kind === "external")) trial[sid] = { port: e.port, host: e.host };
    }
    for (const [sid, entry] of Object.entries(values)) trial[sid] = { ...(trial[sid] || {}), ...entry };
    found.push(...validateValues(manifest, trial)
      .filter((p) => p.code === "DUPLICATE_BINDING" && (p.services || []).some((sid) => sid in values))
      .map((p) => ({ ...p, layer: source })));
    if (found.length) {
      problems.push(...found);
      return false;
    }
    const accepted = Object.fromEntries(Object.entries(values).map(([sid, entry]) => [sid, { ...entry }]));
    for (const [sid, entry] of Object.entries(accepted)) {
      const target = effective[sid];
      if ("port" in entry) target.port = Number(entry.port);
      if ("host" in entry) target.host = String(entry.host);
      target.source = source;
      if (source === "override") overrides.push({ service_id: sid, ...entry });
    }
    return true;
  }

  if (saved) {
    // The saved revision's shape first: values and values.services are objects. A missing or mistyped one is a
    // rejected layer (fail-closed, last-good) -- never read as "no services changed" and run on the defaults.
    const malformed = !isObject(saved.values) ? "values must be an object"
      : !isObject(saved.values.services) ? "values.services must be an object" : null;
    if (malformed) {
      problems.push(problem("SAVED_REVISION_MALFORMED", null, malformed, { layer: "saved" }));
      rejected.push({ layer: "saved", revision: saved.revision ?? null });
    } else if (layer(saved.values.services, "saved")) revision = saved.revision ?? null;
    else rejected.push({ layer: "saved", revision: saved.revision ?? null });
  }
  const parsed = parseEnvOverrides(env[OVERRIDE_ENV]);
  if ((Object.keys(parsed.values).length || parsed.problems.length) && !layer(parsed.values, "override", parsed.problems)) {
    rejected.push({ layer: "override", revision: null });
  }
  return {
    schema: EFFECTIVE_SCHEMA, manifest_schema: manifest.schema, revision, services: effective, overrides, problems,
    // Layers refused as a whole: a rejected saved revision is not the `revision` above.
    rejected,
    reserved_ports: [...((manifest.port_policy || {}).reserved_ports || [])],
  };
}

function endpoint(effective, serviceId) {
  const entry = effective.services[serviceId];
  if (!entry) throw new Error(`unknown service_id ${serviceId}`);
  if (entry.port === null || entry.port === undefined) throw new Error(`${serviceId} has no listener`);
  return { host: entry.host, port: Number(entry.port) };
}

function baseUrl(effective, serviceId) {
  const { host, port } = endpoint(effective, serviceId);
  return `${effective.services[serviceId].protocol === "ws" ? "ws" : "http"}://${host}:${port}`;
}

function listeners(effective) {
  return Object.values(effective.services).filter((e) => e.listener && e.kind !== "external").map((e) => ({ ...e }));
}

function rendererProjection(effective) {
  const out = {};
  for (const [sid, entry] of Object.entries(effective.services)) {
    if (entry.renderer_client) {
      out[sid] = { url: `${entry.protocol === "ws" ? "ws" : "http"}://${entry.host}:${entry.port}`, port: entry.port };
    }
  }
  return { schema: "stock-monitor-renderer-endpoints-v1", revision: effective.revision ?? null, services: out };
}

function connectSources(effective) {
  return [...new Set(Object.values(rendererProjection(effective).services).map((svc) => svc.url))].sort();
}

// Resolve from the ACTIVE network revision on disk -- what a starting process must use.
function effectiveFromDisk({ env = process.env, configRoot, manifestFile = manifestPath(env) } = {}) {
  const { ConfigRevisionStore } = require("./config_revisions.js");
  const { resolveVarPaths } = require("./var_paths.js");
  const root = configRoot || resolveVarPaths({ env }).config;
  const store = new ConfigRevisionStore(root, "network");
  const pinned = String(env[REVISION_ENV] || "").trim();
  let saved = store.active();
  if (pinned) {
    saved = /^\d+$/.test(pinned) ? store.get(Number(pinned)) : null;
    if (!saved) throw new Error(`${REVISION_ENV}=${pinned} names no saved network revision`);
  }
  return resolve(loadManifest(manifestFile), { saved, env });
}

module.exports = {
  EFFECTIVE_SCHEMA, MANIFEST_SCHEMA, OVERRIDE_ENV, REVISION_ENV, RENDERER_PROTOCOLS, rendererServices,
  manifestPath, manifestProblems, loadManifest, services, topology, validateValues, parseEnvOverrides, resolve, endpoint, baseUrl,
  listeners, rendererProjection, connectSources, effectiveFromDisk,
};
