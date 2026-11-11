"use strict";

// Health tells the UI before it stops anything the UI's windows are connected to. Electron main holds
// GET /control/ui-events open while Health runs; a shutdown that ends the UI's backends is announced on it as
// `closing` {id, scope}, and Health waits for POST /control/ui-closing-done {id} -- the windows' live transports
// stopped, Electron main's remediation flushed -- before the first service stops. Whoever asked for the shutdown (the
// tray, a tool calling /control/shutdown, a signal, Windows' session end through Rust A), the windows stop first, so
// the close is never taken for a broken connection and recorded as a reconnect.

// How long the UI has to answer: its windows' own answer bound (2 s, ui/main/shutdown_controller.js
// RENDERER_STOP_ANSWER_MS) plus its ledger flush (1.5 s). A UI that cannot answer in it is hung, and the shutdown goes
// on without it rather than wait on a process that may never answer.
const UI_CLOSING_ANSWER_MS = 4000;

function createUiClosingChannel({ answerMs = UI_CLOSING_ANSWER_MS, logger = console } = {}) {
  const streams = new Set();
  // announcement id -> resolve(answered)
  const pending = new Map();
  let nextId = 0;

  function open() {
    return [...streams].filter((stream) => !stream.writableEnded && !stream.destroyed);
  }

  return {
    attach(request, response) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
      response.write(": stock-monitor ui events\n\n");
      streams.add(response);
      request.on("close", () => {
        streams.delete(response);
        // The UI left while an announcement waited on it: nobody is left to answer.
        if (!open().length) for (const resolve of pending.values()) resolve(false);
      });
    },

    acknowledge(id) {
      const resolve = pending.get(String(id || ""));
      if (!resolve) return false;
      resolve(true);
      return true;
    },

    // {told, answered, ms}: told 0 when no UI follows this Health (it was closed with 關閉介面與 FastAPI, or has not
    // attached yet) -- there is no window to stop.
    async announce(scope) {
      const streamsOpen = open();
      if (!streamsOpen.length) return { told: 0, answered: false, ms: 0 };
      const id = `closing-${process.pid}-${++nextId}`;
      const started = Date.now();
      let timer = null;
      const answered = new Promise((resolve) => {
        pending.set(id, resolve);
        timer = setTimeout(() => resolve(false), answerMs);
      });
      for (const stream of streamsOpen) {
        try { stream.write(`event: closing\ndata: ${JSON.stringify({ id, scope })}\n\n`); }
        catch (error) { logger.warn?.(`[HEALTH] telling the UI the ${scope} shutdown starts failed: ${error?.message || error}`); }
      }
      const ok = await answered;
      clearTimeout(timer);
      pending.delete(id);
      const ms = Date.now() - started;
      if (!ok) logger.warn?.(`[HEALTH] the UI did not say its windows stopped within ${answerMs} ms (waited ${ms} ms); the ${scope} shutdown goes on`);
      return { told: streamsOpen.length, answered: ok, ms };
    },

    // Before the control API closes: an open stream would hold server.close() (and the UI waits for Health to end).
    close() {
      for (const stream of streams) {
        try { stream.end(); } catch (error) { logger.warn?.(`[HEALTH] ending a UI event stream failed: ${error?.message || error}`); }
      }
      streams.clear();
      for (const resolve of pending.values()) resolve(false);
    },
  };
}

module.exports = { createUiClosingChannel, UI_CLOSING_ANSWER_MS };
