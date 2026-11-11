"use strict";

const { CHANNELS } = require("./ipc_contract");

// Installs renderer -> main handlers by ipc_contract.js. A channel the contract does not list, or lists with another
// kind, cannot be installed; every event is authorized before its handler runs; assertComplete() reports every listed
// channel that no domain installed. Unauthorized: an invoke rejects with IPC_UNAUTHORIZED, a send is dropped, a sync
// answers {ok:false, error:"IPC_UNAUTHORIZED"} -- each recorded.
function createIpcRouter({ transport, authorize = () => false, logger = console }) {
  const installed = new Set();
  const allowed = (event, channel, args) => {
    try { return args.length <= 1 && authorize(event, channel, args[0]) === true; }
    catch (error) { logger.warn?.(`[IPC authorization check for ${channel} threw] failed`, error); return false; }
  };
  const refused = (channel) => logger.warn?.(`[IPC] ${channel} refused: unauthorized sender or payload`);

  function claim(channel, kind) {
    const rule = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : null;
    if (!rule || rule.kind !== kind) throw new Error(`IPC channel ${channel} is not a ${kind} channel of ipc_contract.js`);
    if (installed.has(channel)) throw new Error(`IPC channel ${channel} is installed twice`);
    installed.add(channel);
  }

  return {
    handle(channel, handler) {
      claim(channel, "invoke");
      transport.handle(channel, (event, ...args) => {
        if (!allowed(event, channel, args)) { refused(channel); throw new Error("IPC_UNAUTHORIZED"); }
        return handler(event, args[0]);
      });
    },
    send(channel, handler) {
      claim(channel, "send");
      transport.on(channel, (event, ...args) => {
        if (!allowed(event, channel, args)) { refused(channel); return; }
        handler(event, args[0]);
      });
    },
    sync(channel, handler) {
      claim(channel, "sync");
      transport.on(channel, (event, ...args) => {
        if (!allowed(event, channel, args)) { refused(channel); event.returnValue = { ok: false, error: "IPC_UNAUTHORIZED" }; return; }
        try { event.returnValue = handler(event, args[0]); }
        catch (error) {
          logger.error?.(`[IPC] ${channel} failed`, error);
          event.returnValue = { ok: false, error: String(error?.message || error) };
        }
      });
    },
    /** Every renderer -> main channel of the contract has a handler. */
    assertComplete() {
      const missing = Object.entries(CHANNELS).filter(([name, rule]) => rule.kind !== "push" && !installed.has(name)).map(([name]) => name);
      if (missing.length) throw new Error(`IPC channels without a handler: ${missing.join(", ")}`);
    },
    installed: () => new Set(installed),
  };
}

module.exports = { createIpcRouter };
