// A keystroke supersedes the query before it at once. The previous text's answer arriving inside the
// next debounce window must not render, and its request is aborted.
import assert from "node:assert/strict";
import { bindProductQuoteHeaders, registerProductQuoteSearchProvider } from "../ui/renderer/js/core/components/product_quote_search.js";

const listeners = {};
const doc = { addEventListener: (type, fn) => { listeners[type] = fn; }, activeElement: null };
const results = { hidden: true, innerHTML: "", replaceChildren() { this.innerHTML = ""; } };
const search = { dataset: { productSearch: "test" }, querySelector: () => results };
const input = { value: "", ownerDocument: doc, closest: (selector) => (selector === ".product-quote-code-input" ? input : search) };
doc.activeElement = input;
bindProductQuoteHeaders({ ownerDocument: doc, querySelectorAll: () => [] });

const pending = [];
registerProductQuoteSearchProvider("test", {
  suggest: (text, { signal } = {}) => new Promise((resolve) => pending.push({ text, signal, resolve })),
});
const type = (value) => { input.value = value; listeners.input({ target: input }); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

type("23");
await wait(150);                       // the debounce fired: "23" is in flight
assert.equal(pending.length, 1);
type("233");                           // supersedes at once
assert.equal(pending[0].signal.aborted, true, "the in-flight request is aborted on the keystroke");
pending[0].resolve([{ code: "2330", name: "台積電" }]);   // the old answer lands inside the new debounce window
await wait(0);
assert.equal(results.innerHTML, "", "the previous text's answer never renders for the new text");
await wait(150);
assert.equal(pending.length, 2);
pending[1].resolve([{ code: "2330", name: "台積電" }]);
await wait(0);
assert.match(results.innerHTML, /2330/, "the current text's answer renders");
console.log("product search race contract passed (R10a-06)");
