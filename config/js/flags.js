"use strict";

// Strict boolean parsing for configuration flags -- the Node twin of config/flags.py (same contract, pinned by
// tests/fixtures/config/flag_cases.json). "false" is never truthy because it is a non-empty string, and an
// unrecognised value is an error, not a silent default.

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

class FlagError extends Error {
  constructor(message) { super(message); this.name = "FlagError"; this.code = "CONFIG_FLAG_INVALID"; }
}

function parseFlag(value, { name, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") throw new FlagError(`${name} must be a boolean, got ${typeof value}`);
  const text = value.trim().toLowerCase();
  if (text === "") return fallback;
  if (TRUE.has(text)) return true;
  if (FALSE.has(text)) return false;
  throw new FlagError(`${name} must be one of 1/true/yes/on or 0/false/no/off, got ${JSON.stringify(value)}`);
}

module.exports = { parseFlag, FlagError };
