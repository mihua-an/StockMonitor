// 內外盤比: one bar, 外盤 share on the left, 內盤 on the right, the percentages at both ends. Shared by the order book
// (the instrument's whole-day aggressor volume) and 價量 (大單 and 小單 each). NEUTRAL and UNKNOWN stay separate
// segments of the same bar: merging them makes an unresolved classification look like a confirmed neutral trade.
// Styles: components/io-ratio.css. Built once; patchIoRatio writes only what changed.

import { escapeHtml, byRole as role, syncText } from "../utility.js";

/** The bar's markup. `label` (e.g. 大單) is shown before it; `className` lets the host place it. */
export function ioRatioMarkup({ label = "", className = "" } = {}) {
  const classes = ["io-ratio", label ? "io-ratio-labeled" : "", className].filter(Boolean).join(" ");
  return `<div class="${classes}" data-role="io-ratio">${label ? `<span class="io-ratio-label">${escapeHtml(label)}</span>` : ""}`
    + `<span class="io-ratio-side io-ratio-outside"><b data-role="outside-ratio">50.00%</b></span>`
    + `<div class="io-ratio-center"><div class="io-ratio-track" data-role="io-ratio-track"><div data-role="outside-bar" class="io-ratio-out"></div>`
    + `<div data-role="unknown-bar" class="io-ratio-unknown-bar"></div><div data-role="neutral-bar" class="io-ratio-neutral-bar"></div>`
    + `<div data-role="inside-bar" class="io-ratio-in"></div></div></div>`
    + `<span class="io-ratio-side io-ratio-inside"><b data-role="inside-ratio">50.00%</b></span></div>`;
}

/** The nodes patchIoRatio writes, from the bar's root (or any element holding exactly one bar). */
export function ioRatioNodes(root) {
  return {
    outside: role(root, "outside-ratio"), inside: role(root, "inside-ratio"), track: role(root, "io-ratio-track"),
    outsideBar: role(root, "outside-bar"), neutralBar: role(root, "neutral-bar"), unknownBar: role(root, "unknown-bar"), insideBar: role(root, "inside-bar"),
  };
}

const amount = (raw) => (Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : 0);
function setWidth(node, pct) {
  const width = `${pct}%`;
  if (node && node.style.width !== width) node.style.width = width;
}

/** Volumes per side; null (nothing to show) is an even 50 / 50 bar with no tooltip. */
export function patchIoRatio(nodes, volumes) {
  const outside = amount(volumes?.outside), inside = amount(volumes?.inside);
  const neutral = amount(volumes?.neutral), unknown = amount(volumes?.unknown);
  const total = outside + inside + neutral + unknown;
  const share = (value, empty) => (total > 0 ? value / total * 100 : empty);
  const outPct = share(outside, 50), inPct = share(inside, 50);
  syncText(nodes.outside, `${outPct.toFixed(2)}%`);
  syncText(nodes.inside, `${inPct.toFixed(2)}%`);
  setWidth(nodes.outsideBar, outPct);
  setWidth(nodes.neutralBar, share(neutral, 0));
  setWidth(nodes.unknownBar, share(unknown, 0));
  setWidth(nodes.insideBar, inPct);
}
