"use strict";

// Who may use the web gateway (ui/web/gateway.js). The gateway holds the business-API client token and the market
// runtime viewer token, so every request it serves is checked here first.
//
// cloudflare-access (the deployment mode): the gateway listens on loopback behind a Cloudflare Tunnel, and
// Cloudflare Access puts a signed JWT on every request it lets through (the Cf-Access-Jwt-Assertion header, also
// the CF_Authorization cookie). The JWT is verified here -- RS256 against the team's published keys, this
// application's AUD tag, the team issuer, and its expiry -- so a request that reaches the port without passing
// Access (another local process, a tunnel misconfiguration) is refused all the same.
//
// none: no identity check at all. Allowed only when the gateway listens on a loopback address, for a browser on the
// same machine or an SSH port forward; the gateway refuses to start in this mode on any other address.
//
// Separately, same-origin checks stop another site from riding the Access cookie (CSRF): a state-changing request
// and every WebSocket upgrade must carry an Origin whose host is the host the browser addressed.

const crypto = require("node:crypto");
const { isLoopbackHost } = require("../../config/js/network_config.js");

const CERTS_TTL_MS = 10 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 30 * 1000;
const CLOCK_SKEW_S = 60;

class AccessDenied extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function base64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function normalizeTeamDomain(value) {
  const text = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!text) return "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(text)) throw new Error(`invalid Cloudflare Access team domain: ${value}`);
  return text.toLowerCase();
}

// The configured mode, from the environment; throws (the gateway does not start) on an incomplete or unsafe setup.
function accessConfig(env = process.env, { host }) {
  const team = normalizeTeamDomain(env.STOCK_MONITOR_WEB_CF_TEAM_DOMAIN);
  const aud = String(env.STOCK_MONITOR_WEB_CF_AUD || "").trim();
  const requested = String(env.STOCK_MONITOR_WEB_AUTH || (team || aud ? "cloudflare-access" : "")).trim().toLowerCase();
  if (requested === "cloudflare-access") {
    if (!team || !aud) {
      throw new Error("STOCK_MONITOR_WEB_AUTH=cloudflare-access needs STOCK_MONITOR_WEB_CF_TEAM_DOMAIN "
        + "(e.g. yourteam.cloudflareaccess.com) and STOCK_MONITOR_WEB_CF_AUD (the Access application's AUD tag)");
    }
    return { mode: "cloudflare-access", team, aud, issuer: `https://${team}` };
  }
  if (requested === "none") {
    if (!isLoopbackHost(host)) {
      throw new Error(`STOCK_MONITOR_WEB_AUTH=none is allowed only on a loopback address, not ${host}`);
    }
    return { mode: "none" };
  }
  throw new Error("the web gateway needs an access mode: set STOCK_MONITOR_WEB_CF_TEAM_DOMAIN and STOCK_MONITOR_WEB_CF_AUD "
    + "(Cloudflare Access), or STOCK_MONITOR_WEB_AUTH=none for a loopback-only gateway");
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

function createAccessVerifier(config, { fetchImpl = globalThis.fetch, now = () => Date.now(), logger = console } = {}) {
  if (config.mode === "none") {
    return { mode: "none", async verify() { return { identity: "local" }; } };
  }
  let keys = new Map();
  let fetchedAt = 0;
  let lastUnknownKidFetch = 0;
  let inflight = null;

  async function loadKeys() {
    if (inflight) return inflight;
    inflight = (async () => {
      const response = await fetchImpl(`https://${config.team}/cdn-cgi/access/certs`, { redirect: "error" });
      if (!response.ok) throw new Error(`Access certs HTTP ${response.status}`);
      const body = await response.json();
      const next = new Map();
      for (const jwk of body?.keys || []) {
        if (jwk?.kty !== "RSA" || !jwk.kid) continue;
        try { next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" })); }
        catch (error) { logger.warn?.(`[WEB ACCESS] ignoring an unusable Access key ${jwk.kid}: ${error.message}`); }
      }
      if (!next.size) throw new Error("Access certs carried no RSA key");
      keys = next;
      fetchedAt = now();
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function keyFor(kid) {
    if (!keys.size || now() - fetchedAt > CERTS_TTL_MS) await loadKeys();
    if (!keys.has(kid) && now() - lastUnknownKidFetch > UNKNOWN_KID_REFETCH_MS) {
      lastUnknownKidFetch = now();   // a rotated key: ask once, then refuse further unknown kids for a while
      await loadKeys();
    }
    const key = keys.get(kid);
    if (!key) throw new AccessDenied("unknown signing key");
    return key;
  }

  async function verify(req) {
    const token = String(req.headers["cf-access-jwt-assertion"] || "").trim()
      || cookieValue(req.headers.cookie, "CF_Authorization");
    if (!token) throw new AccessDenied("no Cloudflare Access token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AccessDenied("malformed token");
    let header;
    let claims;
    try { header = base64urlJson(parts[0]); claims = base64urlJson(parts[1]); }
    catch { throw new AccessDenied("malformed token"); }
    if (header?.alg !== "RS256") throw new AccessDenied("unexpected token algorithm");
    let key;
    try { key = await keyFor(String(header.kid || "")); }
    catch (error) {
      if (error instanceof AccessDenied) throw error;
      logger.error?.(`[WEB ACCESS] reading the Access signing keys failed: ${error.message}`);
      throw new AccessDenied("signing keys unavailable");
    }
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], "base64url");
    if (!crypto.verify("RSA-SHA256", signed, key, signature)) throw new AccessDenied("bad signature");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(config.aud)) throw new AccessDenied("token is for another application");
    if (claims.iss !== config.issuer) throw new AccessDenied("token from another issuer");
    const seconds = now() / 1000;
    if (!(Number(claims.exp) > seconds - CLOCK_SKEW_S)) throw new AccessDenied("token expired");
    if (claims.nbf !== undefined && Number(claims.nbf) > seconds + CLOCK_SKEW_S) throw new AccessDenied("token not yet valid");
    return { identity: String(claims.email || claims.sub || "access-user") };
  }

  return { mode: "cloudflare-access", verify };
}

// The host the browser addressed (the Host header; the tunnel keeps the public hostname in it).
function requestHost(req) {
  return String(req.headers.host || "").trim().toLowerCase();
}

// True when the request comes from a page of this gateway. A browser always sends Origin on a cross-origin
// state-changing fetch and on every WebSocket handshake, so a missing Origin there is refused too.
function sameOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin || origin === "null") return false;
  try { return new URL(origin).host.toLowerCase() === requestHost(req); }
  catch { /* not an error: an unparsable Origin is not this origin (refused) */ return false; }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function needsSameOrigin(req) {
  return !SAFE_METHODS.has(String(req.method || "GET").toUpperCase());
}

module.exports = { AccessDenied, accessConfig, createAccessVerifier, sameOrigin, needsSameOrigin, requestHost, cookieValue };
