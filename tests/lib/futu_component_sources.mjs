// The Futu realtime components' source text for contracts that read it: the barrel (moomoo_components.js) and every
// module under components/futu/, joined in a stable order.
import fs from "node:fs";

const components = new URL("../../ui/renderer/js/features/realtime/components/", import.meta.url);

export function readFutuComponentSources() {
  const dir = new URL("futu/", components);
  const modules = fs.readdirSync(dir).filter((name) => name.endsWith(".js")).sort();
  return [new URL("moomoo_components.js", components), ...modules.map((name) => new URL(name, dir))]
    .map((url) => fs.readFileSync(url, "utf8"))
    .join("\n");
}

/** One module under components/futu/, e.g. readFutuComponentModule("trade_pager.js"). */
export function readFutuComponentModule(name) {
  return fs.readFileSync(new URL(`futu/${name}`, components), "utf8");
}
