"use strict";
// Electron main's product pages take a product's name, industry, market and type from the product catalog copy
// (product_catalog_store.js) on every read, with the revision they were read at; watch_pages.csv keeps only the user's
// data. Before, the CSV's own name/type columns won and the security master filled only blanks, so a product the
// master renamed kept its old name on the pages. A new catalog revision is told to every window (onRevision), and the
// renderer's name lookup (product-catalog:names) answers with that revision.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWatchPageStore } = require("../ui/main/watch_page_store");
const { createProductCatalogStore } = require("../ui/main/product_catalog_store");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-pages-catalog-"));
  const previous = process.env.STOCK_MONITOR_DATA_ROOT;
  process.env.STOCK_MONITOR_DATA_ROOT = root;
  try {
    let served = { revision: "r1", items: [
      { source: "shioaji", code: "2330", name: "台積電", industry_name: "半導體業", market: "tse", type: "stock" },
      { source: "futu", code: "US.AAPL", name: "Apple Inc", market: "us", type: "stock" },
    ] };
    const revisions = [];
    const catalog = createProductCatalogStore({
      urlFor: (pathname) => `http://catalog.test${pathname}`,
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, items: served.items, status: { revision: served.revision } }) }),
      isClosing: () => true,   // no change stream in this test: bootstrap() is called when the catalog changes
      onRevision: (revision) => revisions.push(revision),
      logger: { warn() {} },
    });
    await catalog.bootstrap();
    assert.deepEqual(revisions, ["r1"], "the windows are told the first revision");

    const csvPath = path.join(root, "preferences", "watch_pages.csv");
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    // A file written before the name/type columns were dropped, with stale names and types in them.
    fs.writeFileSync(csvPath, "﻿page_id,page_name,page_source,page_order,code,code_order,code_name,industry_name,market,security_type,source,lower_alert,upper_alert\r\n"
      + "p1,台股,shioaji,0,2330,0,台積電舊名,舊產業,otc,etf,shioaji,500,\r\n"
      + "p1,台股,shioaji,0,9999,1,自己取的名,,,,shioaji,,\r\n"
      + "p2,美股,futu,1,US.AAPL,0,Apple舊名,,us,stock,futu,,250.5\r\n", "utf8");
    const store = createWatchPageStore(root, { catalog });

    const first = store.load();
    assert.equal(first.ok, true, first.error);
    assert.equal(first.catalog_revision, "r1");
    const items = Object.fromEntries(first.pages.flatMap((page) => page.items).map((item) => [item.code, item]));
    assert.deepEqual(items["2330"], { code: "2330", source: "shioaji", lower_alert: "500", upper_alert: "",
      name: "台積電", industry_name: "半導體業", market: "tse", type: "stock" }, "the catalog's metadata, the user's alerts");
    assert.deepEqual([items["9999"].name, items["9999"].type], ["", ""], "a product the catalog does not list has no name of the CSV's");
    assert.equal(items["US.AAPL"].name, "Apple Inc");
    assert.equal(items["US.AAPL"].upper_alert, "250.5");

    // The master renamed and retyped 2330: the next read shows it, the windows are told the new revision, and the
    // renderer's name lookup answers at it.
    served = { revision: "r2", items: [{ ...served.items[0], name: "台灣積體電路", type: "etf" }, served.items[1]] };
    await catalog.bootstrap();
    assert.deepEqual(revisions, ["r1", "r2"]);
    const renamed = store.load().pages[0].items.find((item) => item.code === "2330");
    assert.deepEqual([renamed.name, renamed.type], ["台灣積體電路", "etf"]);
    assert.deepEqual(catalog.names("shioaji", ["2330", "9999", "2330"]), { ok: true, revision: "r2", items: [
      { source: "shioaji", code: "2330", name: "台灣積體電路" }, { source: "shioaji", code: "9999", name: "" }] });
    await catalog.bootstrap();
    assert.deepEqual(revisions, ["r1", "r2"], "the same revision read again tells no one");
  } finally {
    if (previous === undefined) delete process.env.STOCK_MONITOR_DATA_ROOT; else process.env.STOCK_MONITOR_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("watch page catalog metadata contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
