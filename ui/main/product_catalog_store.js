"use strict";

const { withTimeout } = require("../../service/platform/js/fetch_timeout");
const { normalizeProviderSource } = require("../../config/js/provider_contract");

function normalizeRow(raw = {}) {
  const source = normalizeProviderSource(raw.source);
  const code = String(raw.code || "").trim().toUpperCase();
  return {
    source,
    provider: source,
    provider_label: String(raw.provider_label || (source === "futu" ? "富途 Futu" : "永豐 Shioaji")),
    code,
    display_code: String(raw.display_code || (code.includes(".") ? code.split(".", 2)[1] : code)).trim(),
    name: String(raw.name || code).trim(),
    market: String(raw.market || "").trim().toLowerCase(),
    type: String(raw.type || raw.security_type || "").trim().toLowerCase(),
    industry_code: String(raw.industry_code || "").trim(),
    industry_name: String(raw.industry_name || raw.industry || "").trim(),
    exchange_type: String(raw.exchange_type || "").trim(),
    lot_size: raw.lot_size == null ? "" : String(raw.lot_size),
    listing_date: String(raw.listing_date || "").trim(),
    stock_id: raw.stock_id == null ? "" : String(raw.stock_id),
  };
}

function rankRows(rows, { source, query = "", market = "", limit = 50 } = {}) {
  const wantedSource = normalizeProviderSource(source);
  const keyword = String(query || "").trim().toLowerCase();
  const wantedMarket = String(market || "").trim().toLowerCase();
  const maximum = Math.max(1, Math.min(200, Number(limit) || 50));
  const ranked = [];
  for (const row of rows) {
    if (row.source !== wantedSource) continue;
    if (wantedMarket && wantedMarket !== "all" && wantedMarket !== "*" && row.market !== wantedMarket) continue;
    const code = row.code.toLowerCase();
    const display = row.display_code.toLowerCase();
    const name = row.name.toLowerCase();
    let score = 99;
    let pos = 999;
    if (!keyword) { score = 8; pos = 0; }
    else if (keyword === code || keyword === display) { score = 0; pos = 0; }
    else if (display.startsWith(keyword) || code.startsWith(keyword)) { score = 1; pos = 0; }
    else if (display.includes(keyword)) { score = 2; pos = display.indexOf(keyword); }
    else if (code.includes(keyword)) { score = 2; pos = code.indexOf(keyword); }
    else if (name === keyword) { score = 3; pos = 0; }
    else if (name.startsWith(keyword)) { score = 4; pos = 0; }
    else if (name.includes(keyword)) { score = 5; pos = name.indexOf(keyword); }
    else continue;
    const typeRank = ["stock", "etf", "etn", "reit", "crypto"].includes(row.type) ? 0 : 1;
    ranked.push({ score, pos, typeRank, row });
  }
  ranked.sort((a, b) => a.score - b.score || a.pos - b.pos || a.typeRank - b.typeRank || a.row.code.localeCompare(b.row.code));
  return ranked.slice(0, maximum).map(({ row }) => ({ ...row }));
}

// Lines of one SSE block -> its decoded data, or null for a heartbeat comment.
function sseData(block) {
  const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  return data ? JSON.parse(data) : null;
}

// What a product page shows of a product besides its code (service/market/projection/product_catalog_service.py
// METADATA_FIELDS): read from this copy where pages are shown, never kept with the pages.
const METADATA_FIELDS = ["name", "industry_name", "market", "type"];
const keyOf = (source, code) => `${normalizeProviderSource(source)}:${String(code || "").trim().toUpperCase()}`;

const FOLLOW_SILENCE_MS = 60000;   // app_api sends a heartbeat every 20 s; three missed is a dead stream

function createProductCatalogStore({
  urlFor,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  isClosing = () => false,
  remediation = () => null,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRevision = () => {},   // (revision): this copy now holds another catalog revision -- the renderers are told
} = {}) {
  let rows = [];
  let index = new Map();
  // How many products each source lists in this copy: a search that finds nothing over a source that lists nothing
  // (its master never fetched -- Futu before OpenD first connected) says so, instead of "no match".
  let listedBySource = new Map();
  let status = { count: 0, loaded: false, last_error: null };
  let loadPromise = null;
  let stopFollowing = null;

  async function requestJson(pathname, { method = "GET", timeoutMs = 5000 } = {}) {
    return withTimeout(Math.max(100, Number(timeoutMs) || 5000), async (signal) => {
      const response = await fetchImpl(urlFor(pathname), { method, cache: "no-store", signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
  }

  async function bootstrap({ timeoutMs = 8000 } = {}) {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const payload = await requestJson("/api/product-catalog/bootstrap", { timeoutMs });
      // A catalog whose source masters are simply not on disk is DEGRADED, not broken. That is
      // the normal state of a fresh install, and the product list
      // does not read this catalog at all -- it reads watch_pages.csv. As a hard failure it would
      // take a required startup step down and leave the whole page empty.
      // Search over an empty catalog returns nothing; that is the correct degraded behaviour.
      const missingSources = Array.isArray(payload?.status?.missing_sources)
        ? payload.status.missing_sources
        : [];
      const degradedOnly = missingSources.length > 0
        && String(payload?.status?.last_error || "").startsWith("PRODUCT_CATALOG_SOURCES_MISSING");
      if (!degradedOnly && (payload?.ok === false || payload?.status?.last_error)) {
        throw new Error(payload?.error || payload?.status?.last_error || "本地 Product Catalog 載入失敗");
      }
      const nextRows = (Array.isArray(payload?.items) ? payload.items : []).map(normalizeRow).filter((row) => row.code);
      const previousRevision = status.revision;
      rows = nextRows;
      index = new Map(nextRows.map((row) => [keyOf(row.source, row.code), row]));
      listedBySource = nextRows.reduce((counts, row) => counts.set(row.source, (counts.get(row.source) || 0) + 1), new Map());
      status = { ...(payload?.status || {}), count: nextRows.length, loaded: true, last_error: payload?.status?.last_error || null };
      if (status.revision !== previousRevision) {
        try { onRevision(status.revision ?? null); } catch (error) { logger.warn?.(`[PRODUCT CATALOG] telling the windows of revision ${status.revision} failed: ${error?.message || error}`); }
      }
      if (!stopFollowing) stopFollowing = follow();
      return snapshot();
    })().catch((error) => {
      status = { ...status, loaded: rows.length > 0, last_error: String(error?.message || error) };
      logger.warn?.(`[PRODUCT CATALOG] bootstrap failed: ${error?.message || error}`);
      throw error;
    }).finally(() => { loadPromise = null; });
    return loadPromise;
  }

  // This copy follows the catalog: app_api's /api/product-catalog/events says the catalog revision now and after every
  // catalog file written (a provider wrote its security master -- the 08:05 relogin's new contracts -- or a manual
  // refresh); a revision other than the loaded one is read again. Every break is logged and the stream opened again
  // with backoff; the App closing ends it. A break is a remediation (ui.catalog_stream_reconnect): one operation from
  // the break until the stream answers again, with the attempts made.
  //
  // A read of a new revision that fails breaks the stream the same way: the heartbeat never repeats the revision, so
  // reading on would leave this copy at the old revision until the next catalog change. The reconnect's first message
  // is the revision now, which is read again; that operation (trigger reload_failed) ends once the copy holds the
  // announced revision, not when the stream merely answers.
  function follow() {
    let stopped = false;
    let controller = null;
    let recovery = null;
    let recoveryKind = null;   // "stream": ends when the stream answers; "reload": ends when the revision is loaded
    let attempts = 0;
    const endRecovery = (outcome, detail) => {
      if (!recovery) return;
      try { recovery.finish(outcome, { attempt: attempts, detail }); } catch (error) { logger.warn?.(`[PRODUCT CATALOG] remediation record failed: ${error?.message || error}`); }
      recovery = null;
      recoveryKind = null;
      attempts = 0;
    };
    (async () => {
      let backoff = 1000;
      while (!stopped && !isClosing()) {
        controller = new AbortController();
        let silence = null;
        let silent = false;
        const arm = () => { clearTimeout(silence); silence = setTimeout(() => { silent = true; controller.abort(); }, FOLLOW_SILENCE_MS); };
        if (recovery) attempts += 1;
        let refused = false;
        let reloadFailed = null;
        try {
          arm();
          const response = await fetchImpl(urlFor("/api/product-catalog/events"), {
            signal: controller.signal, cache: "no-store", headers: { Accept: "text/event-stream" } });
          if (!response.ok || !response.body) {
            refused = true;
            throw new Error(`HTTP ${response.status}`);
          }
          if (recoveryKind === "stream") endRecovery("succeeded", { status: response.status });
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) throw new Error("app_api ended the stream");
            arm();
            backoff = 1000;
            buffer += decoder.decode(value, { stream: true });
            for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
              const change = sseData(buffer.slice(0, end));
              buffer = buffer.slice(end + 2);
              if (change?.revision == null) continue;
              // A load already running may predate this change: it finishes first, then the catalog is read again.
              if (change.revision !== status.revision && loadPromise) {
                await loadPromise.catch(() => { /* not an error: bootstrap() logged its own failure; read again below */ });
              }
              if (change.revision !== status.revision) {
                try {
                  await bootstrap();
                } catch (error) {
                  reloadFailed = change.revision;
                  throw new Error(`reading revision ${change.revision} failed: ${error?.message || error}`);
                }
              }
              if (recoveryKind === "reload") endRecovery("succeeded", { revision: status.revision });
            }
          }
        } catch (error) {
          if (stopped || isClosing()) break;   // not an error: the stream ends because the store stops or the App closes
          logger.warn?.(`[PRODUCT CATALOG] change stream interrupted: ${error?.message || error}; connecting again in ${backoff} ms`);
          if (!recovery) {
            const ended = String(error?.message || "") === "app_api ended the stream";
            const triggerReason = reloadFailed != null ? "reload_failed" : silent ? "stream_silent" : refused ? "stream_refused"
              : ended ? "stream_ended" : "stream_failed";
            const reload = reloadFailed != null ? { revision: reloadFailed, loaded_revision: status.revision ?? null } : {};
            try {
              recovery = remediation()?.begin({ component: "product_catalog_store", mechanismId: "ui.catalog_stream_reconnect",
                triggerReason, identity: {}, detail: { error: String(error?.message || error).slice(0, 300), ...reload } }) || null;
              recoveryKind = reloadFailed != null ? "reload" : "stream";
            } catch (recordError) { logger.warn?.(`[PRODUCT CATALOG] remediation record failed: ${recordError?.message || recordError}`); }
          }
        } finally {
          clearTimeout(silence);
        }
        await wait(backoff);
        backoff = Math.min(30000, backoff * 2);
      }
      endRecovery("abandoned", { reason: "the App closed first" });
    })();
    return () => { stopped = true; controller?.abort(); };
  }

  function search({ source, query, market = "", limit = 50 } = {}) {
    const items = rankRows(rows, { source, query, market, limit });
    const wanted = normalizeProviderSource(source);
    return { ok: true, items, count: items.length, source: wanted, listed: listedBySource.get(wanted) || 0,
      market: String(market || "").toLowerCase(), catalog: { ...status } };
  }

  /** A product's name, industry, market and type as this copy lists them; empty for one it does not list. */
  function metadata(source, code) {
    const row = index.get(keyOf(source, code)) || {};
    return Object.fromEntries(METADATA_FIELDS.map((name) => [name, String(row[name] || "")]));
  }

  /** Product pages with each item's metadata read from the catalog now, and the revision it was read at. */
  function withMetadata(pages) {
    return {
      revision: status.revision ?? null,
      pages: pages.map((page) => ({ ...page, items: page.items.map((item) => ({ ...item, ...metadata(item.source || page.source, item.code) })) })),
    };
  }

  /** The renderer's one name source (instrument_names.js): these codes' catalog names at this copy's revision; a
   *  code the catalog does not list answers an empty name. */
  function names(source, codes) {
    const wanted = normalizeProviderSource(source);
    const items = [...new Set((Array.isArray(codes) ? codes : []).map((code) => String(code || "").trim().toUpperCase()).filter(Boolean))]
      .map((code) => ({ source: wanted, code, name: String(index.get(keyOf(wanted, code))?.name || "") }));
    return { ok: true, revision: status.revision ?? null, items };
  }

  function snapshot() {
    return { ok: !status.last_error, items: rows.map((row) => ({ ...row })), count: rows.length, status: { ...status } };
  }

  return { bootstrap, search, snapshot, metadata, withMetadata, names, stop: () => stopFollowing?.() };
}

module.exports = { createProductCatalogStore, normalizeRow, rankRows };
