const { makeTempDir } = require("./support/temp_dirs.cjs");
// The 模擬下單 order ticket (order_ticket.js, order-ticket.css) in a real Chromium at the widths its holders give it:
// the App's 模擬帳務 下單 column (190px) and the popover beside a 買賣報價 (300px). One row per field, its name over
// 市價 / 改零股 at the left and the − ＋ capsule at the right: 價格's input shows a whole price (1234.50), each name
// stays clear of its capsule, and the two rows together are no taller than the old side-by-side fields (78px), so the
// 買賣報價 above keeps its height.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-order-ticket-width-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const { orderTicketHtml } = await import(`${base}js/features/realtime/components/order_ticket.js`);
  const main = document.querySelector("main");
  for (const width of [190, 300]) {
    main.innerHTML = `<div id="ticket" style="width:${width}px">${orderTicketHtml()}</div>`;
    const root = document.getElementById("ticket");
    const price = root.querySelector('[data-ticket="price"]');
    const qty = root.querySelector('[data-ticket="qty"]');
    price.value = "1234.50";
    root.querySelector('[data-ticket="qty-label"]').textContent = "股數";
    root.querySelector('[data-ticket-action="lot"]').textContent = "改整股";
    await settle();
    if (price.scrollWidth > price.clientWidth) fail(`${width}px: 價格 cuts 1234.50 (scrollWidth ${price.scrollWidth} > clientWidth ${price.clientWidth})`);
    for (const field of root.querySelectorAll(".order-ticket-field")) {
      const capsule = field.querySelector(".order-ticket-stepper").getBoundingClientRect();
      for (const label of field.querySelectorAll(".order-ticket-field-head > *")) {
        const box = label.getBoundingClientRect();
        if (box.right > capsule.left) fail(`${width}px: "${label.textContent}" runs into the − ＋ capsule`);
        if (box.height > 16) fail(`${width}px: "${label.textContent}" wraps`);
      }
    }
    if (!(qty.getBoundingClientRect().top > price.getBoundingClientRect().bottom)) fail(`${width}px: 張數 sits under 價格`);
    const fields = root.querySelector(".order-ticket-fields").getBoundingClientRect().height;
    if (fields > 80) fail(`${width}px: 價格 and 張數 take ${fields}px, more than the old fields' 78px`);
  }
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: false } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}).then((r) => r.ok)`);
    console.log("order ticket width ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("order ticket width ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
