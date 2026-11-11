import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The renderer asks yes/no questions through main (desktopAPI.confirm -> dialog:confirm). The page's own
// window.confirm / alert are synchronous, and on Windows the page's inputs cannot take focus after one
// closes until the window loses and regains focus (the trade window could not be typed into after its "上筆交易結果
// 待確認" question).
const root = fileURLToPath(new URL("..", import.meta.url));
const rendererRoot = join(root, "ui", "renderer");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(m?js|html)$/.test(name)) files.push(path);
  }
})(rendererRoot);

// window.prompt is not here: Electron does not implement it at all (BACKLOG, 工作區「換成」).
const call = /(?:\bwindow\.|\bglobalThis\.|(?<![.\w#]))(confirm|alert)\s*\(/g;
const offenders = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const match of code.matchAll(call)) {
      offenders.push(`${relative(root, file).replaceAll("\\", "/")}:${index + 1}: ${match[1]}(`);
    }
  });
}
assert.ok(files.length > 50, "the renderer sources were found");
assert.deepEqual(offenders, [], `page dialogs in the renderer (use desktopAPI.confirm):\n${offenders.join("\n")}`);

const preload = readFileSync(join(root, "ui", "main", "preload.js"), "utf8");
assert.match(preload, /confirm: \(message\) => ipcRenderer\.invoke\("dialog:confirm"/, "preload offers the question main asks");
const contract = readFileSync(join(root, "ui", "main", "ipc_contract.js"), "utf8");
assert.match(contract, /"dialog:confirm": \{ kind: "invoke", pages: TRADE,/, "the trade window and the main window may ask");
console.log(`renderer no page dialogs contract passed (${files.length} files)`);
