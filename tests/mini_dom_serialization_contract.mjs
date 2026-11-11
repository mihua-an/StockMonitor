// tests/lib/mini_dom.mjs serializes and parses like Chromium (the expected strings are what Electron 44's Chromium
// innerHTML/outerHTML give for the same tree), so a node contract that compares markup sees what the browser would.
import assert from "node:assert/strict";
import { createDocument } from "./lib/mini_dom.mjs";

const doc = createDocument();
const cell = doc.createElement("td");
cell.setAttribute("title", `A&B "q" <x> 'y'`);
cell.textContent = `1 < 2 & 3 > 2 "q" 'y' `;
assert.equal(cell.outerHTML, `<td title="A&amp;B &quot;q&quot; &lt;x&gt; 'y'">1 &lt; 2 &amp; 3 &gt; 2 "q" 'y'&nbsp;</td>`);

// Parsing decodes character references in text and attributes, and round-trips.
const host = doc.createElement("div");
host.innerHTML = `<span class="a b" data-row-key="x&amp;y" title='it&#39;s'>&lt;b&gt; &amp; &#x41;&nbsp;</span><br><img alt=z>tail`;
const span = host.querySelector("span.a.b");
assert.equal(span.dataset.rowKey, "x&y");
assert.equal(span.title, "it's");
assert.equal(span.textContent, "<b> & A ");
assert.equal(host.innerHTML, `<span class="a b" data-row-key="x&amp;y" title="it's">&lt;b&gt; &amp; A&nbsp;</span><br><img alt="z">tail`);
assert.equal(host.querySelector('[data-row-key="x&y"]'), span);
assert.equal(span.closest("div"), host);
assert.throws(() => host.querySelector("div span"), /unsupported selector/, "a selector it cannot evaluate is an error, never a miss");
console.log("mini DOM serialization contract passed");
