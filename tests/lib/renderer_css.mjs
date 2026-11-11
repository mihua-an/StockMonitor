// The app stylesheet as one text: ui/renderer/styles/index.css imports the files of each concern in cascade order.
import { readFileSync } from "node:fs";

const INDEX = new URL("../../ui/renderer/styles/index.css", import.meta.url);

function flatten(url) {
  return readFileSync(url, "utf8").replace(/@import url\("([^"]+)"\)[^;]*;/g, (_m, rel) => flatten(new URL(rel, url)));
}

export function readRendererCss() {
  return flatten(INDEX);
}
