"use strict";

// Path -> business API service_id -- the Node twin of config/api_routes.py (same file, same longest-prefix rule, matched by whole path segments).
// Electron main uses it to address the right service; the renderer receives the same table through preload.

const fs = require("fs");
const path = require("path");

const SCHEMA = "stock-monitor-api-routes-v1";
let cached = null;

function routes() {
  if (!cached) {
    const file = path.resolve(__dirname, "..", "api_routes.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc.schema !== SCHEMA) throw new Error(`${file} is not ${SCHEMA}`);
    cached = doc.routes.map((r) => [r.prefix, r.service_id]).sort((a, b) => b[0].length - a[0].length);
  }
  return cached.map((r) => [...r]);
}

function serviceForPath(pathname) {
  const clean = String(pathname || "").split("?")[0];
  for (const [prefix, serviceId] of routes()) {
    const base = prefix.replace(/\/$/, "");
    if (clean === base || clean.startsWith(`${base}/`)) return serviceId;
  }
  return null;
}

module.exports = { routes, serviceForPath, SCHEMA };
