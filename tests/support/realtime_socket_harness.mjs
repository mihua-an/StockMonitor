// One fake browser for the renderer's live socket (ui/renderer/js/market_data/realtime.js) in node: fake timers, the
// window and desktopAPI it reads, and a WebSocket that records what the window sends and answers `health` like Market
// Runtime does. A test installs it before importing realtime.js and then only describes its scenario's frames.
//
//   const live = installRealtimeHarness({ enabledSources: ["futu"] });
//   const realtime = await import("../ui/renderer/js/market_data/realtime.js");
//   realtime.startRealtimeStream();
//   const socket = live.sockets[0];
//   socket.ready();                       // open + system.connected
//   socket.frame({ type: "view.snapshot", payload: { ... } });
//   socket.drop();                         // the connection is lost (1006)
import { liveEngineConnection, rendererNetworkManifest } from "./renderer_network_manifest.mjs";

export const SERVING_HEALTH = Object.freeze({ status: "healthy", service_id: "market_runtime", protocol: 2 });

/**
 * Installs the globals realtime.js reads. Options:
 *   enabledSources  the sources the window's source settings enable;
 *   health()        the payload a `health` request is answered with (default: serving); null leaves it unanswered;
 *   onEvent(event)  every event the window dispatches (window.dispatchEvent);
 *   desktopAPI      fields over the default desktopAPI (liveEngineConnection, networkManifest, sourceSettings,
 *                   waitForFutuProvider answering ready);
 *   window          fields over the default window.
 */
export function installRealtimeHarness({ enabledSources = ["shioaji", "futu"], health = () => SERVING_HEALTH, onEvent = null,
  desktopAPI = {}, window: windowExtras = {} } = {}) {
  const timers = new Map();
  let nextTimer = 1;
  const timer = (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; };
  const clear = (id) => timers.delete(id);
  Object.assign(globalThis, { setTimeout: timer, clearTimeout: clear, setInterval: timer, clearInterval: clear });
  const stored = new Map();
  globalThis.localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
  // The browser's CSS namespace: the page escapes codes with it to address a product row.
  globalThis.CSS ??= { escape: (value) => String(value).replace(/[^\w-]/g, (char) => `\\${char}`) };
  // The remediation events the window reports to Health (core/remediation.js), kept for the test to read.
  const remediations = [];
  globalThis.window = {
    setTimeout: timer, clearTimeout: clear, setInterval: timer, clearInterval: clear,
    requestAnimationFrame: (fn) => timer(fn, 0), cancelAnimationFrame: clear,
    addEventListener() {}, removeEventListener() {},
    dispatchEvent(event) { onEvent?.(event); return true; },
    desktopAPI: { liveEngineConnection: liveEngineConnection(), networkManifest: rendererNetworkManifest(),
      sourceSettings: { enabled_sources: enabledSources, sources: {} },
      waitForFutuProvider: async () => ({ status: "ready", detail: "" }),
      reportRemediation: (payload) => { remediations.push(payload); }, ...desktopAPI },
    ...windowExtras,
  };

  const sockets = [];
  class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; listeners = new Map(); sent = []; bufferedAmount = 0;
    constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    // What the window sends, parsed; a health request is answered at once, like a Market Runtime that is up.
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      const answer = message.type === "health" ? health() : null;
      if (answer) this.frame({ type: "health", payload: answer });
    }
    emit(name, payload) { this.listeners.get(name)?.(payload); }
    frame(message) { this.emit("message", { data: JSON.stringify(message) }); }
    open() { this.readyState = 1; this.emit("open"); }
    // Open, then Market Runtime's greeting.
    ready({ backendRuntimeVersion = "test" } = {}) {
      this.open();
      this.frame({ type: "system.connected", payload: { renderer_protocol_version: 2, realtime_protocol_version: 1,
        backend_runtime_version: backendRuntimeVersion, connection_id: new URL(this.url).searchParams.get("connection_id") } });
    }
    // The window closing it (a browser reports 1005 for a close() without a code).
    close(code = 1005, reason = "") { this.readyState = 3; this.emit("close", { code, reason, wasClean: true }); }
    // The other side or the network ending it.
    drop(code = 1006, reason = "") { this.readyState = 3; this.emit("close", { code, reason, wasClean: false }); }
    sentOfType(type) { return this.sent.filter((message) => message.type === type); }
  }
  globalThis.WebSocket = FakeSocket;

  return {
    timers, sockets, FakeSocket, remediations,
    // Runs (and removes) every pending timer the predicate picks, oldest first.
    fireTimers(predicate = () => true) {
      for (const [id, entry] of [...timers]) if (predicate(entry)) { timers.delete(id); entry.fn(); }
    },
    // Lets promise chains run until `until()` holds (or `turns` macrotasks passed).
    async settle(until = () => false, turns = 20) {
      for (let turn = 0; turn < turns && !until(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
