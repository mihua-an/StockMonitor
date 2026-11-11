"use strict";
const fs = require("fs");
const path = require("path");
const { parseFlag } = require("./flags");

// Source selection only (AGENTS.md section 3) -- the Node twin of config/source_settings.py. Shared by
// ui/main (UI/IPC source-enabled checks) and health/ (whether to start the Shioaji/Futu providers at all).
//
// A bare `path.resolve(__dirname, "../../config/...")` resolves relative to
// THIS file's own location (config/js/), not the caller's -- so it is
// unaffected by which directory depth ui/main/ vs health/ happen to sit at.
// In dev that relative resolution reaches the real checkout, but a packaged
// build archives ui/main's and health's *.js separately from
// config/ (see package.json's build.extraResources) -- resolve the
// packaged resources path explicitly instead of assuming a relative layout,
// matching service/platform/js/launch_runtime.js's own packaged-vs-dev branching.
function resolveSourceSettingsPath() {
  const resourcesPath = process.resourcesPath || String(process.env.STOCK_MONITOR_RESOURCES_PATH || "").trim();
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "app-runtime", "config", "source_settings.json");
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.resolve(__dirname, "..", "..", "config", "source_settings.json");
}

const SUPPORTED_CONTRACT_VERSIONS = [1];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Every way `doc` is not a supported source_settings.json; the same strings as config/source_settings.py
// source_settings_problems (tests/fixtures/source_settings_cases.json).
function sourceSettingsProblems(doc) {
  if (!isObject(doc)) return ["settings must be an object"];
  const problems = [];
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(doc.contract_version)) {
    problems.push(`contract_version must be one of ${JSON.stringify(SUPPORTED_CONTRACT_VERSIONS).replace(/,/g, ", ")}`);
  }
  const sources = doc.sources;
  if (!isObject(sources) || !Object.keys(sources).length) return [...problems, "sources must be a non-empty object"];
  for (const [name, spec] of Object.entries(sources)) {
    if (!isObject(spec)) { problems.push(`sources.${name} must be an object`); continue; }
    const prefixes = spec.api_prefixes;
    if (!Array.isArray(prefixes) || !prefixes.length || !prefixes.every((p) => typeof p === "string" && p.startsWith("/api/"))) {
      problems.push(`sources.${name}.api_prefixes must be a non-empty list of /api/ paths`);
    }
  }
  const known = (s) => typeof s === "string" && Object.hasOwn(sources, s);
  if (!Array.isArray(doc.enabled_sources) || !doc.enabled_sources.every(known)) problems.push("enabled_sources must list sources");
  return problems;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// The loaded settings are one immutable snapshot: every consumer (Electron main, the renderer through preload, Health)
// reads the file's values, never a copy another module rewrote.
function loadSourceSettings(env = process.env) {
  const file = resolveSourceSettingsPath();
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = sourceSettingsProblems(settings);
  if (problems.length) throw new Error(`${file} is invalid: ${problems.join("; ")}`);
  const offlineUi = parseFlag(env.STOCK_MONITOR_OFFLINE_UI, { name: "STOCK_MONITOR_OFFLINE_UI", fallback: false });
  const enabled = offlineUi ? [] : (env.STOCK_MONITOR_SOURCES === undefined ? settings.enabled_sources : env.STOCK_MONITOR_SOURCES.split(",").map(s => s.trim()).filter(Boolean));
  if (!Array.isArray(enabled) || (!enabled.length && !offlineUi) || enabled.some(s => !Object.hasOwn(settings.sources, s))) {
    throw new Error("STOCK_MONITOR_SOURCES must select shioaji, futu, or shioaji,futu");
  }
  return deepFreeze({ ...settings, enabled_sources: [...new Set(enabled)], offline_ui: offlineUi });
}

const sourceSettings = loadSourceSettings();
const sourceEnabled = source => sourceSettings.enabled_sources.includes(source);

module.exports = { loadSourceSettings, sourceSettingsProblems, sourceSettings, sourceEnabled };
