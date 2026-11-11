"use strict";
// The GAS Web App (integrations/gas_web_app/*.gs) run in node against stand-ins for the Apps Script services:
// passwords, the phone's key selection, the per-date / per-weekday answers, chunked storage of large entries.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(nowIso) {
  const props = new Map([["DESKTOP_TOKEN", "desk"], ["MOBILE_TOKEN", "phone"]]);
  const lock = { held: 0, taken: 0 };
  const sheets = new Map();
  const makeSheet = (name) => {
    let cells = [];
    const sheet = {
      getName: () => name,
      getLastRow: () => cells.length,
      getLastColumn: () => (cells[0] || []).length,
      clearContents: () => { cells = []; },
      deleteRow: (r) => { cells.splice(r - 1, 1); },
      deleteRows: (r, n) => { cells.splice(r - 1, n); },
      writes: 0,
      getRange: (r, c, nr = 1, nc = 1) => ({
        setNumberFormat() { return this; },
        setValues: (values) => {
          sheet.writes += 1;
          values.forEach((row, i) => {
            const target = cells[r - 1 + i] || [];
            row.forEach((value, j) => { target[c - 1 + j] = String(value); });
            cells[r - 1 + i] = target;
          });
        },
        getValues: () => cells.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
        getDisplayValues: () => cells.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc).map((v) => v ?? "")),
      }),
    };
    sheets.set(name, sheet);
    return sheet;
  };
  const tz = (date, _zone, fmt) => {
    const local = new Date(date.getTime() + 8 * 3600 * 1000);   // Asia/Taipei, no DST
    if (fmt === "u") return String(((local.getUTCDay() + 6) % 7) + 1);
    if (fmt === "yyyy/MM/dd") return local.toISOString().slice(0, 10).replace(/-/g, "/");
    return local.toISOString();
  };
  let uuid = 0;
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { super(...(a.length ? a : [nowIso])); } static now() { return new RealDate(nowIso).getTime(); } }
  const context = {
    Date: FixedDate, JSON, Object, Number, String, Math, Set, Array,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v), setProperties: (o) => Object.entries(o).forEach(([k, v]) => props.set(k, v)) }) },
    LockService: { getScriptLock: () => ({ waitLock() { lock.held += 1; lock.taken += 1; }, releaseLock() { lock.held -= 1; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets.get(n) || null, insertSheet: makeSheet }), flush() {} },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text) => ({ setMimeType: () => ({ text }) }) },
    Utilities: { formatDate: tz, getUuid: () => `0000-${(uuid += 1)}` },
    Logger: { log() {} },
  };
  vm.createContext(context);
  for (const file of ["Router.gs", "RawTrades.gs", "Mobile.gs"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "integrations", "gas_web_app", file), "utf8"), context, { filename: file });
  }
  const post = (body) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { post, context, props, sheets, makeSheet, lock };
}

// 2026-10-07 is a Wednesday (Taipei).
const { post, context } = load("2026-10-07T04:00:00Z");
assert.match(context.doGet().text, /POST/);
assert.match(post({ action: "summary", token: "desk" }).error, /token/, "the desktop password does not read phone data");
assert.match(post({ action: "mobilePublish", token: "phone" }).error, /token/, "the phone password cannot publish");

const big = "x".repeat(95000);
const entries = {
  summary: { stockProfit: 1 },
  "rank:spot:profit": { type: "spot", side: "profit", count: 0, data: [], note: big },
  "historyTrade:2026/10/07": { date: "2026/10/07", totalSettlement: 5 },
  "historyTrade:2026/10/06": { date: "2026/10/06", totalSettlement: 6 },
  "dayTradeEntryTime:3": { weekday: 3, weekdayLabel: "週三", summary: {}, items: [1] },
  "dayTradeEntryTime:4": { weekday: 4, weekdayLabel: "週四", summary: {}, items: [2] },
  "dayTradeEntryTime:week": { weekday: "", weekdayLabel: "整週", summary: {}, items: [3] },
};
const published = post({ action: "mobilePublish", token: "desk", published_at: "2026-10-07T12:00:00+08:00", entries });
assert.equal(published.ok, true);
assert.equal(post({ action: "summary", token: "phone" }).stockProfit, 1);
assert.equal(post({ action: "summary", token: "phone" }).updateTime, "2026-10-07T12:00:00+08:00");
assert.equal(post({ action: "rank", token: "phone", type: "spot", side: "profit" }).note.length, 95000, "a large entry survives chunking");
assert.match(post({ action: "rank", token: "phone", side: "x" }).error, /side/);
assert.equal(post({ action: "historyTrade", token: "phone", day: 0 }).totalSettlement, 5);
assert.equal(post({ action: "historyTrade", token: "phone", day: 1 }).totalSettlement, 6);
const old = post({ action: "historyTrade", token: "phone", day: 3 });
assert.equal(old.date, "2026/10/02", "three weekdays back from Wednesday skips the weekend");
assert.deepEqual(old.dayTrade.items, []);
assert.deepEqual(post({ action: "dayTradeEntryTime", token: "phone", mode: "first" }).items, [1]);
assert.equal(post({ action: "dayTradeEntryTime", token: "phone", mode: "second" }).mode, "second");
assert.deepEqual(post({ action: "dayTradeEntryTime", token: "phone", mode: "second" }).items, [2]);
assert.deepEqual(post({ action: "dayTradeEntryTime", token: "phone" }).items, [3]);

// Saturday and Friday look at the right weekdays.
assert.deepEqual([...load("2026-10-10T04:00:00Z").context.mobileTargetWeekdays_()], [1, 2]);
assert.deepEqual([...load("2026-10-09T04:00:00Z").context.mobileTargetWeekdays_()], [5, 1]);

// A missing password is a setup error, never an open door.
const fresh = load("2026-10-07T04:00:00Z");
fresh.props.delete("MOBILE_TOKEN");
assert.match(fresh.post({ action: "summary", token: "" }).error, /MOBILE_TOKEN/);
// A desktop write is one command: the row (one setValues) and the revision change together under the ScriptLock, and
// the answer carries the new revision. There is no separate touch.
{
  const gas = load("2026-10-07T04:00:00Z");
  const raw = gas.makeSheet("交易明細表單");
  raw.getRange(1, 1, 1, 8).setValues([["時間戳記", "交易日期", "市場", "交易類型", "股號", "交易資訊", "交易時間", "trade_id"]]);
  raw.writes = 0;
  const bumpedUnderLock = [];
  const props = gas.context.PropertiesService.getScriptProperties();
  const setProperties = props.setProperties;
  gas.context.PropertiesService.getScriptProperties = () => ({ ...props,
    setProperties: (o) => { bumpedUnderLock.push(gas.lock.held > 0); setProperties(o); } });
  const trade = { trade_date: "2026/10/07", market: "台股", action: "買進", code: "2330", trade_info: "1@100", trade_time: "0930" };
  const created = gas.post({ action: "actualTradeCreate", token: "desk", trade });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.row, 2);
  assert.equal(created.raw_revision, 1);
  assert.equal(raw.writes, 1, "the whole row in one setValues");
  const second = gas.post({ action: "actualTradeCreate", token: "desk", trade: { ...trade, code: "2317" } });
  assert.equal(second.row, 3, "the next create takes the next row");
  assert.equal(second.raw_revision, 2);
  const updated = gas.post({ action: "actualTradeUpdate", token: "desk", trade: { ...trade, trade_id: created.trade_id, trade_info: "2@101" } });
  assert.equal(updated.raw_revision, 3);
  const rows = gas.post({ action: "actualRawTrades", token: "desk", offset: 0, limit: 500 }).items;
  assert.deepEqual(rows.map((r) => [r.code, r.action, r.trade_info, r.trade_id]),
    [["2330", "買進", "2@101", created.trade_id], ["2317", "買進", "1@100", second.trade_id]], "the trade type is the trade's, not the request's");
  const deleted = gas.post({ action: "actualTradeDelete", token: "desk", trade_id: second.trade_id });
  assert.equal(deleted.raw_revision, 4);
  assert.equal(gas.post({ action: "actualRawTrades", token: "desk", offset: 0, limit: 500 }).count, 1);
  assert.ok(bumpedUnderLock.length === 4 && bumpedUnderLock.every(Boolean), "each revision change happened inside the write's lock");
  assert.equal(gas.lock.held, 0);
  // A refused write changes neither the sheet nor the revision.
  assert.equal(gas.post({ action: "actualTradeUpdate", token: "desk", trade: { ...trade, trade_id: "TRD-missing" } }).ok, false);
  assert.equal(gas.post({ action: "actualBridgeStatus", token: "desk" }).raw_revision, 4);
  assert.match(gas.post({ action: "actualBridgeTouch", token: "desk" }).error, /不支援/, "no two-step touch");
  // The raw rows are read in pages of only the seven columns the desktop needs, each at the revision read before it;
  // a page without offset / limit, or past the page cap, is refused (R14-25: one whole-sheet read never arrived).
  for (let n = 0; n < 4; n += 1) gas.post({ action: "actualTradeCreate", token: "desk", trade: { ...trade, code: `00${n}` } });
  raw.getRange(4, 1, 1, 8).setValues([["", "", "", "", "", "", "", ""]]);   // a blank row in the middle is skipped
  const page = (offset, limit) => gas.post({ action: "actualRawTrades", token: "desk", offset, limit });
  const pages = [page(0, 2), page(2, 2), page(4, 2)];
  assert.deepEqual(pages.map((p) => p.next_offset), [2, 4, null]);
  const first = pages[0];
  assert.equal(first.total_rows, 5);
  assert.deepEqual(pages.flatMap((p) => p.items).map((r) => [r.code, r.source_order]),
    [["2330", 2], ["000", 3], ["002", 5], ["003", 6]]);
  assert.equal(first.raw_revision, 8);
  assert.equal(page(9, 2).items.length, 0);
  assert.equal(page(9, 2).next_offset, null);
  for (const bad of [{}, { offset: 0 }, { offset: -1, limit: 2 }, { offset: 0, limit: 0 }, { offset: 0, limit: 501 }]) {
    assert.match(gas.post({ action: "actualRawTrades", token: "desk", ...bad }).error, /offset/);
  }
  const columnsRead = [];
  const getRange = raw.getRange;
  raw.getRange = (r, c, nr, nc) => { if (r > 1) columnsRead.push(nc); return getRange(r, c, nr, nc); };
  page(0, 5);
  raw.getRange = getRange;
  assert.ok(columnsRead.length === 7 && columnsRead.every((n) => n === 1), `seven single-column reads: ${columnsRead}`);
  // A page is read under the writers' script lock, so its rows and revision are one state.
  const taken = gas.lock.taken;
  page(0, 2);
  assert.equal(gas.lock.taken, taken + 1);
  assert.equal(gas.lock.held, 0);
  // Inserting or deleting rows (no edit event) raises the revision; an edit or a format change through onChange does not.
  const revisionNow = () => gas.post({ action: "actualBridgeStatus", token: "desk" }).raw_revision;
  const before = revisionNow();
  gas.context.gasBridgeHandleStructureChange({ changeType: "EDIT" });
  gas.context.gasBridgeHandleStructureChange({ changeType: "FORMAT" });
  assert.equal(revisionNow(), before);
  gas.context.gasBridgeHandleStructureChange({ changeType: "REMOVE_ROW" });
  assert.equal(revisionNow(), before + 1);
}
// A publish commits by moving the generation pointer, after its rows are written and read back complete: readers
// see the previous generation until then, a publish that fails midway leaves it in place, and a generation with a
// missing part is an error, never a shortened JSON text. Older generations go once the next one is committed.
{
  const gas = load("2026-10-07T04:00:00Z");
  const publish = (summary) => gas.post({ action: "mobilePublish", token: "desk", published_at: "t", entries: { summary } });
  const read = () => gas.post({ action: "summary", token: "phone" });
  assert.match(read().error, /尚無 summary/, "nothing before the first publish");
  assert.equal(publish({ v: 1 }).generation, 1);
  assert.equal(publish({ v: 2 }).generation, 2);
  assert.equal(read().v, 2);
  const sheet = gas.sheets.get("手機資料");
  assert.deepEqual([...new Set(sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(([g]) => g))], ["1", "2"],
    "the previous generation is kept for a reader that read the pointer just before the commit");
  assert.equal(publish({ v: 3 }).generation, 3);
  assert.deepEqual([...new Set(sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(([g]) => g))], ["2", "3"]);
  // A publish whose rows cannot be written leaves the committed generation readable.
  const getRange = sheet.getRange;
  sheet.getRange = (r, c, nr, nc) => { const range = getRange(r, c, nr, nc); return { ...range, setNumberFormat() { return this; }, setValues() { throw new Error("quota"); } }; };
  assert.equal(publish({ v: 4 }).ok, false);
  sheet.getRange = getRange;
  assert.equal(read().v, 3, "still the committed generation");
  assert.equal(gas.lock.held, 0);
  // A committed generation that lost a part is an error, not a shortened text.
  const big = "y".repeat(90000);
  assert.equal(publish({ big }).generation, 4, "a failed publish does not use up a generation");
  assert.equal(read().big.length, 90000);
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), 4).getValues();
  const lost = rows.findIndex(([g, key, part]) => g === "4" && key === "summary" && part === "1");
  sheet.deleteRow(lost + 1);
  assert.match(read().error, /summary 缺少第 1 段/);
}
{
  const gas = load("2026-10-07T04:00:00Z");
  // historyTrade's day is a whole number of weekdays within the bound.
  for (const day of [1.5, -1, "x", "1e400", 261]) assert.match(gas.post({ action: "historyTrade", token: "phone", day }).error, /day 必須是/, String(day));
  assert.equal(gas.post({ action: "historyTrade", token: "phone", day: 260 }).day, 260);
}
console.log("gas web app contract passed");
