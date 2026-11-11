// 手機卡片 in a real Chromium (run with Electron): the tabs are the shared segmented control, and choosing one slides its
// background: the control and the background stay the same elements across the re-draw, so the move is a transition.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
require("./support/keep_motion.cjs").keepMotion(app);
app.setPath("userData", makeTempDir("stockmonitor-mobile-cards-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const fail = (message) => { throw new Error(message); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { renderMobileCards } = await import(`${base}js/features/account/mobile_cards_view.js`);
  const rank = (name) => ({ data: [{ code: "2330", name, profit: 9000, rate: 0.12 }] });
  const entries = { "rank:spot:profit": rank("台積電"), "rank:spot:loss": rank("長榮"), "realizedReport:day": { items: [] } };
  const container = document.createElement("div");
  document.querySelector("main").append(container);
  renderMobileCards(container, { entries }, { profitClass: () => "flat", today: new Date("2026-10-07T12:00:00") });

  const card = [...container.querySelectorAll(".mobile-card")].find((node) => node.textContent.includes("現股排名"));
  const seg = card.querySelector(".settings-seg");
  if (!seg) fail("the tabs are the shared segmented control");
  const [profit, loss] = seg.querySelectorAll(".settings-seg-btn");
  const thumb = seg.querySelector(".settings-seg-thumb");
  if (!thumb) fail("the control has its sliding background");
  await wait(450);
  const left = () => parseFloat(getComputedStyle(thumb).left);
  const before = left();
  if (Math.abs(before - profit.offsetLeft) > 1) fail(`the background starts under 賺錢: ${before} vs ${profit.offsetLeft}`);

  loss.click();
  await frame();
  await frame();
  if (card.querySelector(".settings-seg") !== seg) fail("a choice keeps the control");
  if (seg.querySelector(".settings-seg-thumb") !== thumb) fail("a choice keeps the background, or it could not slide");
  if (seg.querySelectorAll(".settings-seg-thumb").length !== 1) fail("one background");
  if (!loss.classList.contains("is-active") || profit.classList.contains("is-active")) fail("賠錢 is the chosen one");
  if (!card.textContent.includes("長榮")) fail("the card shows the chosen ranking");
  const moving = left();
  if (!(moving > before && moving < loss.offsetLeft)) fail(`the background is on its way: ${before} -> ${moving} -> ${loss.offsetLeft}`);
  await wait(450);
  if (Math.abs(left() - loss.offsetLeft) > 1) fail(`the background ends under 賠錢: ${left()} vs ${loss.offsetLeft}`);

  const header = card.querySelector(".mobile-card-header").getBoundingClientRect();
  if (seg.getBoundingClientRect().right > header.right + 0.5) fail("the control fits its card's header");
  return { ok: true };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: false, offscreen: true } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
  try {
    await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    console.log("mobile cards ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error("mobile cards ui contract FAILED:", error?.message || error);
    app.exit(1);
  }
});
