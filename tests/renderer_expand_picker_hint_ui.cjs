// The 「期」 on a product's 現 side (core/components/expand_picker.js) gives way to the months as soon as the pointer is
// on the picker, so what opens under it is what the click takes. Under the pointer must be the near month, in the table
// (opens rightwards) and on a stock card (opens leftwards): on the card it was the farthest month, FZF202709 on 11-09.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-expand-picker-hint-ui-")));
app.on("window-all-closed", () => {});

const MODES = [["table", false], ["card", true]];

async function setup(base, corner) {
  const { expandPickerHtml } = await import(`${base}js/core/components/expand_picker.js`);
  const options = [["spot", "現"], ["m0", "11"], ["m1", "12"], ["m2", "03"], ["m3", "06"], ["m4", "09"]];
  const main = document.querySelector("main");
  main.innerHTML = `<div id="owner" style="position:relative;width:300px;height:80px;margin:40px">${expandPickerHtml({ options, current: "spot", hint: ["m0", "期"], corner })}</div>`;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = main.querySelector(".is-hint").getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

async function underPointer(win, at) {
  win.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
  // Past the opening's .3 s transition.
  await new Promise((resolve) => setTimeout(resolve, 600));
  return win.webContents.executeJavaScript(`({ opened: document.querySelector(".expand-picker").matches(":hover"),
    pick: document.elementFromPoint(${at.x}, ${at.y})?.closest?.("[data-pick]")?.dataset.pick ?? null })`);
}

app.whenReady().then(async () => {
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const win = new BrowserWindow({ show: false, width: 700, height: 300, webPreferences: { sandbox: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  try {
    for (const [name, corner] of MODES) {
      const at = await win.webContents.executeJavaScript(`(${setup.toString()})(${JSON.stringify(base)}, ${corner})`);
      const seen = await underPointer(win, at);
      if (!seen.opened) throw new Error(`${name}: the pointer did not open the picker`);
      if (seen.pick !== "m0") throw new Error(`${name}: under the 「期」 opened ${seen.pick}, not the near month m0`);
      win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
    }
    console.log("expand picker hint ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("expand picker hint ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
