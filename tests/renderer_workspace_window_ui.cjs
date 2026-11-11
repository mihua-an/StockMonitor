const { makeTempDir } = require("./support/temp_dirs.cjs");
// The real Workspace window (workspace_view.html) in Chromium, run with Electron; only Market Runtime's socket and the HTTP
// APIs are stood in for (support/workspace_window_fake_preload.cjs). WORKSPACE_UI_SHOT=<png> also saves a picture.
const { app, BrowserWindow } = require("electron");
const { fixViewport } = require("./support/fixed_viewport.cjs");
const path = require("node:path");
const fs = require("node:fs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-workspace-window-ui-"));
app.on("window-all-closed", () => {});

async function scenario(shot) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (test, label) => { for (let i = 0; i < 80; i += 1) { if (test()) return; await sleep(100); } throw new Error(`timed out: ${label}`); };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const list = () => [...document.querySelectorAll("[data-workspace-column]")].map((node) => node.dataset.workspaceColumn);
  const column = (code) => document.querySelector(`[data-workspace-column="${code}"]`);
  const card = (code) => document.querySelector(`[data-card-code="${code}"]`);
  const area = document.getElementById("workspaceColumns");
  const same = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  const drop = async (code, target) => {
    const data = new DataTransfer();
    card(code).dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data });
    target.dispatchEvent(over);
    const marks = { area: area.classList.contains("is-drop-target"), columns: [...document.querySelectorAll(".workspace-column.is-drop-target")].map((node) => node.dataset.workspaceColumn), accepted: over.defaultPrevented };
    if (over.defaultPrevented) target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    card(code).dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    await sleep(450);
    return marks;
  };
  const cutRows = (code) => {
    const viewport = column(code).querySelector(".workspace-trades-scroll");
    const box = viewport.getBoundingClientRect();
    return [...viewport.querySelectorAll("tbody tr")].filter((row) => {
      const r = row.getBoundingClientRect();
      return r.bottom > box.top + 0.5 && r.top < box.bottom - 0.5 && (r.top < box.top - 0.75 || r.bottom > box.bottom + 0.75);
    }).length;
  };

  await until(() => document.querySelectorAll("[data-card-code]").length === 9, "the dock's nine cards");
  window.__sendSeed("2330");
  await until(() => column("2330")?.querySelector("canvas"), "the seeded column");
  await sleep(600);

  // One product: a single card in the middle of the window, its header without a code box or a control row.
  const first = column("2330").getBoundingClientRect(), host = area.getBoundingClientRect();
  check(Math.abs((first.left + first.right) / 2 - (host.left + host.right) / 2) <= 1, "the first column is centred");
  check(!document.querySelector(".workspace-column input"), "a column has no code box");
  check(!document.querySelector(".workspace-column .trend-control-row"), "a column has no control row");
  check(column("2330").querySelectorAll(".workspace-column-remove").length === 1, "one close button");
  check(getComputedStyle(column("2330").querySelector(".workspace-column-remove")).opacity === "1", "the close button always shows");
  check(cutRows("2330") === 0, "成交明細 shows whole rows");
  check(!document.querySelector(".workspace-toolbar, [data-benchmark-mode]"), "no toolbar and no 比較基準 buttons");

  // The dock: the App's product cards with their candle, the add box above the 盤中事件 switch, as wide as each other.
  check(card("2330").querySelector(".stock-card-candle, .mini-candle, canvas, svg"), "a card draws its candle");
  check(card("2330").classList.contains("is-dimmed") && !card("2330").draggable, "a product already shown is grey and cannot be dragged");
  const box = document.querySelector(".workspace-dock .product-quote-code-input").getBoundingClientRect();
  const events = document.querySelector('.workspace-dock [data-role="event-marker-toggle"]').getBoundingClientRect();
  check(events.top >= box.bottom && Math.round(box.width) === Math.round(events.width) && Math.round(box.left) === Math.round(events.left), "the add box stands over the switch, equally wide");
  check(document.querySelector(".workspace-dock").getBoundingClientRect().height === 56, "the tools do not make the dock taller");

  // Adding: a click, and a drop anywhere while there is room -- on a column too.
  card("2317").click();
  await until(() => column("2317"), "the clicked product");
  card("2317").click();
  await sleep(150);
  same(list(), ["2330", "2317"], "a product is added once");
  const onColumn = await drop("2454", column("2330"));
  same(list(), ["2330", "2317", "2454"], "a drop on a column with room adds");
  check(onColumn.area && !onColumn.columns.length, "with room the whole area marks the drop");
  await drop("2603", area);
  await drop("3231", area);
  await drop("2382", area);
  same(list(), ["2330", "2317", "2454", "2603", "3231", "2382"], "six columns");
  check(Math.round(column("2330").getBoundingClientRect().width) === Math.round((area.clientWidth - 16 - 40) / 6), "six columns fill the window");

  // Full: the column under the pointer is replaced; empty space takes nothing.
  const onTarget = await drop("2308", column("2454"));
  same(list(), ["2330", "2317", "2308", "2603", "3231", "2382"], "a drop on a full window replaces that column");
  same(onTarget.columns, ["2454"], "the column about to be replaced is marked");
  const blank = await drop("6173", area);
  check(!blank.accepted, "a full window takes nothing in its empty space");
  same(list(), ["2330", "2317", "2308", "2603", "3231", "2382"], "nothing changed");

  // A column dragged onto another moves there, and the others keep their list position.
  const trades = column("2382").querySelector(".workspace-trades-scroll");
  const pitch = trades.querySelector("tbody tr").getBoundingClientRect().height;
  trades.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, wheelDeltaY: -120, bubbles: true, cancelable: true }));
  await sleep(150);
  check(Math.abs(trades.scrollTop - pitch) < 1.5 && cutRows("2382") === 0, `a wheel detent moves one whole row: scrolled ${trades.scrollTop}, pitch ${pitch}, cut ${cutRows("2382")}, client ${trades.clientHeight}, scrollHeight ${trades.scrollHeight}, rows ${trades.querySelectorAll("tbody tr").length}, row var ${trades.style.getPropertyValue("--row-height-trade-detail")}`);
  const grip = column("2330").querySelector(".product-quote-header");
  check(grip.draggable, "a column is dragged by its header");
  check(getComputedStyle(grip).cursor === "grab", `the header a column is dragged by shows the grab cursor: ${getComputedStyle(grip).cursor}`);
  const data = new DataTransfer();
  grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
  check(column("2330").classList.contains("is-moving"), "the dragged column shows it is moving");
  const destination = column("2603");
  destination.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
  destination.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  grip.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
  await sleep(300);
  same(list(), ["2317", "2308", "2603", "2330", "3231", "2382"], "a column moved");
  check(trades.scrollTop > 0, "a column that did not move keeps its scroll position");

  // Removed and added again, a column still has one ✕ and removes itself (the trend surface is reused between columns).
  for (let i = 0; i < 3; i += 1) {
    column("2317").querySelector(".workspace-column-remove").click();
    await sleep(250);
    card("2317").click();
    await until(() => column("2317"), "added again");
    await sleep(200);
    check(column("2317").querySelectorAll(".workspace-column-remove").length === 1, "still one close button");
    check(document.querySelectorAll(".workspace-column-remove").length === 6, "one close button per column");
  }
  const mover = column("2317").querySelector(".product-quote-header");
  const moved = new DataTransfer();
  mover.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: moved }));
  same(moved.getData("application/x-workspace-column"), "2317", "a reused header drags its current column");
  mover.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
  await sleep(100);
  column("3231").querySelector(".workspace-column-remove").click();
  await sleep(300);
  check(!column("3231") && list().length === 5, "✕ removes that column");

  // A month of a stock's futures: its card picker sets the side, the drop subscribes the FUT view and names it in full.
  card("2330").querySelector('[data-pick="m0"]').click();
  await sleep(500);
  check(!card("2330").classList.contains("is-dimmed"), "on its futures side the card is another product");
  await drop("2330", area);
  await until(() => column("CDF202611")?.querySelector("canvas"), "the futures column");
  await sleep(500);
  const subscribed = window.__wire.filter((message) => message.type === "view.subscribe").map((message) => message.payload);
  check(subscribed.some((spec) => spec.code === "CDF202611" && spec.market === "FUT" && spec.trading_date === "2026-11-06" && spec.channels.includes("trades")), "the FUT view of the live partition");
  check(subscribed.some((spec) => spec.market === "IDX"), "a stock's column subscribes 加權");
  check(subscribed.some((spec) => spec.code === "TXFR1" && spec.channels.join() === "summary,trend"), "個股期貨 subscribes 台指期");
  const replace = window.__wire.filter((message) => message.type === "workspace.replace").pop();
  // The transport upper-cases its codes; Market Runtime's InstrumentKey::parse puts the source back in lower case.
  check(replace.payload.codes.includes("SHIOAJI:FUT:CDF202611"), `the futures month is named in full: ${JSON.stringify(replace.payload.codes)}`);
  check(replace.payload.codes.includes("6173"), "the dock's products are this window's demand");
  check(document.querySelector('[data-workspace-column="CDF202611"] .product-quote-code')?.textContent.trim() === "CDF202611", "the header shows the month");

  // The add box is there when the window is full, and says why it takes nothing.
  check(list().length === 6, "full again");
  const input = document.querySelector(".workspace-dock .product-quote-code-input");
  check(input.offsetWidth > 0 && getComputedStyle(input).visibility === "visible", "the add box always shows");
  input.focus();
  input.value = "2382";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(400);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await sleep(250);
  check(input.closest(".product-quote-search").textContent.includes("已滿六檔"), "a full window says so");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  input.value = "";

  // Whole cards: nothing cut at the strip's edge, before or after the wheel moves it.
  const strip = document.querySelector(".workspace-dock-cards");
  const cutCards = () => { const b = strip.getBoundingClientRect(); return [...strip.children].filter((node) => { const r = node.getBoundingClientRect(); return r.right > b.left + 0.5 && r.left < b.right - 0.5 && (r.left < b.left - 0.75 || r.right > b.right + 0.75); }).length; };
  check(cutCards() === 0, "only whole cards");
  const step = strip.firstElementChild.getBoundingClientRect().width;
  strip.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
  await sleep(80);
  check(strip.scrollWidth <= strip.clientWidth || Math.abs(strip.scrollLeft - step) < 1, "a wheel detent moves one card");

  // The one 盤中事件 switch writes the shared preference.
  const toggle = document.querySelector('.workspace-dock [data-role="event-marker-toggle"]');
  const was = toggle.classList.contains("active");
  toggle.click();
  await sleep(100);
  check(toggle.classList.contains("active") !== was, "the switch follows its preference");
  toggle.click();
  void shot;
  return true;
}

app.whenReady().then(async () => {
  const shot = process.env.WORKSPACE_UI_SHOT || "";
  const win = new BrowserWindow({ show: false, width: 1760, height: 950, useContentSize: true, webPreferences: { sandbox: false, contextIsolation: false, webSecurity: false, backgroundThrottling: false,
    offscreen: Boolean(shot), preload: path.join(__dirname, "support", "workspace_window_fake_preload.cjs") } });
  const problems = [];
  const warnings = [];
  win.webContents.on("console-message", (event) => {
    const { level, message } = event;
    if (level === "warning") warnings.push(message);
    // The page's CSP placeholder is filled in by renderer_release_manager.js, which this test does not run.
    if (level === "error" && !message.includes("__STOCKMONITOR_CONNECT_SOURCES__")) problems.push(message);
  });
  let frame = null;
  win.webContents.on("paint", (_event, _dirty, image) => { frame = image; });
  try {
    await win.loadFile(path.join(__dirname, "..", "ui", "renderer", "workspace_view.html"));
    await fixViewport(win, 1760, 950);
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(shot)})`);
    if (shot) { await new Promise((resolve) => setTimeout(resolve, 1200)); fs.writeFileSync(shot, frame.toPNG()); }
    if (problems.length) throw new Error(`console errors: ${problems.join(" | ")}`);
    console.log("workspace window ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error("console errors:", problems, "warnings:", warnings.slice(0, 12));
    app.exit(1);
  }
});
