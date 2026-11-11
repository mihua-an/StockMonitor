const { makeTempDir } = require("./support/temp_dirs.cjs");
// 價量's scrollbar in a real Chromium (run with Electron), the component on a fake data source (使用者 10-22: the thumb
// showed about three quarters of the track while every price was on screen and nothing scrolled). The thumb must
// follow the rows the panel holds: after the price count changes, and after the panel changes height, a ladder that
// fits has no thumb, one that does not has a thumb as long as the share it shows.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-price-flow-scrollbar-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const frames = (n = 4) => new Promise((resolve) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : resolve()); step(n); });
  const { PriceFlowComponent } = await import(`${base}js/core/components/price_flow_component.js`);

  let push = null;
  const context = {
    mode: "live",
    symbolStore: { getSelectedSymbol: () => "2330", subscribe: () => () => {} },
    dataSource: { invalidate: () => {}, subscribe: (_name, fn) => { push = fn; return () => {}; } },
    services: {},
  };
  const host = document.createElement("section");
  host.style.cssText = "width:520px;height:330px;display:flex;flex-direction:column";
  document.querySelector("main").appendChild(host);
  const component = new PriceFlowComponent();
  component.mount({ host, context });
  const scroll = host.querySelector('[data-role="price-flow-scroll"]');
  const thumb = host.querySelector("[data-scroll-thumb]");
  const track = host.querySelector("[data-scroll-track]");
  const show = async (count) => {
    const prices = Array.from({ length: count }, (_, n) => 100 + n);
    push({ code: "2330", identity: "2330", currentPrice: 100 + Math.floor(count / 2), referencePrice: 100,
      priceVolume: { flow_fields: ["large_buy", "large_sell", "small_buy", "small_sell", "unclassified_buy", "unclassified_sell"],
        buckets: prices.map((price) => ({ price, volume: 10, out: 5, in: 5, flow: [1, 1, 4, 4, 0, 0] })) } });
    await frames();
  };
  // Price rows the panel holds below its sticky header, and whether every one of `count` fits.
  const holds = () => Math.floor(scroll.clientHeight / component.rowSnap.rowHeight) - 1;
  const expectThumb = (count, when) => {
    const fits = count <= holds();
    if (fits && !thumb.hidden) fail(`${when}: all ${count} prices fit (${holds()} rows) but the thumb shows`);
    if (!fits && thumb.hidden) fail(`${when}: ${count} prices do not fit (${holds()} rows) but no thumb`);
    if (!fits) {
      const share = thumb.getBoundingClientRect().height / track.clientHeight;
      const expected = (holds() + 1) / (count + 1);
      if (Math.abs(share - expected) > 0.06) fail(`${when}: the thumb is ${share.toFixed(2)} of the track, the panel shows ${expected.toFixed(2)}`);
    }
  };

  await show(20);
  expectThumb(20, "a long ladder");
  // The day's prices shrink to what fits (same instrument): no scroll, the thumb follows at once.
  await show(holds());
  expectThumb(holds(), "the price count fell to what fits");
  // The panel gets shorter, then taller again (a splitter): the thumb follows the rows it holds each time.
  const count = holds();
  host.style.height = "200px";
  await frames(6);
  expectThumb(count, "the panel got shorter");
  host.style.height = "330px";
  await frames(6);
  expectThumb(count, "the panel got taller again");
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("price flow scrollbar ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("price flow scrollbar ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
