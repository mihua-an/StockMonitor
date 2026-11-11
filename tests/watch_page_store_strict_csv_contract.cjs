"use strict";
// A watch_pages.csv with an unclosed quote, a stray quote, a row of the wrong width or a row without page_id is damage:
// load() answers ok:false. Before, the lenient parser read it as a partial set of pages with ok:true and the editor's
// next save overwrote it without a copy. The file is written by settings_api (WatchPageService, Python): what it
// writes, this reader reads back unchanged.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWatchPageStore } = require("../ui/main/watch_page_store");

// A file written before the name/type columns were dropped: still read (those columns are not).
const HEADER = "page_id,page_name,page_source,page_order,code,code_order,code_name,industry_name,market,security_type,source,lower_alert,upper_alert";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-pages-strict-"));
const previous = process.env.STOCK_MONITOR_DATA_ROOT;
process.env.STOCK_MONITOR_DATA_ROOT = root;
try {
  const store = createWatchPageStore(root, { catalog: { withMetadata: (pages) => ({ revision: null, pages }) } });
  const csvPath = path.join(root, "preferences", "watch_pages.csv");
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  const write = (body) => fs.writeFileSync(csvPath, `﻿${HEADER}\r\n${body}`, "utf8");

  for (const [body, why] of [
    ['a,"自選,shioaji,0,2330,0,台積電,,tw,stock,shioaji,,\r\n', /引號欄位沒有結束/],
    ['a,自"選,shioaji,0,2330,0,台積電,,tw,stock,shioaji,,\r\n', /欄位中間出現引號/],
    ['a,"自選"x,shioaji,0,2330,0,台積電,,tw,stock,shioaji,,\r\n', /引號欄位結束後還有字元/],
    ["a,自選,shioaji,0,2330,0,台積電\r\n", /有 7 欄，表頭是 13 欄/],
    [",自選,shioaji,0,2330,0,台積電,,tw,stock,shioaji,,\r\n", /沒有 page_id/],
  ]) {
    write(body);
    const loaded = store.load();
    assert.equal(loaded.ok, false, `${JSON.stringify(body)} is damage`);
    assert.match(loaded.error, why);
  }

  // Well-formed files still load: quoted separators, escaped quotes, a quoted line break, LF-only lines, blank lines.
  write('a,"自選, ""一""",shioaji,0,2330,0,"台積\n電",,tw,stock,shioaji,,\n\r\nb,美股,futu,1,AAPL,0,Apple,,us,stock,futu,,\r\n');
  const loaded = store.load();
  assert.equal(loaded.ok, true, loaded.error);
  assert.deepEqual(loaded.pages.map((page) => [page.id, page.name, page.items[0].code, page.items[0].name]),
    [["a", '自選, "一"', "2330", undefined], ["b", "美股", "AAPL", undefined]]);
  // What settings_api's writer writes, load reads back unchanged.
  const { pythonExe } = require("./support/native_binaries.cjs");
  const projectRoot = path.resolve(__dirname, "..");
  const script = "import json,sys; sys.path.insert(0, sys.argv[1]); from service.market.reference.watch_page_service import WatchPageService;"
    + " WatchPageService(sys.argv[2]).save_pages(json.loads(sys.stdin.buffer.read().decode(\"utf-8\")))";
  const written = require("node:child_process").spawnSync(pythonExe(), ["-c", script, projectRoot, csvPath],
    { cwd: projectRoot, input: JSON.stringify(loaded.pages), encoding: "utf8" });
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(store.load().pages, loaded.pages);
} finally {
  if (previous === undefined) delete process.env.STOCK_MONITOR_DATA_ROOT; else process.env.STOCK_MONITOR_DATA_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("watch page store strict csv contract passed");
