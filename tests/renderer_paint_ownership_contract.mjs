import fs from "node:fs";
import assert from "node:assert/strict";

// Who is allowed to claim a paint happened.
//
// This contract used to pin the metric's OWNER: the transport scheduler must not publish
// `renderer_paint`, and app.js must. Both halves existed because the transport once flushed a
// batch on requestAnimationFrame and it was tempting to time the paint from there, while the only
// honest boundary was app.js applying that batch to the visible page.
//
// The batch is gone: RealtimeViewStore applies each payload as it is parsed, so there
// is no "the complete batch has now been applied to the page" moment left to time. The sample was
// removed rather than relocated -- publishing it from some other point would report a paint
// duration measured from a boundary that is not a paint.
//
// What still has to hold is the half that was never about the batch: no module may manufacture a
// paint sample, and the transport least of all.

const realtime = fs.readFileSync("ui/renderer/js/market_data/realtime.js", "utf8");
const app = fs.readFileSync("ui/renderer/app.js", "utf8");

assert(
  !realtime.includes('reportClientMetric("renderer_paint"'),
  "the transport scheduler must not own renderer paint telemetry: it does not know whether "
  + "anything was painted, or whether the page it fed is even visible",
);

// The quoted metric name, i.e. a real emission -- prose explaining why it was removed is fine.
for (const [name, source] of [["transport", realtime], ["app", app]]) {
  assert(
    !/["']renderer_paint["']/.test(source),
    `${name} still emits renderer_paint. The batch boundary it measured no longer exists; `
    + "reintroducing the sample needs a real paint boundary to measure from, not a convenient "
    + "call site",
  );
}

// first_meaningful_render survives, and it moved to where its state is produced. It is reported
// once the monitor actually holds an applied analysis row -- previously inferred in the batch
// callback from the number of analysis rows, now reported by the path that fills it.
assert(
  realtime.includes("export function reportFirstMeaningfulRender"),
  "first_meaningful_render must still have a single owner",
);
// The analysis row's apply path (applyCanonicalSignalRow) lives in the page's view owner.
const page = fs.readFileSync("ui/renderer/js/features/realtime/canonical_view_owner.js", "utf8");
assert(
  /reportFirstMeaningfulRender\(/.test(page),
  "and it must be called from the analysis row's apply path, which is the state it measures",
);

// It claims a RENDER, so the call site has to be gated on the page being visible, the row having
// actually changed, and a frame having been painted since. Unconditional, it fired while the
// monitor was hidden and the write had touched no DOM -- "state exists" recorded as a render.
assert(
  /realtimePageVisible && dirty && dirty\.size/.test(page),
  "first_meaningful_render must be gated on a VISIBLE page and a row that actually changed",
);
assert(
  /paint\(\(\) => reportFirstMeaningfulRender/.test(page),
  "and reported at the paint boundary, not at the moment the state was written",
);

// Deduplication belongs to the reporter, so the gated call site may fire more than once safely.
const transport = realtime.slice(realtime.indexOf("export function reportFirstMeaningfulRender"));
assert(
  /if \(firstMeaningfulRenderReported\) return false;/.test(transport),
  "reportFirstMeaningfulRender must report at most once per renderer lifetime",
);

// `ui_render` had the same producer as renderer_paint and is equally gone. A diagnostics row still
// reading it would show "--" forever, or worse the last number ever recorded, and read as a
// measurement -- so the row was removed from status.js rather than left standing.
assert(
  !/ui_render/.test(realtime) && !/["']ui_render["']/.test(app),
  "nothing may emit ui_render: the batch-application boundary it timed no longer exists",
);
const status = fs.readFileSync("ui/renderer/js/core/status.js", "utf8")
  .replace(/<!--[\s\S]*?-->/g, "");   // the removal is explained in place; read the markup only
assert(
  !/ui_render/.test(status) && !/UI render p95/.test(status),
  "the UI render p95 diagnostics row must not outlive its producer",
);

console.log("renderer paint ownership contract tests passed");
