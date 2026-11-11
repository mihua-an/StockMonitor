import { apiUrl } from "./state.js";
import { untilAborted, withRequestTimeout } from "./request_deadline.js";

// The source selection's snapshot, checked once as a whole when it arrives (config/source_settings.py builds it):
// enabled_sources a list of names, sources an object whose every entry has a list of api_prefixes, startup_steps
// (optional) step -> source name, offline_ui (optional) a boolean. A snapshot of any other shape is a contract error,
// logged once; the renderer then treats every source as disabled and every gated request as refused (fail closed)
// instead of failing later, without context, inside whichever request reached the gate first.
export class SourceConfigContractError extends Error {
  constructor(problem) {
    super(`source settings snapshot refused: ${problem}`);
    this.name = "SourceConfigContractError";
    this.code = "SOURCE_CONFIG_CONTRACT";
  }
}

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function normalizeSourceSettings(raw) {
  if (!isPlainObject(raw)) throw new SourceConfigContractError("not an object");
  if (!isStringList(raw.enabled_sources)) throw new SourceConfigContractError("enabled_sources is not a list of names");
  if (!isPlainObject(raw.sources)) throw new SourceConfigContractError("sources is not an object");
  const sources = {};
  for (const [name, descriptor] of Object.entries(raw.sources)) {
    if (!isPlainObject(descriptor) || !isStringList(descriptor.api_prefixes)) {
      throw new SourceConfigContractError(`sources.${name}.api_prefixes is not a list of paths`);
    }
    sources[name] = Object.freeze({ ...descriptor, api_prefixes: Object.freeze([...descriptor.api_prefixes]) });
  }
  if (raw.startup_steps != null && (!isPlainObject(raw.startup_steps) || !Object.values(raw.startup_steps).every((value) => typeof value === "string"))) {
    throw new SourceConfigContractError("startup_steps is not step -> source name");
  }
  if (raw.offline_ui != null && typeof raw.offline_ui !== "boolean") throw new SourceConfigContractError("offline_ui is not a boolean");
  return Object.freeze({
    ...raw,
    enabled_sources: Object.freeze([...raw.enabled_sources]),
    sources: Object.freeze(sources),
    startup_steps: Object.freeze({ ...(raw.startup_steps || {}) }),
    offline_ui: raw.offline_ui === true,
  });
}

// Electron supplies its immutable startup selection through preload. Browser
// clients load the same snapshot from FastAPI before issuing provider requests.
let settings = null;
let contractError = null;
function adopt(raw, origin) {
  try {
    settings = normalizeSourceSettings(raw);
    contractError = null;
  } catch (error) {
    settings = null;
    contractError = error;
    console.error(`[source settings: ${origin}] ${error.message}; every source is treated as disabled`, error);
  }
}
if (window.desktopAPI?.sourceSettings) adopt(window.desktopAPI.sourceSettings, "preload snapshot");
let loading = null;
// One shared load for every waiter, capped by the common request deadline; each waiter stops waiting at its own
// deadline (`signal`) without cancelling the load for the others. A refused snapshot rejects every waiter.
export async function initializeSourceSettings(signal = undefined) {
  if (settings) return settings;
  if (contractError) throw contractError;
  if (!loading) {
    const { signal: loadSignal, cleanup } = withRequestTimeout(undefined);
    loading = fetch(apiUrl("/api/sources"), { signal: loadSignal }).then(async response => {
      if (!response.ok) throw new Error("Source configuration unavailable");
      adopt((await response.json()).source_settings, "GET /api/sources");
      if (contractError) throw contractError;
      return settings;
    }).finally(() => { cleanup(); loading = null; });
  }
  return untilAborted(loading, signal);
}
export function sourceEnabled(source) {
  return Boolean(settings?.enabled_sources.includes(source));
}
export function startupStepEnabled(stepId) {
  const source = settings?.startup_steps?.[stepId];
  return !source || sourceEnabled(source);
}
export async function disabledRequest(path, body = null, signal = undefined) {
  await initializeSourceSettings(signal);
  const url = new URL(path, "http://renderer.invalid");  // path parsing only; the address is apiUrl()'s
  // Broker-free desktop acceptance may exercise persisted Shioaji history.
  // The backend admits this explicit local-only surface while all daemon,
  // realtime, repair, credential, and broker endpoints remain disabled.
  if (settings?.offline_ui && url.pathname.startsWith("/api/history/")) return null;
  if (settings?.offline_ui && body === null && [
    "/api/data-center/dates",
    "/api/data-center/date",
    "/api/data-center/closing",
  ].includes(url.pathname)) return null;
  const match = Object.entries(settings.sources).find(([, value]) => value.api_prefixes.some(prefix => url.pathname.startsWith(prefix)));
  const source = match?.[0] || (url.pathname.startsWith("/api/product-catalog/") ? body?.source || url.searchParams.get("source") : null);
  if (!source || sourceEnabled(source)) return null;
  return { ok: false, source, enabled: false, error: "SOURCE_DISABLED", lifecycle: "disabled", items: [], status: { enabled: false, source_status: { lifecycle: "disabled", health: "disabled" } } };
}
