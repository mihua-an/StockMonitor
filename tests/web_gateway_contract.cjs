"use strict";
// The web gateway (ui/web): who gets in (Cloudflare Access JWT, loopback-only "none"), same-origin checks, which
// renderer files it serves, what the proxy forwards, and that the browser shim offers everything preload.js does.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { AccessDenied, accessConfig, createAccessVerifier, sameOrigin, needsSameOrigin } = require("../ui/web/access_auth.js");
const { forwardedHeaders, loopbackTarget } = require("../ui/web/proxy.js");
const { rendererFile } = require("../ui/web/gateway.js");

const ROOT = path.join(__dirname, "..");
const TEAM = "example-team.cloudflareaccess.com";
const AUD = "a".repeat(64);

function keyPair(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

function sign(key, claims, header = {}) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

function verifierWith(keys, counter = { fetches: 0 }, now = () => Date.now()) {
  const config = accessConfig({ STOCK_MONITOR_WEB_CF_TEAM_DOMAIN: `https://${TEAM}/`, STOCK_MONITOR_WEB_CF_AUD: AUD }, { host: "127.0.0.1" });
  const fetchImpl = async (url) => {
    counter.fetches += 1;
    assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
    return { ok: true, status: 200, json: async () => ({ keys: keys.map((k) => k.jwk) }) };
  };
  return createAccessVerifier(config, { fetchImpl, now, logger: { warn() {}, error() {} } });
}

const claims = (extra = {}) => ({ aud: [AUD], iss: `https://${TEAM}`, email: "me@example.com",
  exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), ...extra });
const request = (headers) => ({ headers });

test("access mode: Cloudflare Access needs both values; none only on loopback; nothing configured refuses to start", () => {
  assert.equal(accessConfig({ STOCK_MONITOR_WEB_CF_TEAM_DOMAIN: TEAM, STOCK_MONITOR_WEB_CF_AUD: AUD }, { host: "127.0.0.1" }).mode, "cloudflare-access");
  assert.throws(() => accessConfig({ STOCK_MONITOR_WEB_CF_TEAM_DOMAIN: TEAM }, { host: "127.0.0.1" }), /STOCK_MONITOR_WEB_CF_AUD/);
  assert.equal(accessConfig({ STOCK_MONITOR_WEB_AUTH: "none" }, { host: "127.0.0.1" }).mode, "none");
  assert.throws(() => accessConfig({ STOCK_MONITOR_WEB_AUTH: "none" }, { host: "0.0.0.0" }), /loopback/);
  assert.throws(() => accessConfig({}, { host: "127.0.0.1" }), /needs an access mode/);
  assert.throws(() => accessConfig({ STOCK_MONITOR_WEB_CF_TEAM_DOMAIN: "bad domain/../x", STOCK_MONITOR_WEB_CF_AUD: AUD }, { host: "127.0.0.1" }), /invalid/);
});

test("a valid Access assertion is let in, from the header or the CF_Authorization cookie", async () => {
  const key = keyPair("k1");
  const verifier = verifierWith([key]);
  assert.deepEqual(await verifier.verify(request({ "cf-access-jwt-assertion": sign(key, claims()) })), { identity: "me@example.com" });
  assert.deepEqual(await verifier.verify(request({ cookie: `other=1; CF_Authorization=${sign(key, claims())}` })), { identity: "me@example.com" });
});

test("a missing, forged, foreign, expired or early assertion is refused", async () => {
  const key = keyPair("k1");
  const forger = keyPair("k1");   // same kid, other key: the signature does not verify
  const verifier = verifierWith([key]);
  const refused = async (headers, reason) => {
    await assert.rejects(verifier.verify(request(headers)), (error) => error instanceof AccessDenied && reason.test(error.reason));
  };
  await refused({}, /no Cloudflare Access token/);
  await refused({ "cf-access-jwt-assertion": "not-a-jwt" }, /malformed/);
  await refused({ "cf-access-jwt-assertion": sign(forger, claims()) }, /bad signature/);
  await refused({ "cf-access-jwt-assertion": sign(key, claims({ aud: ["another-app"] })) }, /another application/);
  await refused({ "cf-access-jwt-assertion": sign(key, claims({ iss: "https://evil.cloudflareaccess.com" })) }, /another issuer/);
  await refused({ "cf-access-jwt-assertion": sign(key, claims({ exp: Math.floor(Date.now() / 1000) - 3600 })) }, /expired/);
  await refused({ "cf-access-jwt-assertion": sign(key, claims({ nbf: Math.floor(Date.now() / 1000) + 3600 })) }, /not yet valid/);
  await refused({ "cf-access-jwt-assertion": sign(key, claims(), { alg: "HS256" }) }, /algorithm/);
});

test("keys are cached, and an unknown kid is fetched again only once in a while", async () => {
  const key = keyPair("k1");
  const counter = { fetches: 0 };
  const verifier = verifierWith([key], counter);
  for (let i = 0; i < 5; i += 1) await verifier.verify(request({ "cf-access-jwt-assertion": sign(key, claims()) }));
  assert.equal(counter.fetches, 1);
  const stranger = keyPair("k-unknown");
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(verifier.verify(request({ "cf-access-jwt-assertion": sign(stranger, claims()) })), /unknown signing key/);
  }
  assert.equal(counter.fetches, 2, "one refetch for a rotated key, not one per request");
});

test("same-origin: state-changing requests and sockets need an Origin naming the addressed host", () => {
  const req = (method, headers) => ({ method, headers: { host: "stock.example.com", ...headers } });
  assert.equal(sameOrigin(req("PUT", { origin: "https://stock.example.com" })), true);
  assert.equal(sameOrigin(req("PUT", { origin: "https://evil.example" })), false);
  assert.equal(sameOrigin(req("PUT", { origin: "null" })), false);
  assert.equal(sameOrigin(req("PUT", {})), false);
  assert.equal(needsSameOrigin(req("GET", {})), false);
  assert.equal(needsSameOrigin(req("POST", {})), true);
  assert.equal(needsSameOrigin(req("DELETE", {})), true);
});

test("only renderer files are served: no traversal, no dotfiles, no untrusted top-level page", () => {
  const renderer = path.join(ROOT, "ui", "renderer");
  assert.equal(rendererFile("/index.html"), path.join(renderer, "index.html"));
  assert.equal(rendererFile("/pages/realtime.html"), path.join(renderer, "pages", "realtime.html"));
  assert.equal(rendererFile("/app.js"), path.join(renderer, "app.js"));
  for (const bad of ["/../package.json", "/%2e%2e/package.json", "/js/../../main/preload.js", "/.hidden", "/js/.x/y.js",
    "/untrusted.html", "/", "/%00index.html", "/%E0%A4%A"]) {
    assert.equal(rendererFile(bad), null, bad);
  }
});

test("the proxy drops the browser's credentials and Cloudflare headers and attaches the service token", () => {
  const headers = forwardedHeaders({
    host: "stock.example.com", cookie: "CF_Authorization=abc", authorization: "Bearer browser", origin: "https://stock.example.com",
    "cf-access-jwt-assertion": "jwt", "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4", "x-stockmonitor-client": "c",
    "content-type": "application/json", accept: "text/event-stream", connection: "keep-alive",
  }, new URL("http://127.0.0.1:8001"), "service-token");
  assert.deepEqual(headers, { "content-type": "application/json", accept: "text/event-stream", host: "127.0.0.1:8001",
    authorization: "Bearer service-token" });
  assert.throws(() => loopbackTarget("http://10.0.0.5:8001"), /non-loopback/);
  assert.throws(() => loopbackTarget("https://127.0.0.1:8001"), /non-http/);
  assert.equal(loopbackTarget("http://127.0.0.1:8010").port, "8010");
});

test("the browser shim offers every desktopAPI member preload.js does", () => {
  const members = (file, marker) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const block = source.slice(source.indexOf(marker));
    return new Set([...block.matchAll(/^\s{2,4}([a-zA-Z]+)(?::|,$)/gm)].map((m) => m[1]));
  };
  const preload = members("ui/main/preload.js", "exposeInMainWorld");
  const shim = members("ui/web/desktop_api.js", "window.desktopAPI = Object.freeze");
  const missing = [...preload].filter((name) => !shim.has(name));
  assert.deepEqual(missing, [], `members the web shim lacks: ${missing.join(", ")}`);
});
