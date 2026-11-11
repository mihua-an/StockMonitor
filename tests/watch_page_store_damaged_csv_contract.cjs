const { makeTempDir } = require("./support/temp_dirs.cjs");
// A watch_pages.csv without its key columns loaded as ok:true with no pages, so the product list
// looked empty without a word and the editor's next save overwrote the file. The store only reads now
// (settings_api writes the pages, refusing to while the file cannot be read: tests/test_subscription_ops.py).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWatchPageStore } = require('../ui/main/watch_page_store');

const root = makeTempDir('watch-pages-damaged-');
const previous = process.env.STOCK_MONITOR_DATA_ROOT;
process.env.STOCK_MONITOR_DATA_ROOT = root;
try {
  const store = createWatchPageStore(root, { catalog: { withMetadata: (pages) => ({ revision: null, pages }) } });
  const csvPath = path.join(root, 'preferences', 'watch_pages.csv');
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  const damaged = 'pgid,name,cd\r\na,自選,2330\r\n';
  fs.writeFileSync(csvPath, damaged, 'utf8');

  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /缺少欄位 page_id/);

} finally {
  if (previous === undefined) delete process.env.STOCK_MONITOR_DATA_ROOT; else process.env.STOCK_MONITOR_DATA_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
}

// The page keeps the read error and hands it to the product list, which says so after its tabs.
// (features/realtime/selection_controller.js loads the pages; product_pages.js holds them and the error.)
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'ui', 'renderer', 'js', 'features', 'realtime', 'selection_controller.js'), 'utf8');
assert.match(PAGE, /setWatchPages\(\[\], String\(error/);
assert.match(PAGE, /loadError: watchPagesLoadError/);
const LIST = fs.readFileSync(path.join(__dirname, '..', 'ui', 'renderer', 'js', 'features', 'realtime', 'product_list.js'), 'utf8');
assert.match(LIST, /if \(host && loadError\) \{[\s\S]*?自訂商品頁讀取失敗/);
assert.doesNotMatch(LIST, /notice\.title/, "the reason is not hidden in a hover title (user 10-20)");
console.log('watch page store damaged csv contract ok');
