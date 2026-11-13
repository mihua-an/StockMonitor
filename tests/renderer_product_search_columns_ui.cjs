const { makeTempDir } = require("./support/temp_dirs.cjs");
const { fixViewport } = require("./support/fixed_viewport.cjs");
// The product search box's dropdown in a real Chromium (run with Electron): the code column is shared by every row and
// as wide as the longest code shown, so a Futu crypto code (CC.BANDUSDT) never runs into its name, and a four-digit
// stock code gets the minimum (7ch). The rows are in the App's font, not the button default. The suggestions come through the real box: a provider registered,
// text typed into the input. PRODUCT_SEARCH_SCREENSHOT=<path.png> saves a picture of the Futu dropdown.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-product-search-columns-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { registerProductQuoteSearchProvider, productQuoteSearchHtml, bindProductQuoteHeaders } =
    await import(`${base}js/core/components/product_quote_search.js`);
  const lists = {
    futu: [{ code: "US.B", name: "Barrick Mining" }, { code: "CC.BAL", name: "Balancer" },
      { code: "CC.BALBTC", name: "BAL/BTC" }, { code: "CC.BANDUSDT", name: "BAND/USDT", note: "列表" },
      { code: "CC.BAT", name: "注意力幣" }],
    shioaji: [{ code: "2330", name: "台積電" }, { code: "2317", name: "鴻海" }],
  };
  for (const [name, items] of Object.entries(lists)) {
    registerProductQuoteSearchProvider(name, { suggest: async () => items, submit: async () => ({ ok: true }) });
  }
  document.body.innerHTML = Object.keys(lists).map((name) => `<div class="product-quote-header" style="margin:8px 8px 320px">`
    + `${productQuoteSearchHtml(name)}<span class="product-quote-code" data-code=""></span></div>`).join("");
  bindProductQuoteHeaders(document.body);

  async function open(name) {
    const input = document.querySelector(`[data-product-search="${name}"] [data-role="product-search-input"]`);
    input.focus();
    input.value = "B";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const results = input.closest(".product-quote-search").querySelector('[data-role="product-search-results"]');
    for (let i = 0; i < 50 && (results.hidden || !results.querySelector(".product-quote-search-result")); i += 1) await wait(20);
    if (results.hidden) fail(`${name}: the dropdown never opened`);
    return [...results.querySelectorAll(".product-quote-search-result")];
  }

  const report = {};
  for (const name of Object.keys(lists)) {
    const rows = await open(name);
    if (rows.length !== lists[name].length) fail(`${name}: ${rows.length} rows shown, ${lists[name].length} expected`);
    const codeLefts = new Set();
    const nameLefts = new Set();
    for (const row of rows) {
      const code = row.querySelector("b").getBoundingClientRect();
      const label = row.querySelector("span").getBoundingClientRect();
      const text = row.querySelector("b");
      if (text.scrollWidth > Math.ceil(code.width) + 0.5) fail(`${name}: ${text.textContent} is cut (${text.scrollWidth} > ${code.width})`);
      if (code.right > label.left + 0.5) fail(`${name}: ${text.textContent} runs into its name (${code.right} > ${label.left})`);
      codeLefts.add(Math.round(code.left));
      nameLefts.add(Math.round(label.left));
    }
    const appFont = getComputedStyle(document.body).fontFamily;
    for (const row of rows) {
      const font = getComputedStyle(row).fontFamily;
      if (font !== appFont) fail(`${name}: a row is in ${font}, not the App's ${appFont}`);
    }
    if (nameLefts.size !== 1) fail(`${name}: the names do not line up (${[...nameLefts].join(", ")})`);
    if (codeLefts.size !== 1) fail(`${name}: the codes do not line up (${[...codeLefts].join(", ")})`);
    const first = rows[0];
    const codeWidth = first.querySelector("b").getBoundingClientRect().width;
    const ch = (() => {
      // 7ch in the dropdown's font: the shared column's minimum is resolved there.
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;width:7ch";
      first.parentElement.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    })();
    report[name] = { codeWidth, sevenCh: ch };
    first.closest(".product-quote-search").querySelector("input").blur();
  }
  // Shioaji's codes are four digits: its column is the 7ch minimum. Futu's widest code sets its column.
  // The row's left padding sits in the first track of the subgrid, so the code itself is 7ch less that padding.
  if (Math.abs(report.shioaji.codeWidth + 8 - report.shioaji.sevenCh) > 0.5) {
    fail(`shioaji: the code column is not the 7ch minimum (${report.shioaji.codeWidth} + 8 vs ${report.shioaji.sevenCh})`);
  }
  if (!(report.futu.codeWidth + 8 > report.futu.sevenCh + 0.5)) fail("futu: the code column did not grow for CC.BANDUSDT");
  return report;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 900, webPreferences: { sandbox: false, offscreen: true } });
  const fixture = path.join(__dirname, "fixtures", "renderer_ui_geometry.html");
  await win.loadURL(pathToFileURL(fixture).href);
  await fixViewport(win, 640, 900);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    const report = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    if (process.env.PRODUCT_SEARCH_SCREENSHOT) {
      // The Futu dropdown open again for the picture (the scenario closed both).
      await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('[data-product-search="futu"] input');
        input.focus(); input.value = "BA"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      require("node:fs").writeFileSync(process.env.PRODUCT_SEARCH_SCREENSHOT,
        (await win.webContents.capturePage({ x: 0, y: 0, width: 320, height: 200 })).toPNG());
    }
    console.log("product search columns ui contract passed", JSON.stringify(report));
    app.exit(0);
  } catch (error) {
    console.error("product search columns ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
