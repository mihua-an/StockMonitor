// The detail beside the topology: a node's or a lane's tiles, grouped as the model gives them.

import { escapeHtml } from "./utility.js";
import { PENDING_TEXT, num } from "./diagnostics_format.js";
import { ICON } from "./diagnostics_topology.js";

const arrived = (t) => t.v !== null && t.v !== undefined && t.v !== "";

function tileHtml(t) {
  const value = arrived(t) ? t.v : PENDING_TEXT;
  const tone = !arrived(t) ? " dg-tone-pending" : t.tone ? ` dg-tone-${t.tone}` : "";
  const bar = num(t.bar) === null ? "" : `<div class="dg-bar"><i style="width:${Math.min(100, Math.max(0, Math.round(t.bar * 100)))}%"></i></div>`;
  return `<div class="dg-tile${t.wide ? " wide" : ""}${t.wrap ? " dg-tile-wrap" : ""}${tone}"><small>${escapeHtml(t.k)}</small><b>${escapeHtml(value)}</b>${t.sub && arrived(t) ? `<span class="sub">${escapeHtml(t.sub)}</span>` : ""}${bar}</div>`;
}

// A node's groups as drawn: every tile it defines, filled or still waiting.
function reportedGroups(node) {
  return (node.groups || []).filter(([, tiles]) => tiles.length);
}

const tilesHtml = (tiles) => `<div class="dg-tiles">${tiles.map(tileHtml).join("")}</div>`;

// A node's numbers, the same in a node's own detail and in a lane's (user 10-19): its groups one under another, as far
// apart as two tiles. Every tile names its own value, so a group needs no caption.
function groupsHtml(node, empty) {
  const groups = reportedGroups(node);
  return groups.length ? `<div class="dg-groups">${groups.map(([, tiles]) => tilesHtml(tiles)).join("")}</div>` : `<p class="dg-empty">${empty}</p>`;
}

const RECONNECT_HTML = '<button type="button" class="dg-action" data-moomoo-reconnect>重新檢查 Futu 連線</button>';

export function renderInspector(node) {
  if (!node) return "";
  const body = groupsHtml(node, "這一段目前沒有回報任何數值。");
  return `<div class="dg-ins-head"><div><h3>${escapeHtml(node.title)}</h3></div>
    <span class="dg-pill dg-tone-${node.tone}">${ICON[node.tone]} ${escapeHtml(node.state)}</span></div>${body}${node.action === "futu-reconnect" ? RECONNECT_HTML : ""}`;
}

// A lane's detail: each of its nodes as one line (its name, its state) over its groups.
export function renderLaneInspector(lane, nodes) {
  const members = lane.members.map((id) => nodes[id]).filter(Boolean);
  // A node drawn inside another (WAL in Market Runtime) has its numbers in that node's section too.
  const body = members.filter((node) => !node.inner).map((node) => {
    const tiles = groupsHtml(node, "沒有回報任何數值。");
    return `<section class="dg-member" data-morph-key="member:${node.id}"><div class="dg-member-head"><h4>${escapeHtml(node.title)}</h4>
      <span class="dg-pill dg-tone-${node.tone}">${ICON[node.tone]} ${escapeHtml(node.state)}</span></div>${tiles}</section>`;
  }).join("");
  const action = members.some((node) => node.action === "futu-reconnect") ? RECONNECT_HTML : "";
  return `<div class="dg-ins-head"><div><h3>${escapeHtml(lane.title)}</h3></div></div>${body}${action}`;
}
