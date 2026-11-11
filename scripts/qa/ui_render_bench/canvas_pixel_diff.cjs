// Renders the same trend frames with the canvas engine of two checkouts and reports differing pixels:
//   electron scripts/qa/ui_render_bench/canvas_pixel_diff.cjs <treeA> <treeB>
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const [rootA, rootB] = process.argv.slice(2);
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "canvas-diff-")));

let win = null;
async function render(root) {
  if (!win) {
    win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(rootA, "tests/fixtures/renderer_ui_geometry.html"));
  }
  const engine = pathToFileURL(path.join(root, "ui/renderer/js/core/trend/canvas_engine.js")).href;
  const axis = pathToFileURL(path.join(root, "ui/renderer/js/core/trend/time_axis_policy.js")).href;
  const out = await win.webContents.executeJavaScript(`(async () => {
    const { renderTrendCanvas } = await import(${JSON.stringify(engine)});
    const axisModule = await import(${JSON.stringify(axis)});
    const results = [];
    const cases = [
      { w: 900, h: 400, n: 180, axis: axisModule.EQUITY_TIME_AXIS },
      { w: 320, h: 200, n: 270, axis: axisModule.EQUITY_TIME_AXIS },
    ];
    for (const c of cases) {
      const canvas = document.createElement("canvas");
      canvas.style.width = c.w + "px"; canvas.style.height = c.h + "px"; canvas.style.display = "block";
      document.body.appendChild(canvas);
      const points = Array.from({ length: c.n }, (_, m) => ({ minute_timestamp: "2026-10-14T" + String(9 + Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0") + ":00+08:00",
        price: 100 + Math.sin(m / 9) * 2 + (m % 7 === 0 ? 0 : 0.1), minute_volume: (m * 37) % 200 + (m % 11 === 0 ? 0 : 5), total_volume: m * 300, average_price: 100 }));
      for (let i = 0; i < 2; i++) renderTrendCanvas(canvas, points, 100, 100, { timeAxisPolicy: c.axis });
      const ctx = canvas.getContext("2d");
      results.push(Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
      canvas.remove();
    }
    return results;
  })()`);
  return out;
}

app.whenReady().then(async () => {
  try {
    const a = await render(rootA), b = await render(rootB);
    a.forEach((pixels, i) => {
      let diff = 0, max = 0;
      for (let k = 0; k < pixels.length; k++) { const d = Math.abs(pixels[k] - b[i][k]); if (d) { diff++; max = Math.max(max, d); } }
      console.log(`case ${i}: ${pixels.length / 4} px, differing channels ${diff}, max delta ${max}, sizes ${pixels.length} vs ${b[i].length}`);
    });
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
