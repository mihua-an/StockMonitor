// A candidate eliminated by the ONNX export check is listed as REJECTED with how many rows were off.
import assert from "node:assert/strict";

const { rejectedText } = await import("../ui/renderer/js/pages/training/model_center_view.js");
const text = rejectedText({ tolerance: 1e-5, rows_over: 1, rows: 49075, ratio_over: 1 / 49075 });
assert.match(text, /匯出誤差超過 1e-5：1 \/ 49075 列（0\.002%）/);
console.log("training_export_rejected_contract ok");
