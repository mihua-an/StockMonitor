// The dock's three action buttons (新版提示, 新增交易, Workspace) share one shape and differ only in colour: one base rule
// (styles/layout/app-shell.css .dock-action-btn) and a colour rule each. Drawn in Chromium (run with Electron) from the
// real markup (index.html, features/app_update/update_notice.js) on index.css.
// DOCK_BUTTONS_JSON=<file> writes what was measured (for comparing two versions).
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeTempDir } = require("./support/temp_dirs.cjs");

app.disableHardwareAcceleration();
app.setPath("userData", makeTempDir("stockmonitor-dock-buttons-"));
app.on("window-all-closed", () => {});

const renderer = path.join(__dirname, "..", "ui", "renderer");
const indexHtml = fs.readFileSync(path.join(renderer, "index.html"), "utf8");
const buttonTag = (id) => indexHtml.match(new RegExp(`<button id="${id}"[^>]*>[^<]*</button>`))[0];
const updateClass = fs.readFileSync(path.join(renderer, "js", "features", "app_update", "update_notice.js"), "utf8")
  .match(/button\.className = "([^"]+)"/)[1];
const markup = `${buttonTag("globalAddTradeBtn")}${buttonTag("globalOpenWorkspaceBtn")}<button id="update" class="${updateClass}" type="button">新版</button>`;

async function scenario(base, html) {
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = `${base}styles/index.css`;
  document.head.appendChild(link);
  await new Promise((resolve) => { link.onload = link.onerror = resolve; });
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  const token = (expr) => { probe.style.color = expr; return getComputedStyle(probe).color; };
  const read = (node) => {
    const s = getComputedStyle(node);
    return { minHeight: s.minHeight, padding: s.padding, border: `${s.borderTopWidth} ${s.borderTopStyle}`, radius: s.borderRadius,
      borderColor: s.borderTopColor, background: s.backgroundColor, color: s.color, font: `${s.fontSize} ${s.fontWeight}`,
      lineHeight: s.lineHeight, cursor: s.cursor, whiteSpace: s.whiteSpace, classes: node.className };
  };
  return {
    addTrade: read(document.getElementById("globalAddTradeBtn")),
    workspace: read(document.getElementById("globalOpenWorkspaceBtn")),
    update: read(document.getElementById("update")),
    expect: {
      addTrade: { border: token("var(--blue-500-a72)"), color: token("var(--blue-200)") },
      workspace: { border: token("var(--violet-300x-a72)"), color: token("var(--violet-100x)") },
      update: { border: token("var(--focus-ring-color)"), color: token("var(--white)") },
    },
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 200, webPreferences: { sandbox: false } });
  await win.loadURL(pathToFileURL(path.join(__dirname, "fixtures", "renderer_ui_geometry.html")).href);
  const base = pathToFileURL(renderer + path.sep).href;
  try {
    const seen = await win.webContents.executeJavaScript(`(${scenario.toString()})(${JSON.stringify(base)}, ${JSON.stringify(markup)})`);
    if (process.env.DOCK_BUTTONS_JSON) fs.writeFileSync(process.env.DOCK_BUTTONS_JSON, JSON.stringify(seen, null, 2));
    const problems = [];
    for (const name of ["addTrade", "workspace", "update"]) {
      const b = seen[name];
      if (!b.classes.split(" ").includes("dock-action-btn")) problems.push(`${name} is not a dock action button: ${b.classes}`);
      const shape = [b.minHeight, b.padding, b.border, b.radius, b.font, b.cursor, b.whiteSpace].join("|");
      if (shape !== "24px|4px 10px|1px solid|6px|12px 800|pointer|nowrap") problems.push(`${name} shape: ${shape}`);
      if (b.borderColor !== seen.expect[name].border) problems.push(`${name} border ${b.borderColor}, not ${seen.expect[name].border}`);
      if (b.color !== seen.expect[name].color) problems.push(`${name} text ${b.color}, not ${seen.expect[name].color}`);
    }
    if (problems.length) throw new Error(problems.join("; "));
    console.log("dock action buttons ui contract passed");
    app.exit(0);
  } catch (error) {
    console.error(`dock action buttons ui contract FAILED: ${error?.message || error}`);
    app.exit(1);
  }
});
