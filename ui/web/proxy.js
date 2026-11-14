"use strict";

// The web gateway's forwarding to the loopback services (ui/web/gateway.js). The browser addresses everything to the
// gateway's own origin under /svc/<service_id>/...; here the request goes on to that service's effective address
// with the credential Electron main would have attached (client_auth.js): the client token for the business APIs,
// the viewer token for market_runtime's /live socket. The browser never holds either token, and whatever
// credential, cookie or Access assertion it sent is dropped before forwarding.

const http = require("node:http");
const net = require("node:net");

// Hop-by-hop headers (RFC 9110 section 7.6.1) and everything that identifies the browser's session with Cloudflare.
const DROPPED_REQUEST_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
  "host", "authorization", "cookie", "origin", "referer",
  "cf-access-jwt-assertion", "cf-access-authenticated-user-email", "cf-connecting-ip", "cf-ipcountry", "cf-ray",
  "cf-visitor", "cf-warp-tag-id", "cdn-loop", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "access-control-allow-origin",
  "access-control-allow-credentials", "access-control-allow-headers", "access-control-allow-methods"]);

function forwardedHeaders(incoming, target, token) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower) || lower.startsWith("sec-websocket-") || lower.startsWith("x-stockmonitor-")) continue;
    headers[lower] = value;
  }
  headers.host = target.host;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function loopbackTarget(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "ws:") throw new Error(`refusing a non-http service address: ${baseUrl}`);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error(`refusing a non-loopback service address: ${baseUrl}`);
  return url;
}

// Plain HTTP (JSON requests, SSE streams): streamed both ways, so an event stream is not buffered.
function proxyHttp(req, res, { baseUrl, pathAndQuery, token, logger = console, timeoutMs = 0 }) {
  let target;
  try { target = loopbackTarget(baseUrl); }
  catch (error) {
    logger.error?.(`[WEB PROXY] ${error.message}`);
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "WEB_PROXY_TARGET_INVALID" }));
    return;
  }
  const upstream = http.request({
    host: target.hostname.replace(/^\[|\]$/g, ""), port: target.port, method: req.method,
    path: `${target.pathname.replace(/\/$/, "")}${pathAndQuery}`, headers: forwardedHeaders(req.headers, target, token),
  }, (response) => {
    const headers = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    headers["cache-control"] = headers["cache-control"] || "no-store";
    res.writeHead(response.statusCode || 502, headers);
    response.pipe(res);
    res.on("close", () => response.destroy());
  });
  if (timeoutMs > 0) upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (error) => {
    logger.warn?.(`[WEB PROXY] ${req.method} ${pathAndQuery.split("?")[0]} -> ${target.host} failed: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "WEB_PROXY_UPSTREAM_UNREACHABLE" }));
    } else {
      res.destroy();
    }
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

// A WebSocket upgrade: the handshake is re-sent to the service with the token, then bytes flow both ways untouched.
function proxyUpgrade(req, socket, head, { baseUrl, pathAndQuery, token, logger = console }) {
  let target;
  try { target = loopbackTarget(baseUrl); }
  catch (error) {
    logger.error?.(`[WEB PROXY] ${error.message}`);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = net.connect({ host: target.hostname.replace(/^\[|\]$/g, ""), port: Number(target.port) });
  const headers = forwardedHeaders(req.headers, target, token);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade || "websocket";
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.toLowerCase().startsWith("sec-websocket-")) headers[name.toLowerCase()] = value;
  }
  const lines = [`GET ${target.pathname.replace(/\/$/, "")}${pathAndQuery} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  const closeBoth = () => { socket.destroy(); upstream.destroy(); };
  upstream.on("connect", () => {
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", (error) => {
    logger.warn?.(`[WEB PROXY] WebSocket ${pathAndQuery.split("?")[0]} -> ${target.host} failed: ${error.message}`);
    if (socket.writable && !upstream.bytesRead) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    closeBoth();
  });
  socket.on("error", closeBoth);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}

module.exports = { proxyHttp, proxyUpgrade, forwardedHeaders, loopbackTarget };
