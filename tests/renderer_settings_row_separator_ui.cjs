// The line between settings-style rows (settings.css .settings-item, job-status.css .job-stats) in a real Chromium
// (run with Electron): a row's own background -- hover, selection, a sub-row -- reaches the card's left edge, and the
// line above it still starts 16 px in (使用者 11-02: 每日明細's hovered trade row missed a strip on its left; a
// card-coloured inset shadow that hid the line's first 16 px covered the row's whole left 16 px).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-settings-row-separator-ui-"));
app.on("window-all-closed", () => {});

function scenario() {
  const main = document.querySelector("main") || document.body;
  main.innerHTML = `<div style="width:400px;padding:20px">
    <div class="settings-group" id="list">
      <div class="settings-item">第一列</div>
      <div class="settings-item is-selected" id="picked">第二列</div>
      <div class="settings-item-sub" id="sub">子列</div>
      <div class="settings-item">第四列</div>
    </div>
    <div class="job-stats" id="stats" style="margin-top:20px;background:var(--slate-900)"><div class="settings-item"><small>進度</small><b>1%</b></div><div class="settings-item"><small>時間</small><b>1 秒</b></div></div>
  </div>`;
  const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, top: r.top, height: r.height }; };
  const second = document.querySelector("#stats > div:nth-child(2)").getBoundingClientRect();
  return { picked: box("picked"), sub: box("sub"), stat: { left: second.left, top: second.top, height: second.height } };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { sandbox: false, offscreen: true } });
  const fail = (message) => { console.error(`settings row separator ui contract FAILED: ${message}`); app.exit(1); };
  try {
    await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
    const at = await win.webContents.executeJavaScript(`(${scenario.toString()})()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const image = await win.webContents.capturePage();
    const scale = image.getSize().width / 600;
    const bitmap = image.toBitmap();
    const width = image.getSize().width;
    const pixel = (x, y) => {
      const i = (Math.round(y * scale) * width + Math.round(x * scale)) * 4;
      return [bitmap[i + 2], bitmap[i + 1], bitmap[i]].join(",");   // BGRA
    };
    const middle = (b) => b.top + b.height / 2;
    // A selected row and a sub-row: the same colour 4 px from the card's left edge as 60 px in.
    for (const [name, b] of [["a selected row", at.picked], ["a sub-row", at.sub]]) {
      const edge = pixel(b.left + 4, middle(b)), inside = pixel(b.left + 60, middle(b));
      if (edge !== inside) return fail(`${name}'s background reaches the left edge: ${edge} at 4 px vs ${inside} at 60 px`);
    }
    // The line above the selected row: present 60 px in, absent in the first 16 px (there it is the row's colour).
    const lineIn = pixel(at.picked.left + 60, at.picked.top), rowIn = pixel(at.picked.left + 60, middle(at.picked));
    if (lineIn === rowIn) return fail("the line above a row is drawn after its 16 px inset");
    const lineEdge = pixel(at.picked.left + 4, at.picked.top), rowEdge = pixel(at.picked.left + 4, middle(at.picked));
    if (lineEdge !== rowEdge) return fail(`the line starts after the inset, not at the edge: ${lineEdge} vs ${rowEdge}`);
    // 收盤整理 / 訓練狀態's figures: the same line, after the inset.
    const statLine = pixel(at.stat.left + 60, at.stat.top), statRow = pixel(at.stat.left + 60, middle(at.stat));
    if (statLine === statRow) return fail("the line above a job figure is drawn");
    console.log("settings row separator ui contract passed");
    app.exit(0);
  } catch (error) {
    fail(error?.stack || error);
  }
});
