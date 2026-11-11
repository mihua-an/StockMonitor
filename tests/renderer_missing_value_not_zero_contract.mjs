import assert from "node:assert/strict";

// A missing figure (null, "", undefined) is shown as missing -- never as 0, $0, 0.00% or 0 MB.
const { createAccountReadViewPresentation } = await import("../ui/renderer/js/features/account/read_views.js");
const view = createAccountReadViewPresentation();
for (const missing of [null, "", undefined]) {
  assert.equal(view.money(missing), "--");
  assert.equal(view.price(missing), "--");
  assert.equal(view.signedMoney(missing), "--");
  assert.equal(view.qty(missing), "--");
  assert.equal(view.percent(missing), "-");
  assert.equal(view.signedPercent(missing), "-");
  assert.equal(view.ratio(missing), "-");
  assert.equal(view.metricMoney(missing), "-");
}
assert.equal(view.money(0), "0", "a real zero is still zero");
assert.equal(view.signedMoney(1200), "1,200");
// A trade price as struck: 美股 2..4 decimals, 台股 up to 2; money stays money().
assert.equal(view.price(150.5, "美股"), "150.50");
assert.equal(view.price(123.4567, "美股"), "123.4567");
assert.equal(view.price(150.5, "台股"), "150.5");
assert.equal(view.price(0, "美股"), "0.00", "a real zero price is not missing");

const { bytesText } = await import("../ui/renderer/js/core/diagnostics_format.js");
assert.equal(bytesText(null), null, "a missing size is null; the page says its blank");
assert.equal(bytesText(0), "0 B");
assert.equal(bytesText(1536), "1.5 KB", "1024 進位");
assert.equal(bytesText(2 * 1024 ** 3), "2.0 GB");
const jobView = await import("../ui/renderer/js/core/job_status_view.js");
assert.equal(jobView.int(null), "--");
assert.equal(jobView.compactCount(null), "--");
assert.equal(jobView.int(0), "0");

const { viewStateToMoomooProductFields } = await import("../ui/renderer/js/features/realtime/moomoo_view_adapter.js");
assert.equal(viewStateToMoomooProductFields({ summary: { current: 10, total_volume: null } }).volume, undefined, "no total, no volume");
assert.equal(viewStateToMoomooProductFields({ summary: { current: 10, total_volume: 0 } }).volume, 0);
console.log("renderer missing value not zero contract passed");
