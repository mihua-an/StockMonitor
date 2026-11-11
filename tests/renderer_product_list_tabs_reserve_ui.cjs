const { makeTempDir } = require("./support/temp_dirs.cjs");
// The product list's page tabs against its two tool buttons, in a real Chromium (run with Electron), user 11-09: tabs
// that did not fit ran on under the buttons. Checked, on a list too narrow for its tabs:
//   * the tab strip ends where the tools begin, and the tools stay inside the header;
//   * the point just left of the tools is the strip, the point just inside them is the tools;
//   * stepping the wheel to the end shows the last tab whole, left of the tools.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-product-tabs-reserve-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.desktopAPI = { networkManifest: { routes: [["/api/", "app_api"]], services: { app_api: { url: "http://app.invalid" } } } };
  window.fetch = async (input) => new Response(JSON.stringify({ ok: false, error: `not served: ${String(input?.url || input)}` }),
    { status: 404, headers: { "Content-Type": "application/json" } });
  const { UnifiedProductListComponent } = await import(`${base}js/features/realtime/components/futu/product_list_components.js`);
  const { publishTaiwanProductPages } = await import(`${base}js/features/realtime/taiwan_product_list_store.js`);

  document.getElementById("pageContainer").innerHTML = `<div id="productSlot" style="position:absolute;left:0;top:0;width:420px;height:300px"></div>`;
  const slot = document.getElementById("productSlot");
  const pages = Array.from({ length: 12 }, (_, index) => ({ id: `page-${index}`, name: `自選清單${index}`, codes: [] }));
  publishTaiwanProductPages({ overview: { id: "overview", name: "總覽", codes: [] }, pages, activePageId: "overview" });
  const list = new UnifiedProductListComponent();
  list.mount({ host: slot });
  await frames();

  const header = slot.querySelector(".product-list-header");
  const host = slot.querySelector('[data-role="product-list-pages"]');
  const content = host.querySelector(":scope > .product-list-pages-content");
  const tools = slot.querySelector(".product-list-tools");
  if (!content?.children.length) fail("the strip has its tabs");
  if (content.scrollWidth <= header.clientWidth) fail(`the tabs must overflow for this check: ${content.scrollWidth}`);
  const hostBox = host.getBoundingClientRect(), toolsBox = tools.getBoundingClientRect(), headerBox = header.getBoundingClientRect();
  const measured = { host: [hostBox.left, hostBox.right], tools: [toolsBox.left, toolsBox.right], header: [headerBox.left, headerBox.right], clientWidth: host.clientWidth, contentWidth: content.scrollWidth };
  console.log(`measured: ${JSON.stringify(measured)}`);
  if (Math.abs(hostBox.right - toolsBox.left) > 0.5) fail(`the strip ends where the tools begin: ${JSON.stringify(measured)}`);
  if (Math.abs(toolsBox.right - headerBox.right) > 0.5) fail(`the tools stay at the header's right edge: ${JSON.stringify(measured)}`);

  const y = toolsBox.top + toolsBox.height / 2;
  if (!host.contains(document.elementFromPoint(toolsBox.left - 1, y))) fail("just left of the tools is the tab strip");
  if (!tools.contains(document.elementFromPoint(toolsBox.left + 1, y))) fail("just inside the tools is the tools");

  for (let step = 0; step < content.children.length + 2; step += 1) {
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    await frames();
  }
  await new Promise((resolve) => setTimeout(resolve, 200));   // the strip's own 80 ms transform transition
  const last = content.lastElementChild.getBoundingClientRect();
  console.log(`measured: ${JSON.stringify({ last: [last.left, last.right], content: content.getBoundingClientRect().right, offset: host.dataset.productScrollOffset })}`);
  if (last.left < hostBox.left) fail(`the last tab is shown whole: left ${last.left}`);
  if (last.right > toolsBox.left) fail(`the last tab stays left of the tools: ${last.right} vs ${toolsBox.left}`);
  const contentRight = content.getBoundingClientRect().right;   // the tabs' run ends with the strip's own trailing gap
  if (Math.abs(contentRight - toolsBox.left) > 1) fail(`the tabs' run ends at the tools' left edge: ${contentRight} vs ${toolsBox.left}`);
  list.destroy();
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("console-message", (details) => { if (String(details.message || "").startsWith("measured:")) console.log(details.message); });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("product list tabs reserve ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("product list tabs reserve ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
