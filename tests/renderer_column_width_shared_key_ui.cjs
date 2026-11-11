const { makeTempDir } = require("./support/temp_dirs.cjs");
// One column-width key, two windows of different widths (成交明細 in the main window and in a detached view share
// realtimeTickDetailsColumnWidthsV3:<list>). Each table used to save its whole set of visible widths and its own
// `available` on every drag, so the last window dragged overwrote what the other had set, and neither saw the
// other's change until it was mounted again. Checked here, in a real Chromium with real mouse drags: a drag commits
// only the columns it moved (layoutStateStore merges them, scaled to the record's width), and the other window's
// table lays out the change at once.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-column-width-shared-key-"));
app.on("window-all-closed", () => {});

const STORAGE_KEY = "realtimeTickDetailsColumnWidthsV3:shioaji";
const IDS = ["time", "price", "change", "volume", "side"];

async function mount(base, ids, storageKey, paneWidth) {
  const { applyColumnSchema, defineColumnSchema } = await import(`${base}js/core/column_title.js`);
  const host = document.getElementById("pageContainer");
  host.innerHTML = `<div class="wrap" style="position:absolute;left:0;top:0;width:${paneWidth}px;overflow:hidden"><table><thead></thead><tbody><tr>${ids.map(() => "<td>1,234</td>").join("")}</tr></tbody></table></div>`;
  const columns = defineColumnSchema(ids.map((id) => ({ id, title: id, resizable: true, minWidth: 40 })), { id: "sharedKey" });
  applyColumnSchema(host.querySelector("table"), columns, {
    schemaId: "sharedKey",
    resize: { storageKey, defaultMinWidth: 40, floorWidth: 36, fitToAvailable: true },
  });
  window.__storageKey = storageKey;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
}

function geometry() {
  const ths = [...document.querySelectorAll("thead th")];
  const boundary = (index) => {
    const rect = ths[index].querySelector(".canonical-column-boundary.is-resizable")?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(window.__storageKey) || "null"); } catch { saved = "unreadable"; }
  return {
    widths: ths.map((th) => th.getBoundingClientRect().width),
    boundaries: ths.slice(0, -1).map((_th, index) => boundary(index)),
    available: document.querySelector(".wrap").clientWidth,
    saved,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function drag(win, from, dx) {
  const send = (type, x) => win.webContents.sendInputEvent({ type, x, y: from.y, button: "left", clickCount: 1 });
  send("mouseMove", from.x);
  send("mouseDown", from.x);
  for (let step = 1; step <= 6; step += 1) { send("mouseMove", Math.round(from.x + dx * step / 6)); await new Promise((r) => setTimeout(r, 16)); }
  send("mouseUp", from.x + dx);
  await settle();
}

app.whenReady().then(async () => {
  const fixture = pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href;
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const open = async () => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 400, webPreferences: { sandbox: false } });
    await win.loadURL(fixture);
    return win;
  };
  const wide = await open();
  const narrow = await open();
  const js = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`);
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;
  try {
    await js(wide, () => localStorage.clear());
    await js(wide, mount, base, IDS, STORAGE_KEY, 1000);
    await js(narrow, mount, base, IDS, STORAGE_KEY, 600);
    const wide0 = await js(wide, geometry);
    const narrow0 = await js(narrow, geometry);

    // The wide window widens `time`.
    await drag(wide, wide0.boundaries[0], 60);
    const wide1 = await js(wide, geometry);
    check(wide1.widths[0] >= wide0.widths[0] + 55, `wide: dragging time's edge 60px right: ${wide0.widths[0]} -> ${wide1.widths[0]}`);
    check(near(wide1.saved?.columns?.time, wide1.widths[0]) && wide1.saved?.available === 1000,
      `wide: the drag is saved fitted to 1000px (${JSON.stringify(wide1.saved)})`);
    await settle();
    const narrow1 = await js(narrow, geometry);
    check(near(narrow1.widths[0], wide1.widths[0] * 0.6),
      `narrow: lays out the wide window's time at its own width (${wide1.widths[0]} * 0.6 vs ${narrow1.widths[0]})`);

    // The narrow window widens `change`: only change and the neighbour that gave the width are committed.
    await drag(narrow, narrow1.boundaries[2], 30);
    const narrow2 = await js(narrow, geometry);
    check(narrow2.widths[2] >= narrow1.widths[2] + 26, `narrow: dragging change's edge 30px right: ${narrow1.widths[2]} -> ${narrow2.widths[2]}`);
    const saved = narrow2.saved;
    check(saved?.available === 1000, `the record keeps the width it was fitted to (${JSON.stringify(saved)})`);
    check(near(saved?.columns?.time, wide1.widths[0]),
      `the narrow window's drag keeps the wide window's time (${wide1.widths[0]} vs saved ${saved?.columns?.time})`);
    check(near(saved?.columns?.change, narrow2.widths[2] / 0.6, 3),
      `the narrow window's change is saved scaled to 1000px (${narrow2.widths[2]} / 0.6 vs ${saved?.columns?.change})`);
    await settle();
    const wide2 = await js(wide, geometry);
    check(near(wide2.widths[0], wide1.widths[0]), `wide: keeps its own time (${wide1.widths[0]} -> ${wide2.widths[0]})`);
    check(near(wide2.widths[2], narrow2.widths[2] / 0.6, 3),
      `wide: lays out the narrow window's change at once (${narrow2.widths[2]} / 0.6 vs ${wide2.widths[2]})`);

    // A window mounted later restores both changes.
    await js(narrow, mount, base, IDS, STORAGE_KEY, 600);
    const narrow3 = await js(narrow, geometry);
    check(near(narrow3.widths[0], wide1.widths[0] * 0.6) && near(narrow3.widths[2], narrow2.widths[2]),
      `a remount restores both windows' changes (${narrow3.widths})`);
    if (process.env.COLUMN_WIDTH_REPORT) console.log({ wide0: wide0.widths, wide1: wide1.widths, narrow0: narrow0.widths, narrow1: narrow1.widths, narrow2: narrow2.widths, wide2: wide2.widths, saved });

    if (problems.length) throw new Error(`\n  ${problems.join("\n  ")}`);
    console.log("renderer column width shared key ui passed");
    app.exit(0);
  } catch (error) {
    console.error("renderer column width shared key ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
