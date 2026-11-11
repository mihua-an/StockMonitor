"use strict";

// Node loader for config/provider_contract.json (Python: service/market/shared/provider_contract.py). It lived in
// service/market/shared/ and Electron main located that service-internal file itself, with its own packaged-vs-dev
// path guess; cross-language contracts live in config/, read relative to this file in both layouts.
//
// Every field is required and checked with the Python loader's rules and error codes; nothing is defaulted (a missing
// default_source must not become "shioaji" here while Python refuses the file).
const fs = require("fs");
const path = require("path");

const SUPPORTED_VERSIONS = new Set([1]);

class ProviderContractError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProviderContractError";
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

function validateProviderContract(contract) {
  if (!isPlainObject(contract)) throw new ProviderContractError("CONTRACT_NOT_OBJECT");
  const version = contract.contract_version;
  if (!Number.isInteger(version) || !SUPPORTED_VERSIONS.has(version)) {
    throw new ProviderContractError("CONTRACT_VERSION_UNSUPPORTED", JSON.stringify(version));
  }
  const canonical = contract.canonical_sources;
  if (!Array.isArray(canonical) || !canonical.length || !canonical.every((x) => isNonEmptyString(x) && x === x.toLowerCase())
      || new Set(canonical).size !== canonical.length) {
    throw new ProviderContractError("CANONICAL_SOURCES_INVALID", JSON.stringify(canonical));
  }
  if (!isNonEmptyString(contract.default_source) || !canonical.includes(contract.default_source)) {
    throw new ProviderContractError("DEFAULT_SOURCE_INVALID", JSON.stringify(contract.default_source));
  }
  return contract;
}

const contract = validateProviderContract(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "provider_contract.json"), "utf8")));
const DEFAULT_PROVIDER_SOURCE = contract.default_source;

// A provider source read at an I/O boundary: a canonical name, or the default when none is given.
function normalizeProviderSource(rawSource = "") {
  const source = String(rawSource || "").trim().toLowerCase();
  if (!source) return DEFAULT_PROVIDER_SOURCE;
  if (!contract.canonical_sources.includes(source)) throw new ProviderContractError("SOURCE_UNKNOWN", JSON.stringify(rawSource));
  return source;
}

module.exports = { normalizeProviderSource, validateProviderContract, ProviderContractError };
