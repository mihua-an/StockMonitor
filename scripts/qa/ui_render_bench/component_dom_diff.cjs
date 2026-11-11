// Drives a component of two checkouts through the same sequence of view models and compares the DOM after each step:
//   electron scripts/qa/ui_render_bench/component_dom_diff.cjs <treeA> <treeB> [scenario]
//   STOCKMONITOR_DOM_IGNORE=name,name=value  leaves those attributes (ones a change adds on purpose) out of the comparison
// A refactor of how a component writes the DOM must leave what it shows unchanged; this states it for the scenarios
// in component_dom_scenarios.js (run in the page, against each tree's own modules).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const [rootA, rootB, only = ""] = process.argv.slice(2);
const ignore = String(process.env.STOCKMONITOR_DOM_IGNORE || "").split(",").filter(Boolean);
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "component-dom-diff-")));

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(rootA, "tests/fixtures/renderer_ui_geometry.html"));
    const scenarios = pathToFileURL(path.join(__dirname, "component_dom_scenarios.js")).href;
    const results = [];
    for (const root of [rootA, rootB]) {
      const base = pathToFileURL(path.join(root, "ui/renderer/")).href;
      results.push(await win.webContents.executeJavaScript(`import(${JSON.stringify(scenarios)}).then((m) => m.run(${JSON.stringify(base)}, ${JSON.stringify(only)}, ${JSON.stringify(ignore)}))`));
    }
    let differing = 0;
    for (const [name, stepsA] of Object.entries(results[0])) {
      const stepsB = results[1][name] || [];
      stepsA.forEach((html, index) => {
        if (html === stepsB[index]) return;
        differing += 1;
        let at = 0; while (at < html.length && html[at] === stepsB[index]?.[at]) at += 1;
        console.log(`${name} step ${index}: differs at ${at}\n  A: ${html.slice(Math.max(0, at - 120), at + 160)}\n  B: ${String(stepsB[index]).slice(Math.max(0, at - 120), at + 160)}`);
      });
      console.log(`${name}: ${stepsA.length} steps compared`);
    }
    console.log(differing ? `DIFFERENT (${differing} steps)` : "IDENTICAL");
    app.exit(differing ? 2 : 0);
  } catch (error) { console.error(error); app.exit(1); }
});
