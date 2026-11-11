// One owner for a Server-Sent Events stream's life: connect, read, and on a break say WHICH break it
// was -- a deliberate stop, the silence watchdog, an HTTP failure, the server closing the stream (EOF) or a transport
// error -- then reconnect with backoff. Every break but a deliberate stop is a recorded `renderer.sse_reconnect`
// remediation naming the stream and the last identity it delivered (e.g. a revision), finished by the connection that
// holds again. The backoff is reset only by a connection that stayed up and kept delivering for a heartbeat interval,
// never by a connection that merely opened. Each break is recorded the moment it happens as its own
// `renderer.sse_break` (scalar detail: why, when, what it had delivered, the identity then), related to the outage's
// started event -- never only an in-memory list that a closed page lost and an event detail could not hold.
//
// The returned stop() ends the stream at once, a backoff wait included; `stop.finished` settles when the runner has
// wound down (its outage, if any, recorded as abandoned).
import { beginRemediation, emitRemediation } from "./remediation.js";

// A wait that a stop ends early: resolves after `ms`, or as soon as `signal` aborts.
function abortableWait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export function startSseStream({
  url, name, silenceMs, heartbeatMs, onBlock, lastIdentity = () => ({}),
  // The reconnect backoff: starts here after a connection that held, doubles per break up to the maximum.
  initialBackoffMs = 1000, maxBackoffMs = 30000,
  fetchImpl = (...args) => fetch(...args), wait = abortableWait,
  now = () => Date.now(), record = beginRemediation, emit = emitRemediation,
  // The App is closing: the stream stops (a deliberate stop, not a break) before the backend that serves it does.
  onAppClosing = (listener) => globalThis.window?.desktopAPI?.onAppClosing?.(listener) || (() => {}),
}) {
  let stopped = false;
  const stopping = new AbortController();
  let controller = null;
  let recovery = null;
  let attempts = 0;
  // How many breaks of each kind the outage had: its terminal event says it, each break has its own event.
  let breakCounts = {};
  const recoveryDetail = (extra) => ({ stream: name, ...Object.fromEntries(Object.entries(breakCounts).map(([k, n]) => [`breaks_${k}`, n])), ...extra });
  const runner = (async () => {
    let backoff = initialBackoffMs;
    while (!stopped) {
      controller = new AbortController();
      let silence = null;
      let silent = false;
      let reason = null;
      const arm = () => {
        clearTimeout(silence);
        silence = setTimeout(() => { silent = true; controller.abort(); }, silenceMs);
      };
      const openedAt = now();
      let delivered = 0;
      try {
        arm();
        const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
        if (!response.ok || !response.body) {
          reason = "http_failure";
          throw new Error(`${name} HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { reason = "eof"; break; }
          arm();
          delivered += 1;
          buffer = onBlock(buffer + decoder.decode(value, { stream: true }));
          // Held long enough with data flowing: the earlier break is over and the backoff starts again.
          if (recovery && now() - openedAt >= heartbeatMs) {
            recovery.finish("succeeded", { attempt: attempts, detail: recoveryDetail(lastIdentity()) });
            recovery = null;
            attempts = 0;
            breakCounts = {};
          }
          if (now() - openedAt >= heartbeatMs) backoff = initialBackoffMs;
        }
      } catch (error) {
        if (!reason) reason = stopped ? "stopped" : silent ? "silence_watchdog" : "transport_error";
        // not an error: a stop or the silence watchdog ended the read on purpose; every break, whatever its reason,
        // is recorded below as a renderer.sse_break event.
        if (reason === "transport_error") console.warn(`[SSE] ${name} interrupted`, error?.message || error);
      } finally {
        clearTimeout(silence);
      }
      if (stopped) break;
      attempts += 1;
      breakCounts[reason] = (breakCounts[reason] || 0) + 1;
      if (!recovery) {
        recovery = record({ component: "sse_stream", mechanismId: "renderer.sse_reconnect", triggerReason: reason,
          detail: { stream: name, delivered, open_ms: now() - openedAt, ...lastIdentity() } });
      }
      try {
        emit({ component: "sse_stream", mechanismId: "renderer.sse_break", triggerReason: reason, outcome: "failed", attempt: attempts,
          relatedUpstreamEventId: recovery?.startedEvent?.event_id ?? null,
          detail: { stream: name, at: new Date(now()).toISOString(), delivered, open_ms: now() - openedAt, ...lastIdentity() } });
      } catch (error) { console.warn(`[SSE] ${name} recording a break failed`, error); }
      await wait(backoff, stopping.signal);
      backoff = Math.min(maxBackoffMs, backoff * 2);
    }
    if (recovery) recovery.finish("abandoned", { attempt: attempts, detail: recoveryDetail({ reason: "stopped" }) });
  })().catch((error) => {
    // onBlock, lastIdentity or a remediation record threw outside a connection's own handling: the stream is over.
    console.error(`[SSE] ${name} stream runner failed; the stream is stopped`, error);
  });
  const stop = () => { stopped = true; stopping.abort(); controller?.abort(); unsubscribeClosing(); };
  const unsubscribeClosing = onAppClosing(stop);
  stop.finished = runner;
  return stop;
}
