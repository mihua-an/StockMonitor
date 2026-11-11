// The split data grid's look comes from its stylesheet alone, in a real Chromium (run with Electron): data_grid.js
// builds the shell and only measures (the scrollbar lane, the column widths) -- it writes no overflow, scrollbar-gutter,
// cap colour or body-table layout inline. On the real stylesheets:
// - the shell never scrolls, whatever its wrapper's own class says (帳務's .finance-table-wrap, a replay 事件列表);
// - the scrollbar cap beside the column titles has the first title cell's background and bottom line;
// - the body table lays out like the header table (the class it copied).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-data-grid-shell-style-ui-"));
app.on("window-all-closed", () => {});

async function scenario(base) {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rows = (n, cells) => Array.from({ length: n }, (_, i) => `<tr>${cells.map((c) => `<td>${c}${i}</td>`).join("")}</tr>`).join("");
  const main = document.querySelector("main");
  main.innerHTML = `
    <div class="account-page" style="width:500px">
      <div id="page" class="table-wrap finance-table-wrap" data-grid-variant="page" style="height:160px">
        <table class="data-table finance-table"><thead><tr data-canonical-title-row><th>日期</th><th>損益</th></tr></thead><tbody>${rows(30, ["d", "p"])}</tbody></table>
      </div>
      <div id="plain" class="table-wrap finance-table-wrap" style="height:160px">
        <table class="data-table finance-table"><thead><tr data-canonical-title-row><th>日期</th><th>損益</th></tr></thead><tbody>${rows(30, ["d", "p"])}</tbody></table>
      </div>
    </div>
    <div class="record-panel event-feed mode-replay" style="width:400px;height:200px">
      <div id="replay" class="table-wrap-plain event-feed-table-wrap" data-grid-x="hidden" style="height:160px">
        <table class="record-table event-feed-table"><thead><tr data-canonical-title-row><th>時間</th><th>事件</th></tr></thead><tbody>${rows(30, ["t", "e"])}</tbody></table>
      </div>
    </div>`;
  const { upgradeStandardDataGrid } = await import(`${base}js/core/data_grid.js`);
  const out = {};
  for (const id of ["page", "plain", "replay"]) {
    const wrapper = document.getElementById(id);
    upgradeStandardDataGrid(wrapper);
    await frame();
    await frame();
    const cap = wrapper.querySelector(".standard-data-grid-scrollbar-cap");
    const th = wrapper.querySelector(".standard-data-grid-header-table th");
    const headerTable = wrapper.querySelector(".standard-data-grid-header-table");
    const bodyTable = wrapper.querySelector(".standard-data-grid-body-table");
    const css = (node) => getComputedStyle(node);
    out[id] = {
      inline: {
        wrapper: ["overflow", "scrollbar-gutter"].filter((p) => wrapper.style.getPropertyValue(p)),
        cap: ["background-color", "border-bottom-color", "border-bottom-style", "border-bottom-width"].filter((p) => cap.style.getPropertyValue(p)),
        body: ["table-layout", "border-collapse", "border-spacing"].filter((p) => bodyTable.style.getPropertyValue(p)),
      },
      overflow: [css(wrapper).overflowX, css(wrapper).overflowY, css(wrapper).scrollbarGutter],
      capWidth: cap.getBoundingClientRect().width,
      cap: [css(cap).backgroundColor, css(cap).borderBottomColor, css(cap).borderBottomWidth],
      th: [css(th).backgroundColor, css(th).borderBottomColor, css(th).borderBottomWidth],
      layout: [css(bodyTable).tableLayout, css(bodyTable).borderCollapse, css(bodyTable).borderSpacing],
      headerLayout: [css(headerTable).tableLayout, css(headerTable).borderCollapse, css(headerTable).borderSpacing],
    };
  }
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: false, offscreen: true } });
  const fail = (message) => { console.error(`data grid shell style ui contract FAILED: ${message}`); app.exit(1); };
  try {
    await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
    const base = pathToFileURL(path.join(__dirname, "..", "ui", "renderer") + path.sep).href;
    const at = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)})`);
    for (const [id, grid] of Object.entries(at)) {
      for (const [node, props] of Object.entries(grid.inline)) {
        if (props.length) return fail(`${id}: data_grid.js wrote ${node}'s ${props.join(", ")} inline`);
      }
      if (grid.overflow[0] !== "hidden" || grid.overflow[1] !== "hidden" || grid.overflow[2] !== "auto") {
        return fail(`${id}: the shell scrolls (${grid.overflow.join(" / ")})`);
      }
      if (grid.layout[1] !== grid.headerLayout[1] || grid.layout[2] !== grid.headerLayout[2]) {
        return fail(`${id}: the body table lays out ${grid.layout.join(" / ")}, the header table ${grid.headerLayout.join(" / ")}`);
      }
      if (grid.layout[0] !== "fixed") return fail(`${id}: the body table's layout is ${grid.layout[0]}, not fixed`);
    }
    // The two 帳務 grids keep the native scrollbar beside their rows: the cap shows, painted like the title cells.
    for (const id of ["page", "plain"]) {
      const grid = at[id];
      if (!(grid.capWidth > 0)) return fail(`${id}: no scrollbar cap beside the titles (width ${grid.capWidth})`);
      if (grid.cap[0] !== grid.th[0]) return fail(`${id}: the cap's background ${grid.cap[0]} is not the title's ${grid.th[0]}`);
      if (grid.cap[1] !== grid.th[1] || grid.cap[2] !== grid.th[2]) {
        return fail(`${id}: the cap's bottom line ${grid.cap.slice(1).join(" ")} is not the title's ${grid.th.slice(1).join(" ")}`);
      }
    }
    console.log("data grid shell style ui contract passed");
    app.exit(0);
  } catch (error) {
    fail(error?.stack || error);
  }
});
