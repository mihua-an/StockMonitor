import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productListShellMarkup } from "../ui/renderer/js/features/realtime/product_list.js";
import { readRendererCss } from "./lib/renderer_css.mjs";
import { readFutuComponentSources } from "./lib/futu_component_sources.mjs";

const shioaji = productListShellMarkup({ ariaLabel: "Shioaji 商品頁", provider: "shioaji" });
const futu = productListShellMarkup({ ariaLabel: "Futu 商品頁", provider: "futu" });
const ids = (markup) => [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const roles = (markup) => [...markup.matchAll(/\bdata-role="([^"]+)"/g)].map((match) => match[1]);

assert.deepEqual(ids(shioaji).filter((id) => ids(futu).includes(id)), [], "provider shells must not duplicate DOM ids");
assert.deepEqual(roles(shioaji), roles(futu), "both providers must expose the same product-list structure");
assert.match(shioaji, /data-role="product-list-table" data-provider="shioaji"/);
assert.match(futu, /data-role="product-list-table" data-provider="futu"/);

const componentSource = readFutuComponentSources();
assert.match(componentSource, /const current=view\|\|\{\}/, "empty Shioaji state must still render the shared schema");
assert.match(componentSource, /rows:Array\.isArray\(current\.rows\)\?current\.rows:\[\]/);

const realtimeQuoteTableSource = readFileSync(new URL("../ui/renderer/js/features/realtime/components/realtime_quote_table.js", import.meta.url), "utf8");
assert.match(realtimeQuoteTableSource, /mountedColumnIds\.length === expectedColumnIds\.length/,
  "both providers must reject retained headers whose visible column set is stale");
const styleSource = readRendererCss();
assert.match(styleSource, /\[data-role="product-list-table"\]\s*\{[^}]*width:\s*100%/s,
  "the shared semantic table role must own full-width layout for both providers");

console.log("renderer product list identity contract passed");
