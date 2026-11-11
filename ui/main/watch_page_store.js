const fs = require("fs");
const path = require("path");
const { normalizeProviderSource } = require("../../config/js/provider_contract");
const { resolveVarPaths } = require("../../config/js/var_paths");

// RFC 4180 CSV, strictly: a quote opens a field only at its start, a closing quote is followed by a separator or the
// line end, a quoted field is closed before the file ends, and every non-blank row has as many cells as the header.
// Any violation throws with its line number: a damaged file read as a partial one would answer ok and be overwritten
// by the editor's next save. Blank lines are skipped.
function parseCsvText(text, label = "CSV") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closed = false;
  let line = 1;
  const fail = (why) => { throw new Error(`${label} \u683C\u5F0F\u932F\u8AA4\uFF08\u7B2C ${line} \u884C\uFF09\uFF1A${why}`); };
  const endRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === "" && !closed)) {
      if (rows.length && row.length !== rows[0].length) fail(`\u6709 ${row.length} \u6B04\uFF0C\u8868\u982D\u662F ${rows[0].length} \u6B04`);
      rows.push(row);
    }
    row = [];
    field = "";
    closed = false;
  };
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (ch === "\n" || (ch === "\r" && source[i + 1] === "\n")) {
      if (ch === "\r") i += 1;
      endRow();
      line += 1;
    } else if (closed) {
      fail("\u5F15\u865F\u6B04\u4F4D\u7D50\u675F\u5F8C\u9084\u6709\u5B57\u5143");
    } else if (ch === '"') {
      if (field) fail("\u6B04\u4F4D\u4E2D\u9593\u51FA\u73FE\u5F15\u865F");
      quoted = true;
    } else if (ch === "\r") {
      fail("\u55AE\u7368\u7684 CR \u5B57\u5143");
    } else field += ch;
  }
  if (quoted) fail("\u5F15\u865F\u6B04\u4F4D\u6C92\u6709\u7D50\u675F");
  if (field || row.length || closed) endRow();
  return rows;
}

function normalizeAlertValue(value, label, code) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return "";
  if (!Number.isFinite(Number(text))) {
    throw new Error(`${code || "商品"} 的${label}不是有效數字，請修正後再儲存`);
  }
  return text;
}

function normalizeWatchItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = String(raw.code || "").trim().toUpperCase();
  if (!code) return null;
  return {
    code,
    source: normalizeProviderSource(raw.source),
    lower_alert: normalizeAlertValue(raw.lower_alert, "低價提醒", code),
    upper_alert: normalizeAlertValue(raw.upper_alert, "高價提醒", code),
  };
}

function normalizeWatchPages(rawPages) {
  const pages = Array.isArray(rawPages) ? rawPages : [];
  const used = new Set();
  return pages.map((page, index) => {
    let id = String(page?.id || "").trim();
    if (!id || used.has(id)) id = `page_${Date.now().toString(36)}_${index}`;
    used.add(id);
    const name = String(page?.name || `自選${index + 1}`).trim() || `自選${index + 1}`;
    const source = normalizeProviderSource(page?.source);
    const market = source === "futu" ? "us" : "tw";
    const seen = new Set();
    const items = [];
    for (const raw of Array.isArray(page?.items) ? page.items : []) {
      const item = normalizeWatchItem(raw);
      if (!item || seen.has(item.code)) continue;
      seen.add(item.code);
      items.push(item);
    }
    const codes = items.map((item) => item.code);
    return { id, name, source, market, codes, items, count: codes.length };
  });
}

const WATCH_PAGE_REQUIRED_COLUMNS = ["page_id", "page_name", "code"];

// watch_pages.csv holds the user's data only (service/market/reference/watch_page_service.py): pages, their products'
// source and code, the order and the alerts. A product's name, industry, market and type are the product catalog's
// (`catalog`, product_catalog_store.js), joined on every read with the revision they were read at; the name/type
// columns a file written before still has are not read.
function createWatchPageStore(projectRoot, { catalog }) {
  const dataRoot = resolveVarPaths({ projectRoot, env: process.env }).data;   // single layout authority (config/var_layout.json)
  const watchPagesCsvPath = path.join(dataRoot, "preferences", "watch_pages.csv");

  function described(pages) {
    const { revision, pages: withMetadata } = catalog.withMetadata(pages);
    return { ok: true, pages: withMetadata, count: withMetadata.length, catalog_revision: revision, storage: watchPagesCsvPath };
  }

  function load() {
    try {
      if (!fs.existsSync(watchPagesCsvPath)) return described([]);
      const rows = parseCsvText(fs.readFileSync(watchPagesCsvPath, "utf8"), "watch_pages.csv");
      if (!rows.length) return described([]);
      const header = rows[0].map((x) => String(x || "").trim());
      const idx = Object.fromEntries(header.map((name, i) => [name, i]));
      // A file without the key columns is damaged, not empty: answering ok with no pages let the editor's next
      // save overwrite it.
      const missing = WATCH_PAGE_REQUIRED_COLUMNS.filter((name) => !(name in idx));
      if (missing.length) throw new Error(`watch_pages.csv 格式錯誤：缺少欄位 ${missing.join(", ")}`);
      const grouped = new Map();
      for (const [rowIndex, cells] of rows.slice(1).entries()) {
        const pageId = String(cells[idx.page_id] || "").trim();
        if (!pageId) throw new Error(`watch_pages.csv 格式錯誤：第 ${rowIndex + 2} 列沒有 page_id`);
        const pageOrder = Number.parseInt(cells[idx.page_order], 10);
        const codeOrder = Number.parseInt(cells[idx.code_order], 10);
        if (!grouped.has(pageId)) {
          grouped.set(pageId, {
            id: pageId,
            name: String(cells[idx.page_name] || "").trim() || "自選",
            source: normalizeProviderSource(cells[idx.page_source]),
            market: normalizeProviderSource(cells[idx.page_source]) === "futu" ? "us" : "tw",
            order: Number.isFinite(pageOrder) ? pageOrder : grouped.size,
            items: [],
          });
        }
        const page = grouped.get(pageId);
        const code = String(cells[idx.code] || "").trim().toUpperCase();
        if (!code) continue;
        page.items.push({
          order: Number.isFinite(codeOrder) ? codeOrder : page.items.length,
          code,
          source: normalizeProviderSource(cells[idx.source] || page.source),
          lower_alert: String(cells[idx.lower_alert] || "").trim(),
          upper_alert: String(cells[idx.upper_alert] || "").trim(),
        });
      }
      const pages = [...grouped.values()]
        .sort((a, b) => a.order - b.order)
        .map((page) => ({
          id: page.id,
          name: page.name,
          source: page.source,
          market: page.market,
          items: page.items.sort((a, b) => a.order - b.order).map(({ order, ...item }) => item),
        }));
      return described(normalizeWatchPages(pages));
    } catch (error) {
      console.error(`[WATCH PAGES reading ${watchPagesCsvPath}] failed`, error);
      return { ok: false, pages: [], count: 0, storage: watchPagesCsvPath, error: error.message || String(error) };
    }
  }

  return { load };
}

module.exports = { createWatchPageStore };
