import { readdirSync, readFileSync } from "node:fs";

// The 歷史回放 page's source as one text: pages/history.js and the modules split out of it under features/history/.
// Source-reading contracts search this, so they hold wherever a function now lives.
export function historySource() {
  return historySources().join("\n");
}

// The same files one text each (a parser reads one module at a time: joined, their declarations collide).
export function historySources() {
  const featureDir = new URL("../../ui/renderer/js/features/history/", import.meta.url);
  const parts = [readFileSync(new URL("../../ui/renderer/js/pages/history.js", import.meta.url), "utf8")];
  for (const name of readdirSync(featureDir).filter((file) => file.endsWith(".js")).sort()) {
    parts.push(readFileSync(new URL(name, featureDir), "utf8"));
  }
  return parts;
}
