// The unsaved state of a subscriptions screen (設定 → 訂閱管理 and the 商品頁設定 window): the snapshot settings_api
// answered (GET /api/subscriptions, `base`) and this window's own changes over it -- the product pages as edited, and
// per instrument only the switches it changed. Saving sends just those changes (POST /api/subscriptions/ops), which
// the server applies to the list as it is then; when another window saved, `rebase` lays the same changes over the new
// snapshot so the screen shows both. Every row, quota and sector list is the server's (a snapshot or a preview), never
// derived here.

import { normalizePages } from "../watch_pages/watch_page_draft.js";
import { applyPageOps, draftOps } from "../watch_pages/watch_page_ops.js";

export const keyOf = (source, market, code) => `${source}:${market}:${code}`;
export const rowKey = (row) => keyOf(row.source, row.market, row.code);

const LANES = ["trade", "orderbook"];

/** A row's futures setting as the server answered it: a stock's 個股期貨, or an index future's months (always on;
 *  its 明細／五檔 are the row's own lanes). */
function rowFutures(row) {
  if (row?.futures) return row.futures;
  return row?.index_futures ? { on: true, trade: row.trade, orderbook: row.orderbook, ...row.index_futures } : null;
}

/** The futures setting with its chosen months as a Set (and, from a row, its category and the months listed). */
function futuresOf(raw) {
  return raw ? { ...raw, on: Boolean(raw.on), trade: Boolean(raw.trade), orderbook: Boolean(raw.orderbook), months: new Set(raw.months || []) } : null;
}

export function createDraft(snapshot) {
  return { base: snapshot, view: snapshot, pages: normalizePages(snapshot.pages), edits: new Map(), context: null, sector: null };
}

/** The rows to draw: the latest view's (a preview after a change, else the snapshot). */
export function rows(draft, source = null) {
  return (draft.view.instruments || []).filter((row) => !source || row.source === source);
}

/** One instrument's switches as this window has them: its own changes over the row the server answered. */
export function laneOf(draft, row) {
  const edit = draft.edits.get(rowKey(row)) || {};
  const futures = futuresOf(rowFutures(row));
  if (futures && edit.futures) Object.assign(futures, edit.futures, { months: new Set(edit.futures.months || futures.months) });
  return { trade: edit.trade ?? row.trade, orderbook: edit.orderbook ?? row.orderbook, futures, locked: Boolean(row.locked) };
}

function editOf(draft, row) {
  const key = rowKey(row);
  if (!draft.edits.has(key)) draft.edits.set(key, { source: row.source, market: row.market, code: row.code });
  return draft.edits.get(key);
}

/** 明細 (trade) / 五檔 (orderbook) of one instrument. */
export function setLane(draft, row, field, value) {
  editOf(draft, row)[field] = Boolean(value);
}

/** A stock's 期貨 (field "on") and its 明細／五檔 ("trade" / "orderbook"). */
export function setFutures(draft, row, field, value) {
  const edit = editOf(draft, row);
  const current = laneOf(draft, row).futures;
  edit.futures = { ...(edit.futures || {}), months: edit.futures?.months || new Set(current?.months || []), [field]: Boolean(value) };
}

/** A futures month beside the near month (the near month is always on). */
export function toggleMonth(draft, row, month) {
  const edit = editOf(draft, row);
  const months = new Set(laneOf(draft, row).futures?.months || []);
  if (months.has(month)) months.delete(month); else months.add(month);
  edit.futures = { ...(edit.futures || {}), months };
}

/** 大盤: 加權指數 and 台指期 (TXFR1's Quote) as this window has them. */
export function contextOf(draft) {
  const prefs = draft.base.preferences;
  return { taiex: draft.context?.taiex ?? prefs.taiex, txf: draft.context?.txf ?? prefs.txf };
}

export function setContext(draft, field, value) {
  draft.context ||= {};
  draft.context[field] = Boolean(value);
}

export function sectorOf(draft) {
  return draft.sector || draft.base.preferences.sector;
}

export function setSector(draft, sector) {
  draft.sector = { enabled: Boolean(sector.enabled), scope: sector.scope };
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function monthOps(code, before, after) {
  return [...new Set([...before, ...after])].sort()
    .filter((m) => before.has(m) !== after.has(m))
    .map((month) => ({ op: "instrument.month", code, month, on: after.has(month) }));
}

/** Everything this window changed, as operations: the pages' first, then the switches. */
export function draftOpsOf(draft) {
  const ops = draftOps(normalizePages(draft.base.pages), draft.pages);
  const baseRows = new Map((draft.base.instruments || []).map((row) => [rowKey(row), row]));
  for (const edit of draft.edits.values()) {
    const before = baseRows.get(keyOf(edit.source, edit.market, edit.code));
    const id = { source: edit.source, market: edit.market, code: edit.code };
    for (const field of LANES) {
      if (edit[field] !== undefined && edit[field] !== before?.[field]) ops.push({ op: "instrument.set", ...id, field, value: edit[field] });
    }
    if (edit.futures) {
      const was = futuresOf(rowFutures(before)) || { on: false, trade: true, orderbook: true, months: new Set() };
      for (const [field, name] of [["on", "futures"], ["trade", "futures_trade"], ["orderbook", "futures_orderbook"]]) {
        if (edit.futures[field] !== undefined && edit.futures[field] !== was[field]) ops.push({ op: "instrument.set", ...id, field: name, value: edit.futures[field] });
      }
      if (edit.futures.months) ops.push(...monthOps(edit.code, was.months, edit.futures.months));
    }
  }
  const prefs = draft.base.preferences;
  const context = contextOf(draft);
  for (const field of ["taiex", "txf"]) {
    if (context[field] !== prefs[field]) ops.push({ op: "context.set", field, value: context[field] });
  }
  const sector = sectorOf(draft);
  if (sector.enabled !== prefs.sector.enabled || sector.scope !== prefs.sector.scope) ops.push({ op: "sector.set", ...sector });
  return ops;
}

export function changed(draft) {
  return draftOpsOf(draft).length > 0;
}

/** Another window saved (or this one did): the same changes laid over the new snapshot; a change the snapshot now
 *  already has is dropped. */
export function rebase(draft, snapshot) {
  const drafted = new Map(draft.pages.flatMap((page) => page.items.map((item) => [`${page.id}:${item.code}`, item])));
  const shown = (pageId, code) => {
    const { name = "", industry_name = "", market = "", type = "" } = drafted.get(`${pageId}:${code}`) || {};
    return { name, industry_name, market, type };
  };
  const pages = normalizePages(applyPageOps(snapshot.pages, draftOps(normalizePages(draft.base.pages), draft.pages), shown));
  const next = { ...draft, base: snapshot, view: snapshot, pages };
  const rowsNow = new Map((snapshot.instruments || []).map((row) => [rowKey(row), row]));
  next.edits = new Map();
  for (const [key, edit] of draft.edits) {
    const row = rowsNow.get(key);
    const kept = { ...edit };
    for (const field of LANES) if (row && kept[field] === row[field]) delete kept[field];
    if (kept.futures && rowFutures(row)) {
      const was = futuresOf(rowFutures(row));
      const futures = { ...kept.futures };
      for (const field of ["on", "trade", "orderbook"]) if (futures[field] === was[field]) delete futures[field];
      if (futures.months && sameSet(futures.months, was.months)) delete futures.months;
      if (Object.keys(futures).length) kept.futures = futures; else delete kept.futures;
    }
    if (LANES.some((f) => f in kept) || kept.futures) next.edits.set(key, kept);
  }
  return next;
}
