import { readdirSync, readFileSync } from "node:fs";

// The 買賣報價 component's source as one text: orderbook_component.js and the modules split out of it
// (orderbook_layout / _depth_table / _price_volume / _header). Source-reading contracts search this, so they hold
// wherever a function now lives.
export function orderbookSource() {
  const dir = new URL("../../ui/renderer/js/core/components/", import.meta.url);
  return readdirSync(dir).filter((name) => /^orderbook_.*\.js$/.test(name)).sort()
    .map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
}
