"use strict";

// Electron main's view of where each business API and market_runtime listen (docs/system-architecture/00, 06).
//
// What Health reports it actually started the services with (GET /network/effective) -- at startup, after every
// applied network operation and after a Health bootstrap restart. A path is addressed through config/api_routes.json
// (longest prefix -> service_id), never through one "backend" base URL. Listeners are told when the addresses
// change so sessions, CSP and renderer windows follow.
//
// The projection is Health's, not a second authority: `authority` names the Health instance and revision it
// came from, and nothing is handed out until Health has confirmed it -- not even at launch, where the resolver's own
// answer may not be what Health started (a self-endpoint handoff in progress). Pending (Health not settled, or
// restarted) and unavailable (a failed read) are fenced: no URL, no origin and no CSP source for main or for any
// window, and a window that loads meanwhile is reloaded once Health confirms. Entering the fence after a
// confirmation tells the windows at once, so none keeps talking to an old address.
//
// Confirmation is Health's answer, not a guess: Health holds each read until its effective endpoints settle
// (`wait_ms`), and the read is asked again until it does -- no attempt budget. Only a Health that cannot be reached at
// all is paced. A re-discovery after a network apply or a Health restart is one `ui.endpoint_rediscovery` record.

const apiRoutes = require("../../config/js/api_routes.js");

// One held read: Health answers as soon as its endpoints settle, else after this long and it is asked again.
const WAIT_MS = 25000;
// Pacing for a Health that does not answer at all (a refused or failed connection returns at once).
const UNREACHABLE_PAUSE_MS = [1000, 2000, 5000, 10000];

function createApiEndpoints({ logger = console, remediation = () => null, isClosing = () => false,
  sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer?.unref?.(); }) } = {}) {
  // Nothing is known until Health confirms: the first confirmation is a change, and the windows bind to it.
  let projection = { schema: "stock-monitor-renderer-endpoints-v1", revision: null, mode: null, services: {} };
  let authority = { status: "pending", health_instance_id: null, revision: null, reason: "launch: not confirmed by Health yet" };
  const listeners = new Set();
  let servedWhileFenced = false;
  let generation = 0;
  let background = Promise.resolve();

  const fenced = () => authority.status !== "effective";

  // Every listener runs and is awaited; what each returns (the window reloads) is collected for the rediscovery record.
  async function notify(reason) {
    const outcomes = [];
    for (const listener of listeners) {
      try { outcomes.push(await listener(projection, reason)); } catch (error) {
        logger.error?.(`[ENDPOINTS] listener failed: ${error?.message || error}`);
        outcomes.push({ listener_error: String(error?.message || error).slice(0, 300) });
      }
    }
    return outcomes;
  }

  // Window reload failures among the listener outcomes (see desktop_windows.reloadForEndpointChange).
  const reloadFailures = (outcomes) => outcomes.flatMap((o) => (o?.listener_error ? [{ error: o.listener_error }] : o?.failed || []));

  function replace(next) {
    const changed = JSON.stringify(next.services) !== JSON.stringify(projection.services);
    projection = next;
    return changed;
  }

  // From confirmed to not confirmed: the windows are told now (they reload with no address), not at the next change.
  function enterFence(status, reason) {
    const wasConfirmed = authority.status === "effective";
    authority = { ...authority, status, reason };
    if (wasConfirmed) {
      logger.warn?.(`[ENDPOINTS] endpoints no longer confirmed (${status}: ${reason}); windows drop their addresses`);
      void notify(`fenced: ${reason}`);
    }
  }

  function recordRediscovery(reason, outcome, detail) {
    if (reason !== "network_apply" && reason !== "health_restart") return;   // startup discovery is not a recovery
    try {
      remediation()?.emit({ component: "api_endpoints", mechanismId: "ui.endpoint_rediscovery", triggerReason: reason, outcome,
        identity: {}, detail });
    } catch (error) { console.warn("[API ENDPOINTS remediation record] failed", error); }
  }

  function serviceUrl(serviceId) {
    if (fenced()) throw new Error(`endpoints not confirmed by Health (${authority.status}: ${authority.reason})`);
    const entry = projection.services[serviceId];
    if (!entry) throw new Error(`no effective address for ${serviceId} in ${projection.mode} mode`);
    return entry.url;
  }

  function urlFor(pathname) {
    const serviceId = apiRoutes.serviceForPath(pathname);
    if (!serviceId) throw new Error(`no business API serves ${pathname}`);
    return `${serviceUrl(serviceId)}${pathname}`;
  }

  // The origins Electron main attaches the client credential to: none while fenced, so no request to an address
  // Health no longer confirms carries it.
  function apiOrigins() {
    if (fenced()) return [];
    return Object.entries(projection.services).filter(([sid]) => sid !== "market_runtime").map(([, svc]) => new URL(svc.url).origin);
  }

  function connectSources() {
    if (fenced()) return [];
    return [...new Set(Object.values(projection.services).map((svc) => svc.url))].sort();
  }

  function update(next, reason) {
    if (!next?.services) return false;
    const changed = replace(next);
    if (changed) {
      logger.log?.(`[ENDPOINTS] renderer endpoints changed (${reason}); revision=${next.revision ?? "defaults"}`);
      void notify(reason);
    }
    return changed;
  }

  // One read of Health's effective endpoints. `done` when Health confirmed them (or a newer read took over).
  async function readOnce(controllerClient, reason, gen, before, attempt, waitMs) {
    let error = null;
    let notReady = false;
    try {
      const status = await controllerClient.getNetworkEffective(waitMs);
      if (gen !== generation) return { done: true, changed: false };
      if (status?.ok && status.renderer && status.health_instance_id && status.effective === true) {
        authority = { status: "effective", health_instance_id: status.health_instance_id, revision: status.revision ?? null, reason };
        const changed = replace(status.renderer);
        // Another Health or revision behind the same URLs, or a fence a window loaded during: the windows rebind.
        const rebind = !changed && ((before.health_instance_id && (before.health_instance_id !== authority.health_instance_id
          || before.revision !== authority.revision)) || servedWhileFenced);
        servedWhileFenced = false;
        if (changed) logger.log?.(`[ENDPOINTS] renderer endpoints changed (${reason}); revision=${status.renderer.revision ?? "defaults"}`);
        if (rebind) logger.log?.(`[ENDPOINTS] Health ${authority.health_instance_id} revision ${authority.revision ?? "defaults"} confirmed (${reason}); windows rebind`);
        // A window that did not reload still runs the old addresses: the rediscovery failed for it.
        const failedWindows = changed || rebind ? reloadFailures(await notify(reason)) : [];
        recordRediscovery(reason, failedWindows.length ? "failed" : "succeeded", { old_instance: before.health_instance_id,
          new_instance: authority.health_instance_id, old_revision: before.revision, new_revision: authority.revision, changed, attempt,
          ...(failedWindows.length ? { failed_windows: failedWindows } : {}) });
        return { done: true, changed: changed || rebind };
      }
      notReady = Boolean(status?.ok && status.health_instance_id && status.effective !== true);
      error = notReady ? `Health ${status.health_instance_id} is ${status.phase || "not settled"}${status.operation ? ` (operation ${status.operation})` : ""}`
        : status?.error || "Health named no instance for its effective endpoints";
    } catch (caught) {
      // not an error: a newer refresh took over this one; otherwise the failure is logged below (notReady is still false)
      if (gen !== generation) return { done: true, changed: false };
      error = String(caught?.message || caught);
    }
    if (attempt === 1 || !notReady) logger.warn?.(`[ENDPOINTS] effective endpoints not confirmed by Health (attempt ${attempt}): ${error}`);
    enterFence(notReady ? "pending" : "unavailable", `${reason}: ${error}`);
    return { done: false, unreachable: !notReady, error };
  }

  // Ask Health which addresses the running services were started with. Answers after the first read; while Health
  // has not confirmed, the reads go on in the background until it does, a newer refresh takes over, or the App closes.
  async function refreshFromHealth(controllerClient, reason = "health") {
    const gen = ++generation;
    const before = { ...authority };
    if (reason === "health_restart") enterFence("pending", reason);
    const first = await readOnce(controllerClient, reason, gen, before, 1, 0);
    if (first.done) return first.changed;
    background = (async () => {
      let last = first;
      let unreachable = first.unreachable ? 1 : 0;
      for (let attempt = 2; gen === generation; attempt += 1) {
        if (isClosing()) {
          recordRediscovery(reason, "abandoned", { old_instance: before.health_instance_id, old_revision: before.revision,
            result: `the App closed while waiting: ${last.error}`, attempt: attempt - 1 });
          return;
        }
        if (unreachable) await sleep(UNREACHABLE_PAUSE_MS[Math.min(unreachable, UNREACHABLE_PAUSE_MS.length) - 1]);
        if (gen !== generation) return;
        last = await readOnce(controllerClient, reason, gen, before, attempt, WAIT_MS);
        if (last.done) return;
        unreachable = last.unreachable ? unreachable + 1 : 0;
      }
    })().catch((error) => logger.error?.(`[ENDPOINTS] confirmation loop failed: ${error?.message || error}`));
    return false;
  }

  // What a window is handed: nothing while fenced (it is reloaded once Health confirms).
  function served() {
    if (!fenced()) return JSON.parse(JSON.stringify(projection));
    servedWhileFenced = true;
    return { ...JSON.parse(JSON.stringify(projection)), services: {} };
  }

  return {
    urlFor, serviceUrl, apiOrigins, connectSources, refreshFromHealth, update, served, fenced,
    projection: () => JSON.parse(JSON.stringify(projection)),
    authority: () => ({ ...authority }),
    routes: () => apiRoutes.routes(),
    // The background confirmation of the latest refresh (tests wait on it).
    settled: () => background,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

module.exports = { createApiEndpoints };
