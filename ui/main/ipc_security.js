"use strict";

const { channelRule, DETACHED_COMPONENT_IDS, PAGES } = require("./ipc_contract");

// Every renderer -> main event is checked against ipc_contract.js: the channel is listed, the sender is a live
// window's main frame on a trusted page the channel allows, and the payload passes the channel's schema. Both
// dependencies are supplied by composition; missing dependencies fail closed.
function createIpcAuthorizer({ trustedRendererPage, fromWebContents } = {}) {
  return function authorizeEvent(event, channel, payload) {
    try {
      const rule = channelRule(channel);
      const sender = event?.sender;
      const frame = event?.senderFrame;
      if (!rule || !sender || sender.isDestroyed() || !frame || frame !== sender.mainFrame) return false;
      const win = fromWebContents(sender);
      if (!win || win.isDestroyed() || win.webContents !== sender) return false;
      const page = trustedRendererPage(frame.url);
      return rule.pages.includes(page) && rule.schema(payload) === true;
    } catch (_) { console.warn("[IPC payload schema check threw] failed", _); return false; }
  };
}

module.exports = { createIpcAuthorizer, DETACHED_COMPONENT_IDS, LIVE_VIEWER_PAGES: PAGES.LIVE_VIEWER };
