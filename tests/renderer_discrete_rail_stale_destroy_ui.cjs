// The product list's row rail stays on the right edge when a stale row-snap handle is destroyed a second time, in a
// real Chromium (run with Electron). The page controller keeps the handle it got from enableSharedProductListScroll;
// the grid can be torn down (which destroys that handle) and mounted again with a new rail before the controller
// destroys its handle on the next bind. That second destroy must not take data-standard-grid-discrete-rail off the
// wrapper: without it the new rail falls out of its absolute place to the bottom-left, below the horizontal rail.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-discrete-rail-stale-destroy-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const { productListShellMarkup, enableSharedProductListScroll } = await import(`${base}js/features/realtime/product_list.js`);
  const { destroyStandardDataGrid } = await import(`${base}js/core/data_grid.js`);
  const main = document.querySelector("main");
  main.innerHTML = `<div id="host" style="width:560px;height:420px;display:flex;flex-direction:column">${productListShellMarkup()}</div>`;
  const host = document.getElementById("host");
  host.querySelector(".product-list").style.flex = "1 1 auto";
  const body = host.querySelector('[data-role="product-list-body"]');
  const titleRow = host.querySelector('[data-role="product-list-table"] thead tr');
  titleRow.setAttribute("data-canonical-title-row", "");
  titleRow.innerHTML = "<th>股名</th><th>現價</th>";
  body.innerHTML = Array.from({ length: 3 }, (_, i) => `<tr><td>商品${i}</td><td>${100 + i}</td></tr>`).join("");
  const wrapper = host.querySelector(".product-list-table-wrap");
  const read = () => {
    const rails = [...wrapper.querySelectorAll(":scope > .shared-discrete-row-rail")];
    const w = wrapper.getBoundingClientRect();
    return {
      flag: wrapper.dataset.standardGridDiscreteRail ?? null,
      rails: rails.map((rail) => {
        const r = rail.getBoundingClientRect();
        return { position: getComputedStyle(rail).position, right: Math.round(w.right - r.right) };
      }),
    };
  };
  const held = enableSharedProductListScroll(host).rowSnap;
  await frame();
  const before = read();
  destroyStandardDataGrid(wrapper);
  enableSharedProductListScroll(host);
  await frame();
  const rebuilt = read();
  held.destroy();
  held.destroy();
  await frame();
  return { before, rebuilt, after: read() };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: false, offscreen: true } });
  const fail = (message) => { console.error(`discrete rail stale destroy ui contract FAILED: ${message}`); app.exit(1); };
  try {
    await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
    const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
    const at = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    for (const [step, s] of Object.entries(at)) {
      if (s.flag !== "1") return fail(`${step}: the wrapper's data-standard-grid-discrete-rail is ${s.flag}`);
      if (s.rails.length !== 1) return fail(`${step}: ${s.rails.length} row rails in the wrapper`);
      const [rail] = s.rails;
      if (rail.position !== "absolute" || rail.right !== 0) {
        return fail(`${step}: the row rail is ${rail.position}, ${rail.right}px from the wrapper's right edge`);
      }
    }
    console.log("discrete rail stale destroy ui contract passed");
    app.exit(0);
  } catch (error) {
    fail(error?.stack || error);
  }
});
