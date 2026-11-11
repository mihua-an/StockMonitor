// The topology drawn as SVG: nodes, links (a link moves only when the model says data moved), rate marks.

import { escapeHtml } from "./utility.js";
import { fmtInt } from "./diagnostics_format.js";
import { EDGES, ICON, LANES, LANE_OF, MAP_H, MAP_W } from "./diagnostics_topology.js";

// A node's events per second: a small line plus the latest figure, right-aligned at (right, baseline), room for
// "1,234/s" beside the line. Nothing measured yet: nothing drawn.
function rateMarkHtml(rate, right, baseline) {
  if (!rate || !rate.values.some((v) => v !== null)) return "";
  const width = 36, x = right - width - 54;
  return `<g class="dg-node-rate"><path d="${sparkPath(rate.values, x, baseline, width, 9)}"/>`
    + `${rate.latest === null ? "" : `<text x="${right}" y="${baseline}" text-anchor="end">${fmtInt(rate.latest)}/s</text>`}</g>`;
}

// A node's 自己回報 / HTTP 問 tag, as wide as its text at .dg-ask's 12.5 px.
export const askWidth = (ask) => [...ask].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 13 : 7.8), 14);

// WAL inside the Market Runtime node: its name and its state, in its own tone.
function walChipHtml(wal) {
  if (!wal) return "";
  return `<g class="dg-wal dg-tone-${wal.tone}" transform="translate(${wal.x} ${wal.y})"><rect class="dg-wal-box" width="${wal.w}" height="${wal.h}" rx="7"/>
    <text class="title" x="${wal.w / 2}" y="19" text-anchor="middle">${escapeHtml(wal.title)}</text><text class="state" x="${wal.w / 2}" y="37" text-anchor="middle">${escapeHtml(wal.state)}</text></g>`;
}

// ---------- drawing

export function edgeTone(e, nodes, flows) {
  const s = nodes[e.from], t = nodes[e.to];
  if (e.api) return s.tone === "ok" ? "api" : "unknown";
  // A 行情來源 node that failed sends nothing: its link is broken, not idle.
  if (s.tone === "fail" && s.source) return "broken";
  if (flows.has(e.key || `${e.from}>${e.to}`)) return "live";
  if (t.tone === "fail") return "broken";
  if (s.tone === "unknown" || t.tone === "unknown") return "unknown";
  return "idle";
}

export function sparkPath(values, x, y, w, h) {
  const max = Math.max(1, ...values.filter((v) => v !== null));
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  let pen = "M", gap = 0;
  return values.map((v, i) => {
    if (v === null) { gap += 1; if (gap > 5) pen = "M"; return ""; }
    const seg = `${pen}${(x + i * step).toFixed(1)},${(y - (v / max) * h).toFixed(1)}`;
    pen = "L"; gap = 0;
    return seg;
  }).filter(Boolean).join(" ");
}

// The left edge coloured the way a CSS border-left on a rounded box draws it (the old 服務總覽 items): 3 px wide,
// following both rounded corners and tapering to nothing along the top and bottom edge.
function edgeCrescent(h, r = 9, w = 3) {
  return `M${r} 0 A${r} ${r} 0 0 0 0 ${r} V${h - r} A${r} ${r} 0 0 0 ${r} ${h} A${r - w} ${r} 0 0 1 ${w} ${h - r} V${r} A${r - w} ${r} 0 0 1 ${r} 0 Z`;
}

export function renderMap(model, selected) {
  const { nodes, flows } = model;
  let edges = "", labels = "", dots = "", faults = "";
  // The panel is morphed, not rebuilt: a live edge's dot keeps looping on its own; it appears and goes with the flow.
  EDGES.forEach((e) => {
    const tone = edgeTone(e, nodes, flows), id = e.key || `${e.from}>${e.to}`;
    edges += `<path class="dg-edge ${tone}${e.noArrow ? " dg-no-arrow" : ""}" d="${e.d}"/>`;
    if (e.label) labels += `<text class="dg-edge-label${tone === "live" ? "" : " muted"}" x="${e.label[1]}" y="${e.label[2]}">${e.label[0]}</text>`;
    if (tone === "broken" && e.mid) faults += `<g class="dg-fault" data-morph-key="fault:${id}" transform="translate(${e.mid[0]} ${e.mid[1]})"><circle r="9"/><path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5"/></g>`;
    if (tone === "live" && !e.noArrow) dots += `<circle class="dg-traffic" data-morph-key="dot:${id}" r="2.6"><animateMotion dur="2s" repeatCount="indefinite" path="${e.d}"/></circle>`;
  });
  const nodeMarkup = (n) => {
    // WAL is drawn by the Market Runtime node it lives in.
    if (n.inner) return "";
    const h = n.h || 58, wal = n.id === "market" ? nodes.wal : null;
    // A lane member is drawn as a node but picked with its lane: it carries no button of its own.
    const pick = LANE_OF[n.id] ? "" : ` data-dg-node="${n.id}" role="button" tabindex="0" data-focus-ring="own" aria-label="${escapeHtml(n.title)}：${escapeHtml(n.state)}"`;
    const tw = n.ask ? askWidth(n.ask) : 0;
    // dg-ping plays once when the element is inserted: one element per Health pass (keyed by its time) plays it per pass.
    const pulse = n.ask && n.probed && model.heartbeat ? `<rect class="dg-pulse${n.tone === "fail" ? " dg-no-reply" : ""}" data-morph-key="pulse:${model.healthSampledAt}" x="-4" y="-4" width="${n.w + 8}" height="${h + 8}" rx="12"/>` : "";
    // Every node's badge top right and its events per second under it, Market Runtime's too (its WAL in its middle).
    const rate = rateMarkHtml(model.rates[n.id], n.w - 10, 48);
    return `<g class="dg-node dg-tone-${n.tone}${n.id === selected ? " selected" : ""}" data-morph-key="node:${n.id}"${pick} transform="translate(${n.x} ${n.y})">
      ${pulse}<rect class="box" width="${n.w}" height="${h}" rx="9"/><path class="stripe" d="${edgeCrescent(h)}"/>
      <text class="title" x="14" y="26">${escapeHtml(n.title)}</text><text class="state" x="14" y="48">${escapeHtml(n.state)}</text>
      <g transform="translate(${n.w - 22} 20)"><circle class="dg-badge-bg" r="11"/><text class="dg-badge-txt" text-anchor="middle" dominant-baseline="central">${ICON[n.tone]}</text></g>
      ${n.ask ? `<g class="dg-ask" transform="translate(${n.w - tw - 10} -10)"><rect width="${tw}" height="19" rx="4"/><text x="${tw / 2}" y="14" text-anchor="middle">${n.ask}</text></g>` : ""}
      ${rate}${walChipHtml(wal)}
    </g>`;
  };
  const laneHtml = Object.entries(LANES).map(([id, lane]) => {
    const [x, y, w, h] = lane.rect;
    const members = lane.members.map((m) => nodes[m]).filter(Boolean);
    const states = members.map((n) => `${n.title}：${n.state}`).join("，");
    return `<g class="dg-lane-pick${id === selected ? " selected" : ""}" data-morph-key="lane:${id}" data-dg-node="${id}" role="button" tabindex="0" data-focus-ring="own" aria-label="${escapeHtml(lane.title)}（${escapeHtml(states)}）">
      <rect class="dg-lane" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>${members.map(nodeMarkup).join("")}</g>`;
  }).join("");
  const nodeHtml = Object.values(nodes).filter((n) => !LANE_OF[n.id]).map(nodeMarkup).join("");
  // The traffic dots are drawn last, over every node and label, so nothing hides them on their way (user 10-20).
  return `<svg class="dg-map${model.healthOk ? "" : " stale"}" viewBox="0 0 ${MAP_W} ${MAP_H}" role="group" aria-label="系統拓樸：資料由行情來源進入資料處理，再推送到畫面渲染">
    <defs>
      <marker id="dgLive" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="dg-arrow live" d="M1 1 L7 4 L1 7"/></marker>
      <marker id="dgMuted" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="dg-arrow idle" d="M1 1 L7 4 L1 7"/></marker>
      <marker id="dgBad" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="dg-arrow broken" d="M1 1 L7 4 L1 7"/></marker>
    </defs>
    <g class="dg-body">
      <rect class="dg-lane" x="8" y="252" width="250" height="76" rx="10"/>
      <text class="dg-lane-title" x="20" y="22">行情來源</text>
      <text class="dg-lane-title" x="304" y="22">資料處理</text>
      <text class="dg-lane-title" x="748" y="22">畫面渲染</text>
      <text class="dg-lane-title" x="20" y="245">系統狀態</text>
      <text class="dg-lane-title" x="304" y="245">服務端點</text>
      ${laneHtml}
      ${nodeHtml}
      ${edges}${labels}${faults}${dots}
    </g></svg>`;
}
