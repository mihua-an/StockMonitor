// 系統連線診斷 -- topology, Health heartbeat and per-node numbers.
//
// buildDiagnosticsModel() is pure: it turns what the renderer can already read into nodes, links and tiles, and is
// the only place that decides a colour or an animation. Two rules it never bends:
//   * a link animates only when data really moved through it since the previous poll (a counter advanced, or the
//     newest event is younger than FLOW_FRESH_MS) -- a green node with nothing passing through draws a still line;
//   * a node's tiles are its fixed shape: drawn at once, each value that has not arrived reads 等待資料 (never 0 or
//     "--"), so a card never appears late because its numbers do (user 10-19).
// renderDiagnostics() draws a model; the polling lives in status.js.
//
// Layout (user 10-20, 10-22): one row of four cards on top -- 延遲, 系統 CPU, 記憶體, 儲存空間 -- and under it the compact topology
// (left to right) beside the detail of what is picked on it. Nothing in the panel scrolls: the cards set the width, the
// topology scales to it and sets the row's height, every detail fits beside it. No 補救事件 card (the developer's: Health's ledger and var/logs remediation-*.jsonl).

import { cpuCardHtml, latencyCardHtml, memoryCardHtml, storageCardHtml } from "./diagnostics_cards.js";
import { renderInspector, renderLaneInspector } from "./diagnostics_inspector.js";
import { askWidth, edgeTone, renderMap, sparkPath } from "./diagnostics_map.js";
import { ASK, EDGES, LANES, LANE_OF, LAYOUT } from "./diagnostics_topology.js";

// The three cards on top, and under them the topology beside the detail of what is picked on it.
export function renderDiagnostics(model, selected) {
  // A lane member's id (an older selection) picks its lane; nothing picked yet is 行情來源.
  const pick = LANE_OF[selected] || (LANES[selected] || model.nodes[selected] ? selected : "sources");
  // Every detail that can be picked is drawn, one over another, and only the picked one shows: the card is as tall as
  // the tallest of them, so picking another never changes the panel's height.
  const picks = [...Object.keys(LANES), ...Object.keys(model.nodes).filter((id) => !LANE_OF[id])];
  const panes = picks.map((id) => `<div class="dg-pane${id === pick ? " current" : ""}" data-morph-key="pane:${id}"${id === pick ? "" : ' aria-hidden="true" inert'}>`
    + `${LANES[id] ? renderLaneInspector(LANES[id], model.nodes) : renderInspector(model.nodes[id])}</div>`).join("");
  // Keys keep each card the same element across polls; the detail is a new card per pick.
  return `<div class="dg-kpis" data-morph-key="kpis">${latencyCardHtml(model.latency)}${cpuCardHtml(model.system)}${memoryCardHtml(model.memory)}${storageCardHtml(model.storage)}</div>
    <section class="dg-card dg-map-card" data-morph-key="topology"><header class="dg-card-head"><h4>系統拓樸</h4></header><div class="dg-map-wrap">${renderMap(model, pick)}</div></section>
    <aside class="dg-card dg-inspector" data-morph-key="inspector:${pick}" aria-live="polite">${panes}</aside>`;
}

export const __test = { edgeTone, sparkPath, EDGES, LAYOUT, LANES, ASK, askWidth };
