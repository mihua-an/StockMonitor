import assert from "node:assert/strict";
import fs from "node:fs";

// RealtimeViewStore is the ONLY snapshot/sequence/gap/resync coordinator.
// The Futu renderer store is a thin adapter: no daemon REST live bootstrap,
// no delta/cursor polling, no second resync trigger.
const store = fs.readFileSync(new URL("../ui/renderer/js/features/realtime/moomoo_quote_store.js", import.meta.url), "utf8");
for (const forbidden of [/products\/bootstrap/, /products\/delta/, /focused\/\$\{/, /quote-history/, /resync_required/, /after_version/, /productVersion/, /deltaLoading/, /reset_required/]) {
  assert.doesNotMatch(store, forbidden, `moomoo_quote_store must not carry ${forbidden}`);
}
assert.doesNotMatch(store, /live_expected/, "no quiet-view supervision flag: a quiet product is not a broken view (S2c-01)");
assert.match(store, /subscribeRealtimeView\(/, "Futu live data must come from RealtimeViewStore");
assert.ok(!fs.existsSync(new URL("../ui/renderer/js/features/realtime/moomoo_focused_store.js", import.meta.url)),
  "the REST-bootstrapped focused store (second coordinator) must not exist");
assert.ok(!fs.existsSync(new URL("../ui/renderer/js/features/workspace/workspace_futu_column.js", import.meta.url)),
  "the REST-polling workspace column (second coordinator) must not exist");
console.log("Futu single-coordinator (RealtimeViewStore) contract passed");
