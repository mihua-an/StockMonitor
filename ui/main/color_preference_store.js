"use strict";

const { writeJsonAtomic } = require("../../service/platform/js/atomic_files");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveVarPaths } = require("../../config/js/var_paths");

// User-configurable market-quote colors (settings page "圖表顏色"). This is a
// pure UI display preference -- it never needs the FastAPI backend or the
// Service Controller, so it is a small local JSON file, following the same
// <dataRoot>/preferences/ convention as watch_page_store.js.
const DEFAULT_COLORS = Object.freeze({
  // = styles/tokens.css --market-red / --market-green (one red, one green).
  priceUpColor: "#e11919",
  priceDownColor: "#00993d",
  priceFlatColor: "#ffffff",
});

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function sanitizeColors(candidate) {
  const result = { ...DEFAULT_COLORS };
  if (candidate && typeof candidate === "object") {
    for (const key of Object.keys(DEFAULT_COLORS)) {
      const value = candidate[key];
      if (typeof value === "string" && HEX_COLOR_PATTERN.test(value.trim())) {
        result[key] = value.trim();
      }
    }
  }
  return result;
}

// The one stored shape is the three color keys. A file without them (the first color setting saved only a scheme
// name) is refused with a warning and the defaults apply until the user saves again.
function isCurrentShape(candidate) {
  return Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
    && Object.keys(DEFAULT_COLORS).some((key) => key in candidate) && !("scheme" in candidate);
}

function createColorPreferenceStore(projectRoot) {
  const dataRoot = resolveVarPaths({ projectRoot, env: process.env }).data;
  const filePath = path.join(dataRoot, "preferences", "ui_color_preferences.json");

  // Written to a temp file and renamed (a crash mid-write must not leave a truncated file), and a file that does not
  // parse is set aside and reported rather than silently replaced by the defaults.
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      // absent is not an error: never saved
      if (error?.code !== "ENOENT") console.warn(`[COLOR PREFERENCES] reading ${filePath} failed; using defaults`, error);
      return { ...DEFAULT_COLORS };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Each damaged file gets its own name, so an earlier one is never in the way; the record says what happened.
      const aside = `${filePath}.corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      try {
        fs.renameSync(filePath, aside);
        console.warn(`[COLOR PREFERENCES] ${filePath} is unreadable (${error.message}); moved to ${aside}, using defaults`);
      } catch (moveError) {
        console.error(`[COLOR PREFERENCES] ${filePath} is unreadable (${error.message}) and moving it to ${aside} failed `
          + `(${moveError?.message || moveError}); the file is kept where it is, using defaults`);
      }
      return { ...DEFAULT_COLORS };
    }
    if (!isCurrentShape(parsed)) {
      console.warn(`[COLOR PREFERENCES] ${filePath} is not the current color shape (${raw.slice(0, 120)}); refused, using defaults`);
      return { ...DEFAULT_COLORS };
    }
    return sanitizeColors(parsed);
  }

  // This store is the file's only writer: the value is read once and kept, so a new window's preload (which waits on
  // it before first paint) never waits on the disk.
  let saved = null;
  function current() {
    if (!saved) saved = load();
    return { ...saved };
  }

  function save(candidate) {
    const sanitized = sanitizeColors(candidate);
    writeJsonAtomic(filePath, sanitized);
    saved = sanitized;
    return { ...sanitized };
  }

  return { load, current, save, defaults: () => ({ ...DEFAULT_COLORS }) };
}

module.exports = { createColorPreferenceStore, DEFAULT_COLORS };
