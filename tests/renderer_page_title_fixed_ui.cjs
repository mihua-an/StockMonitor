const { makeTempDir } = require("./support/temp_dirs.cjs");
// 帳務, 模型中心 and 資料中心 keep their title row at the top (使用者 11-03), in a real Chromium (run with Electron): each
// page's real HTML in the App's frame (.app > .main > .page-container), its content made taller than the window and
// scrolled to the bottom. Checked: the title row is not inside the scrolling area and does not move, the area under it
// is what scrolls (the App's frame does not), and the title row lines up with the column under it.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-page-title-fixed-ui-"));
app.on("window-all-closed", () => {});

// [page html, title row, scroll area, the column under the title row (where the filler goes)].
const PAGES = [
  ["account.html", ".account-page-header", ".account-content-scroll", ".account-view.active"],
  ["training.html", ".settings-page-head", ".training-scroll-area", ".mc-wrap"],
  ["data_center.html", ".settings-page-head", ".dc-scroll-area", ".dc-wrap"],
];

function measure(html, headSelector, scrollSelector, columnSelector) {
  document.body.innerHTML = `<div class="app app-bottom-nav"><main class="main main-with-bottom-nav"><section id="pageContainer" class="page-container">${html}</section></main></div>`;
  const head = document.querySelector(headSelector);
  const scroll = document.querySelector(scrollSelector);
  const column = document.querySelector(columnSelector);
  const filler = document.createElement("div");
  filler.style.height = "3000px";
  column.appendChild(filler);
  const before = head.getBoundingClientRect().top;
  // Instant: 帳務's scroll area scrolls smoothly, which would still be under way when measured.
  scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
  const main = document.querySelector(".main");
  main.scrollTo({ top: main.scrollHeight, behavior: "instant" });
  const headBox = head.getBoundingClientRect();
  const title = head.querySelector("h1").getBoundingClientRect();
  const columnStyle = getComputedStyle(column);
  const columnLeft = column.getBoundingClientRect().left + parseFloat(columnStyle.paddingLeft);
  return {
    inside: scroll.contains(head),
    before,
    after: headBox.top,
    scrolled: scroll.scrollTop,
    scrollBox: [scroll.clientHeight, scroll.scrollHeight],
    mainScrolled: main.scrollTop,
    titleLeft: title.left,
    columnLeft,
    scrollTop: scroll.getBoundingClientRect().top,
    headBottom: headBox.bottom,
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 900, webPreferences: { sandbox: false, backgroundThrottling: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const pages = path.join(__dirname, "..", "ui", "renderer", "pages");
  const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`);
  const failures = [];
  try {
    for (const [file, head, scroll, column] of PAGES) {
      const m = await run(measure, fs.readFileSync(path.join(pages, file), "utf8"), head, scroll, column);
      const tag = `${file}: ${JSON.stringify(m)}`;
      if (m.inside) failures.push(`${file}: the title row sits inside the scroll area`);
      if (m.scrolled < 1000) failures.push(`${file}: the area under the title row scrolls (${tag})`);
      if (m.mainScrolled !== 0) failures.push(`${file}: the App's frame does not scroll (${tag})`);
      if (Math.abs(m.after - m.before) > 0.5) failures.push(`${file}: the title row stays where it was (${tag})`);
      if (m.scrollTop < m.headBottom - 0.5) failures.push(`${file}: the scroll area starts under the title row (${tag})`);
      // A thin scroll bar takes width from the area under the title only: the two may differ by half of it.
      if (Math.abs(m.titleLeft - m.columnLeft) > 6) failures.push(`${file}: the title lines up with the column under it (${tag})`);
    }
  } catch (error) {
    failures.push(String(error?.stack || error));
  }
  if (failures.length) {
    console.error(`page title fixed ui contract FAILED:\n${failures.join("\n")}`);
    app.exit(1);
    return;
  }
  console.log("page title fixed ui contract passed");
  app.exit(0);
});
