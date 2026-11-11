"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createClientAuthentication: loadSharedClientToken } = require("../../service/platform/js/daemon_auth");

// The per-launch client credential every business API checks (api/client_auth.py). Health gives every API process
// only its SHA-256; Electron main reads the token file and attaches it -- for trusted renderer frames and
// for its own requests -- to exactly the business API origins currently in effect (apiOrigins(), from Health's
// effective endpoints), never to any other host or port. The renderer never sees the token itself.
//
// The same holds for market_runtime's /live WebSocket: main attaches the VIEWER credential to the
// handshake of a live-view page (`liveViewerRequest`), so no renderer holds a long-lived token. `liveUrl()` is the
// current /live URL (it changes with an apply), `viewerToken()` reads Health's viewer token.
function createClientAuthentication({ apiOrigins, liveUrl = () => "", viewerToken = () => null, fetchImpl = globalThis.fetch,
  env = process.env }) {
  const { token } = loadSharedClientToken({ fs, path, processRef: { env, cwd: () => process.cwd() } });

  function isApi(url) {
    try {
      const value = new URL(url);
      if (value.protocol === "ws:") value.protocol = "http:";
      return apiOrigins().includes(value.origin);
    } catch { /* not an error: an unparsable URL is not one of the API origins */ return false; }
  }

  function isLive(url) {
    try {
      const value = new URL(url), live = new URL(liveUrl());
      return value.protocol === "ws:" && value.origin === live.origin && value.pathname === live.pathname;
    } catch { /* not an error: no live endpoint (or an unparsable URL) is not the /live socket */ return false; }
  }

  function authenticatedFetch(input, options = {}) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (!isApi(url)) return fetchImpl(input, options);
    const headers = new Headers(options.headers || input?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetchImpl(input, { ...options, headers, redirect: "error" });
  }

  const sessions = new WeakSet();
  function secureSession(session, trustedRequest, liveViewerRequest = () => false) {
    if (sessions.has(session)) return;
    sessions.add(session);
    // Loopback only; the port is checked per request against the current origins (they change with an apply).
    session.webRequest.onBeforeSendHeaders({ urls: ["http://127.0.0.1/*", "ws://127.0.0.1/*", "http://localhost/*"] }, (details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "authorization") delete headers[name];
      }
      if (isApi(details.url) && trustedRequest(details)) headers.Authorization = `Bearer ${token}`;
      else if (isLive(details.url) && trustedRequest(details) && liveViewerRequest(details)) {
        const viewer = viewerToken();
        if (viewer) headers.Authorization = `Bearer ${viewer}`;
      }
      callback({ requestHeaders: headers });
    });
  }
  return { fetch: authenticatedFetch, secureSession, isApi, isLive };
}

module.exports = { createClientAuthentication };
