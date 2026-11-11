// The shared product list in Chromium (run with Electron):
// - a code listed twice keeps both of its rows across renders (each listing is its own row identity), and a rebuilt
//   index (rows already in the DOM) finds the same rows;
// - the page-tab rail's viewport is the strip, which ends at the tool buttons: wheel and track click stop at the same
//   last offset, and nothing is attached to the host element.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-product-rows-")));
app.on("window-all-closed", () => {});

async function rowsScenario(base) {
  const { renderProductListRows } = await import(`${base}js/features/realtime/product_list.js`);
  const page = document.getElementById("pageContainer");
  page.innerHTML = "<table><tbody></tbody></table>";
  const body = page.querySelector("tbody");
  const cellsOf = (row) => [{ text: row.code }, { text: String(row.price) }];
  const render = (rows, changed = null) => renderProductListRows({ body, rows, columnCount: 2, cellsOf, changedCodes: changed });
  render([{ code: "2330", price: 1 }, { code: "2317", price: 2 }, { code: "2330", price: 3 }]);
  const first = [...body.children];
  render([{ code: "2330", price: 1 }, { code: "2317", price: 2 }, { code: "2330", price: 4 }], new Set(["2330"]));
  const second = [...body.children];
  // A fresh index (a second body element holding the same rows) is rebuilt from the DOM with the same keys.
  const clone = body.cloneNode(true);
  page.querySelector("table").appendChild(clone);
  const clonedRows = [...clone.children];
  renderProductListRows({ body: clone, rows: [{ code: "2330", price: 1 }, { code: "2317", price: 2 }, { code: "2330", price: 5 }], columnCount: 2, cellsOf });
  return {
    sameRows: first.length === 3 && first.every((node, i) => node === second[i]),
    patched: second[2].textContent === "23304",
    rebuiltSame: clonedRows.every((node, i) => node === clone.children[i]),
    rebuiltPatched: clone.children[2].textContent === "23305",
  };
}

async function railScenario(base) {
  const { productListShellMarkup, renderProductPageTabs, disposeProductPageTabs } = await import(`${base}js/features/realtime/product_list.js`);
  const page = document.getElementById("pageContainer");
  page.innerHTML = `<div style="position:absolute;left:0;top:0;width:400px;height:300px;display:flex;flex-direction:column">${productListShellMarkup({ provider: "futu" })}</div>`;
  const host = page.querySelector('[data-role="product-list-pages"]');
  const pages = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `自選頁${i}`, items: [] }));
  renderProductPageTabs(host, { pages, activePageId: "p0" });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const content = host.querySelector(".product-list-pages-content");
  const tools = page.querySelector(".product-list-tools");
  const expectedMax = Math.max(0, content.scrollWidth - host.clientWidth);
  for (let i = 0; i < 40; i += 1) host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
  const wheelOffset = Number(host.dataset.productScrollOffset);
  const rail = page.querySelector(".product-list-pages-rail");
  const rect = rail.getBoundingClientRect();
  host.dataset.productScrollOffset = "0";
  rail.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.right - 0.01, clientY: rect.top + 1, bubbles: true }));
  const trackOffset = Number(host.dataset.productScrollOffset);
  const expando = Object.keys(host).filter((key) => key.startsWith("__"));
  disposeProductPageTabs(host);
  return { expectedMax, wheelOffset, trackOffset, expando, toolsWidth: tools.getBoundingClientRect().width };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 700, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  const js = (code) => win.webContents.executeJavaScript(code);
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  try {
    const rows = await js(`(${rowsScenario.toString()})(${JSON.stringify(base)})`);
    check(rows.sameRows, "a code listed twice keeps both rows across renders");
    check(rows.patched, "the second listing's row is patched in place");
    check(rows.rebuiltSame, "an index rebuilt from the DOM keeps every listing's row");
    check(rows.rebuiltPatched, "the rebuilt index patches the second listing's row");

    const rail = await js(`(${railScenario.toString()})(${JSON.stringify(base)})`);
    check(rail.toolsWidth > 0, `the tool buttons have a width (${rail.toolsWidth})`);
    check(rail.expectedMax > 0, `the tabs overflow the strip (${rail.expectedMax})`);
    check(Math.abs(rail.wheelOffset - rail.expectedMax) < 1, `wheel stops at the end of the strip (${rail.wheelOffset} vs ${rail.expectedMax})`);
    check(Math.abs(rail.trackOffset - rail.expectedMax) < 1, `track click reaches the same end (${rail.trackOffset} vs ${rail.expectedMax})`);
    check(rail.expando.length === 0, `nothing is attached to the host element (${rail.expando})`);

    if (problems.length) throw new Error(`\n  ${problems.join("\n  ")}`);
    console.log("renderer product list rows ui passed");
    app.exit(0);
  } catch (error) {
    console.error("renderer product list rows ui FAILED:", error?.message || error);
    app.exit(1);
  }
});
