// The four cards on top (延遲, 系統 CPU, 記憶體, 儲存空間) as markup, from the model's card figures.

import { escapeHtml } from "./utility.js";
import { GB, PENDING_TEXT, bytesText, durationText, durationUs, percentText } from "./diagnostics_format.js";
import { LATENCY_WARN_US } from "./diagnostics_model.js";

// The title row: the card's name on the left, and on the right a short text or its last-2-minutes line.
const kpiHead = (title, right = "") => `<div class="dg-kpi-head"><span>${escapeHtml(title)}</span>${right}</div>`;

const headText = (text) => (text ? `<span>${escapeHtml(text)}</span>` : "");

const pendingBig = `<div class="dg-kpi-big"><span class="dg-kpi-pending">${PENDING_TEXT}</span></div>`;

// A total's last 2 minutes as a small line in the title row (user 10-22: the 系統 CPU line moved there, 記憶體 has
// its own). CPU is drawn from 0 (its size against the computer is the point); 記憶體 between its own low and high, so
// a slow climb shows instead of a flat line near the top. Each point sits at its time across the 2 minutes (`from` at the
// left edge, `to` at the right). No line until two values arrived.
function trendHtml({ points, from, to }, { fromZero }) {
  // Stretched to the room the title row leaves (preserveAspectRatio none; the line keeps its width, non-scaling-stroke).
  const w = 160, h = 18;
  const seen = points.map((p) => p.v).filter((v) => v !== null);
  if (seen.length < 2) return "";
  const hi = Math.max(...seen), lo = fromZero ? 0 : Math.min(...seen);
  const pad = fromZero ? 0 : Math.max((hi - lo) * 0.2, hi * 0.01);
  const top = fromZero ? Math.max(5, hi * 1.3) : hi + pad, bottom = fromZero ? 0 : lo - pad;
  const x = (t) => Math.min(w, Math.max(0, ((t - from) / (to - from || 1)) * w));
  // A missing sample stays a gap: the line is cut there into runs of samples that did arrive, never drawn across
  // it as if it had been sampled. A run of one sample is a short dash at its place.
  const runs = [];
  points.forEach(({ t, v }) => {
    if (v === null) { if (runs.at(-1)?.length) runs.push([]); return; }
    if (!runs.length) runs.push([]);
    runs.at(-1).push([x(t), h - 2 - ((v - bottom) / (top - bottom || 1)) * (h - 4)]);
  });
  const drawn = runs.filter((run) => run.length).map((run) => (run.length > 1 ? run : [[run[0][0] - 1, run[0][1]], [run[0][0] + 1, run[0][1]]]));
  const path = (run) => run.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = drawn.map((run) => `${path(run)} L${run.at(-1)[0].toFixed(1)} ${h} L${run[0][0].toFixed(1)} ${h} Z`).join(" ");
  return `<svg class="dg-kpi-trend" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path class="dg-spark-area" d="${area}"/><path class="dg-spark-line" d="${drawn.map(path).join(" ")}"/></svg>`;
}

export function latencyCardHtml({ rows }) {
  const body = rows.map((r) => {
    // The bar holds the stages that have a sample, each its share of their total; a stage without one gets no
    // block (its legend says so), and an effective zero gets none either -- it takes no share.
    const sampled = r.stages.filter((s) => !s.missing && Number.isFinite(s.p50));
    const total = sampled.reduce((sum, s) => sum + s.p50, 0);
    const bar = total > 0 ? sampled.filter((s) => s.p50 > 0)
      .map((s) => `<i class="dg-part-${s.part}" style="width:${Math.max(0.8, (s.p50 / total) * 100).toFixed(2)}%"></i>`).join("") : "";
    const parts = r.stages.map((s) => `<span><i class="dg-part-${s.part}"></i>${s.label} ${s.missing || durationUs(s.p50)}</span>`).join("");
    const all = r.all.missing ? `<b class="dg-lat-none">${r.all.missing}</b>` : `<b${r.all.p50 > LATENCY_WARN_US ? ' class="dg-tone-warn"' : ""}>${durationUs(r.all.p50)}</b>`;
    // P99 alone beside 一般 (user 10-22: no P95).
    const tail = r.all.missing ? "" : `<span>P99 ${durationUs(r.all.p99)}</span>`;
    return `<div class="dg-lat-row" data-morph-key="lat:${r.id}"><div class="dg-lat-top"><span class="dg-lat-src">${r.name}</span>${all}<div class="dg-kpi-bar">${bar}</div></div>`
      + `<div class="dg-kpi-legend">${tail}${parts}</div></div>`;
  }).join("");
  // No window text in the title row (user 10-22: 近 1 分鐘 · 一般 removed).
  return `<section class="dg-kpi" data-morph-key="kpi:latency">${kpiHead("延遲（交易所 → 畫面）")}${body}</section>`;
}

// 系統 CPU, 記憶體 and 儲存空間 as a ring (user 10-20, 10-22): each part's share, the total in its middle, and the parts
// listed beside it one per line -- the card is as tall as 延遲 anyway. Each part carries its colour (dg-part-N). The
// ring's whole is the parts' total, or `whole` when given: 系統 CPU's ring is the whole computer (100%), so a quiet
// App reads as a short arc rather than a full ring.
function donutHtml(m, sizeText, whole = m.total) {
  let at = 0;
  const gap = m.parts.filter((p) => p.value > 0).length > 1 ? 0.6 : 0;
  const arcs = whole > 0 ? m.parts.filter((p) => p.value > 0).map((p) => {
    const share = (p.value / whole) * 100;
    const arc = `<circle class="dg-donut-arc dg-part-${p.part}" cx="50" cy="50" r="40" pathLength="100"`
      + ` stroke-dasharray="${Math.max(0.3, share - gap).toFixed(2)} ${(100 - Math.max(0.3, share - gap)).toFixed(2)}" stroke-dashoffset="${(25 - at).toFixed(2)}"/>`;
    at += share;
    return arc;
  }).join("") : "";
  // "2.6 GB" reads as the figure over its unit; "28.8%" is one figure, a little lower to sit in the middle.
  const [value, unit] = sizeText(m.total).split(" ");
  return `<svg class="dg-donut" viewBox="0 0 100 100" aria-hidden="true"><circle class="dg-donut-track" cx="50" cy="50" r="40"/>${arcs}`
    + `<text class="dg-donut-total" x="50" y="${unit ? 50 : 57}" text-anchor="middle">${value}</text>`
    + `${unit ? `<text class="dg-donut-unit" x="50" y="66" text-anchor="middle">${unit}</text>` : ""}</svg>`;
}

function ringCardHtml(key, head, m, sizeText, whole, foot = "") {
  if (!m) return `<section class="dg-kpi" data-morph-key="${key}">${head}${pendingBig}</section>`;
  const list = m.parts.map((p) => `<span class="dg-ring-part"><i class="dg-part-${p.part}"></i>${escapeHtml(p.label)}</span><b>${sizeText(p.value)}</b>`).join("");
  return `<section class="dg-kpi" data-morph-key="${key}">${head}<div class="dg-ring" aria-label="合計 ${sizeText(m.total)}">${donutHtml(m, sizeText, whole)}`
    + `<div class="dg-ring-list">${list}</div></div>${foot}</section>`;
}

// A storage move under way (user 11-09): 目標、進度、已用時間、目標剩餘空間、預計搬動多少.
function storageMoveHtml(move) {
  if (!move) return "";
  const percent = move.percent === null ? "" : ` ${move.percent.toFixed(0)}%`;
  const facts = [
    move.total === null ? "計算中" : `${bytesText(move.done ?? 0)} / ${bytesText(move.total)}`,
    move.elapsedMs === null ? null : `已用 ${durationText(move.elapsedMs)}`,
    move.targetFree === null ? null : `${move.drive} 剩 ${Math.round(move.targetFree / GB)} GB`,
  ].filter(Boolean).map((text) => `<span>${escapeHtml(text)}</span>`).join("");
  return `<div class="dg-storage-move"><div class="dg-storage-move-title">搬移到 ${escapeHtml(move.to)} · ${escapeHtml(move.state)}${percent}</div>`
    + `<div class="dg-storage-move-bar"><i style="width:${(move.percent ?? 0).toFixed(2)}%"></i></div>`
    + `<div class="dg-storage-move-facts">${facts}</div></div>`;
}

export const cpuCardHtml = (m) => ringCardHtml("kpi:cpu", kpiHead("系統 CPU", trendHtml(m.trend, { fromZero: true })), m.ring, percentText, 100);

export const memoryCardHtml = (m) => ringCardHtml("kpi:memory", kpiHead("記憶體", trendHtml(m.trend, { fromZero: false })), m.ring, bytesText);

// What is left on the storage location's disk (user 10-28) stays in 儲存空間's title row: it is not part of the ring,
// or StockMonitor's own parts would shrink to a sliver of it.
export const storageCardHtml = (m) => ringCardHtml("kpi:storage",
  kpiHead("儲存空間", headText(m && m.free !== null && m.disk !== null ? `${m.drive} 剩 ${Math.round(m.free / GB)} / ${Math.round(m.disk / GB)} GB` : null)), m, bytesText, undefined, storageMoveHtml(m?.move));
