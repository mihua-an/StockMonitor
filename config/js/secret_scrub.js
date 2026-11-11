"use strict";

// Node half of config/secret_scrub.py: the same rules over the same data (config/secret_scrub.json holds them and their
// exact wording). secretName decides a key; secretSpans finds the secret parts of a string (a query parameter, a form
// field, an Authorization line, a quoted JSON field inside a message, a bare Bearer value, a JSON Web Token, a PEM
// private key); scrubText replaces them; scrubValue walks a structure dropping secret keys and scrubbing every string;
// secretPaths lists where a structure holds one. tests/fixtures/secret_scrub_cases.json holds the cases Python, Node and
// Rust (native/market_runtime/src/remediation.rs) must agree on.

const fs = require("fs");
const path = require("path");

const RULES_PATH = path.join(__dirname, "..", "secret_scrub.json");
const RULES = Object.freeze(JSON.parse(fs.readFileSync(RULES_PATH, "utf8")));
const EXACT = new Set(RULES.exact_names);
const AUTH_SCHEMES = new Set(RULES.auth_schemes);
const REDACTED = RULES.redacted;
const MAX_DEPTH = RULES.max_depth;

const ALNUM = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
const NAME = new Set([...ALNUM, "_", ".", "-"]);
const JWT = new Set([...ALNUM, "_", "-"]);
const SPACES = new Set(" \t");
const QUOTES = new Set("\"'");
const VALUE_STOP = new Set(" \t\r\n\f\v\"'&;,()[]{}<>");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function secretName(name) {
  const normalized = [...String(name).toUpperCase()].filter((c) => (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")).join("");
  return EXACT.has(normalized) || RULES.key_markers.some((marker) => normalized.includes(marker));
}

function skip(text, at, chars) {
  while (at < text.length && chars.has(text[at])) at += 1;
  return at;
}

function runEnd(text, at) {
  while (at < text.length && !VALUE_STOP.has(text[at])) at += 1;
  return at;
}

// The secret after a secret name ending at nameEnd (rule 1), or null.
function namedValue(text, nameEnd) {
  let at = nameEnd < text.length && QUOTES.has(text[nameEnd]) ? nameEnd + 1 : nameEnd;
  at = skip(text, at, SPACES);
  if (at >= text.length || (text[at] !== "=" && text[at] !== ":")) return null;
  at = skip(text, at + 1, SPACES);
  if (at < text.length && QUOTES.has(text[at])) at += 1;
  const end = runEnd(text, at);
  if (end === at) return null;
  if (AUTH_SCHEMES.has(text.slice(at, end).toUpperCase())) {
    const after = skip(text, end, SPACES);
    const final = after > end ? runEnd(text, after) : after;
    return final > after ? [after, final] : [end, end];
  }
  return [at, end];
}

// The merged [start, end) spans of text that are secret.
function secretSpans(text) {
  if (text.includes(RULES.pem_marker)) return text ? [[0, text.length]] : [];
  const spans = [];
  const size = text.length;
  let at = 0;
  while (at < size) {
    if (NAME.has(text[at]) && (at === 0 || !NAME.has(text[at - 1]))) {
      const end = skip(text, at, NAME);
      const found = secretName(text.slice(at, end)) ? namedValue(text, end) : null;
      if (found && found[1] > found[0]) {
        spans.push(found);
        at = found[1];
      } else {
        at = end;
      }
      continue;
    }
    at += 1;
  }
  for (const scheme of RULES.bare_schemes) {
    for (let start = 0; start < size - scheme.length; start += 1) {
      const after = start + scheme.length;
      if (SPACES.has(text[after]) && text.slice(start, after).toUpperCase() === scheme && (start === 0 || !ALNUM.has(text[start - 1]))) {
        const value = skip(text, after, SPACES);
        const end = runEnd(text, value);
        if (end > value) spans.push([value, end]);
      }
    }
  }
  for (let start = text.indexOf("eyJ"); start !== -1; start = text.indexOf("eyJ", start + 1)) {
    if (start !== 0 && JWT.has(text[start - 1])) continue;
    const first = skip(text, start + 3, JWT);
    if (!(first > start + 3 && first < size && text[first] === ".")) continue;
    const second = skip(text, first + 1, JWT);
    if (second > first + 1 && second < size && text[second] === ".") spans.push([start, skip(text, second + 1, JWT)]);
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

function scrubText(text) {
  let out = "";
  let cursor = 0;
  for (const [start, end] of secretSpans(text)) {
    out += text.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return out + text.slice(cursor);
}

// value with every secret key dropped and every string scrubbed; a container at MAX_DEPTH is REDACTED.
function scrubValue(value, depth = 0) {
  if (typeof value === "string") return scrubText(value);
  if (!isObject(value) && !Array.isArray(value)) return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) if (!secretName(key)) out[key] = scrubValue(item, depth + 1);
  return out;
}

// Where value holds a secret: a secret key (unless listed in allowedNames), a string with a secret span, or a
// container nested beyond MAX_DEPTH (it cannot be checked).
function secretPaths(value, prefix = "", { allowedNames = new Set(), depth = 0 } = {}) {
  if (typeof value === "string") return secretSpans(value).length ? [prefix] : [];
  if (!isObject(value) && !Array.isArray(value)) return [];
  if (depth >= MAX_DEPTH) return [prefix];
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...secretPaths(item, `${prefix}[${index}]`, { allowedNames, depth: depth + 1 })));
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (secretName(key) && !allowedNames.has(key)) found.push(at);
    else found.push(...secretPaths(item, at, { allowedNames, depth: depth + 1 }));
  }
  return found;
}

module.exports = { RULES_PATH, REDACTED, MAX_DEPTH, secretName, secretSpans, scrubText, scrubValue, secretPaths };
