// 逐價內外盤: the price-volume chart beside the book, updated in place bar by bar.

import { buildPriceVolumeProjection } from "../price_volume_projection.js";
import { byRole as role, escapeHtml, formatPrice } from "../utility.js";
import { samePrice } from "./orderbook_depth_table.js";

const priceVolumeRenderCounts = new WeakMap();

// The price-volume chart's elements, kept on the chart: price -> level, and each level's stack / bars / markers.
// An update finds them without querying the DOM and writes only the heights and classes that changed.
function priceVolumeLevels(chart, barsHost) {
  if (!chart._pvLevels) {
    chart._pvLevels = new Map();
    for (const level of barsHost.children) {
      if (level.classList?.contains("pv-level")) chart._pvLevels.set(String(level.dataset.price || ""), level);
    }
  }
  return chart._pvLevels;
}

function levelParts(level) {
  if (!level._pv) {
    const stack = level.querySelector(".pv-stack");
    level._pv = { stack, out: level.querySelector(".pv-out"), in: level.querySelector(".pv-in"),
      current: level.querySelector(".pv-current-marker"), heights: {} };
  }
  return level._pv;
}

function setHeight(parts, key, node, value) {
  if (!node || parts.heights[key] === value) return;
  node.style.height = value;
  parts.heights[key] = value;
}

function updatePriceVolumeInPlace(host, projection, { topologyChanged = false } = {}) {
  const chart = host.querySelector?.(".pv-chart");
  const barsHost = chart?.querySelector?.(".pv-bars");
  const { buckets, currentIndex, maxVolume } = projection;
  if (!chart || !barsHost) return false;
  const known = priceVolumeLevels(chart, barsHost);
  const next = new Map();
  const levels = buckets.map((row, position) => {
    const key = String(row.price);
    let level = known.get(key);
    if (!level) {
      level = document.createElement("div");
      level.className = "pv-level";
      level.dataset.price = key;
      const stack = document.createElement("div"); stack.className = "pv-stack";
      const out = document.createElement("i"); out.className = "pv-out";
      const inside = document.createElement("i"); inside.className = "pv-in";
      stack.append(out, inside); level.appendChild(stack);
    }
    // Moved only when it is not already in its place (re-appending every level was a DOM move per bucket per tick).
    if (barsHost.children[position] !== level) barsHost.insertBefore(level, barsHost.children[position] || null);
    next.set(key, level);
    return level;
  });
  for (const [key, stale] of known) if (next.get(key) !== stale) stale.remove();
  chart._pvLevels = next;
  levels.forEach((level, index) => {
    const row = buckets[index] || {};
    const out = Math.max(0, Number(row.out || 0));
    const inside = Math.max(0, Number(row.in || 0));
    const sum = out + inside;
    const height = Math.max(sum > 0 ? 4 : 1, sum / maxVolume * 100);
    const current = index === currentIndex && samePrice(row.price, projection.currentPrice);
    if (topologyChanged) {
      level.querySelectorAll(".pv-extreme-marker").forEach((node) => node.remove());
      if (index === 0 || index === buckets.length - 1) {
        const marker = document.createElement("span");
        marker.className = `pv-extreme-marker ${index === 0 ? "low" : "high"}`;
        marker.setAttribute("aria-label", index === 0 ? "最低價" : "最高價");
        marker.textContent = index === 0 ? "L" : "H";
        level.insertBefore(marker, level.firstChild);
      }
    }
    const parts = levelParts(level);
    if (level.classList.contains("pv-current") !== current) level.classList.toggle("pv-current", current);
    if (current && level.dataset.currentTradePrice !== "1") level.dataset.currentTradePrice = "1";
    else if (!current && level.dataset.currentTradePrice !== undefined) delete level.dataset.currentTradePrice;
    if (current && !parts.current) {
      parts.current = document.createElement("span");
      parts.current.className = "pv-current-marker";
      parts.current.setAttribute("aria-label", "當下成交價");
      level.insertBefore(parts.current, parts.stack);
    } else if (!current && parts.current) { parts.current.remove(); parts.current = null; }
    setHeight(parts, "stack", parts.stack, `${height.toFixed(2)}%`);
    setHeight(parts, "out", parts.out, `${(sum > 0 ? out / sum * 100 : 0).toFixed(2)}%`);
    setHeight(parts, "in", parts.in, `${(sum > 0 ? inside / sum * 100 : 0).toFixed(2)}%`);
  });
  const facts = { focusPrice: String(projection.currentPrice ?? ""), domainIncludesCurrent: projection.domainIncludesCurrent ? "1" : "0",
    bucketCount: String(projection.bucketCount), domainLow: String(projection.low ?? ""), domainHigh: String(projection.high ?? "") };
  for (const [key, value] of Object.entries(facts)) if (chart.dataset[key] !== value) chart.dataset[key] = value;
  const axisHost = chart.querySelector(".pv-axis");
  if (topologyChanged && axisHost) axisHost.innerHTML = projection.axis.map((item) => `<span class="pv-axis-tick pv-axis-${item.slot.toLowerCase()}" style="left:${item.position.toFixed(4)}%" data-price="${escapeHtml(String(item.price))}">${formatPrice(item.price)}</span>`).join("");
  return true;
}

export function renderPriceVolume(root, rows = [], emptyText = "等待逐價內外盤資料", currentPrice = null, vm = {}) {
  const host = role(root, "price-volume");
  if (!host) return;
  const projection = buildPriceVolumeProjection(rows, currentPrice);
  const { buckets, axis, currentIndex, maxVolume } = projection;
  const identity = String(vm?.code || vm?.logicalCode || "").trim().toUpperCase();
  if (!buckets.length) {
    // Invalidation order can briefly publish an empty compatibility/context
    // projection after the canonical chart is already visible. Preserve the
    // last good same-symbol chart instead of flashing empty and remounting it.
    if (identity && host.dataset.pvIdentity === identity && host.querySelector(".pv-chart")) return;
    host.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    delete host.dataset.pvTopology;
    host.dataset.pvIdentity = identity;
    return;
  }
  const topology = buckets.map((row) => String(row.price)).join("|");
  const renderCount = (priceVolumeRenderCounts.get(host) || 0) + 1;
  priceVolumeRenderCounts.set(host, renderCount);
  host.dataset.priceVolumeUpdateCount = String(renderCount);
  if (host.dataset.pvTopology && updatePriceVolumeInPlace(host, projection, { topologyChanged: host.dataset.pvTopology !== topology })) {
    host.dataset.pvTopology = topology;
    host.dataset.pvIdentity = identity;
    return;
  }
  const bars = buckets.map((row, index) => {
    const out = Math.max(0, Number(row?.out || 0));
    const inside = Math.max(0, Number(row?.in || 0));
    const sum = out + inside;
    const height = Math.max(sum > 0 ? 4 : 1, sum / maxVolume * 100);
    const outPct = sum > 0 ? out / sum * 100 : 0;
    const inPct = sum > 0 ? inside / sum * 100 : 0;
    const current = index === currentIndex && samePrice(row?.price, currentPrice);
    return `<div class="pv-level${current ? " pv-current" : ""}" data-price="${escapeHtml(String(row.price))}"${current ? ' data-current-trade-price="1"' : ""}>
      ${index === 0 ? '<span class="pv-extreme-marker low" aria-label="最低價">L</span>' : ""}
      ${index === buckets.length - 1 ? '<span class="pv-extreme-marker high" aria-label="最高價">H</span>' : ""}
      ${current ? '<span class="pv-current-marker" aria-label="當下成交價"></span>' : ""}
      <div class="pv-stack" style="height:${height.toFixed(2)}%">
        <i class="pv-out" style="height:${outPct.toFixed(2)}%"></i>
        <i class="pv-in" style="height:${inPct.toFixed(2)}%"></i>
      </div>
    </div>`;
  }).join("");
  const ticks = axis.map((item) => `<span class="pv-axis-tick pv-axis-${item.slot.toLowerCase()}" style="left:${item.position.toFixed(4)}%" data-price="${escapeHtml(String(item.price))}">${formatPrice(item.price)}</span>`).join("");
  host.innerHTML = `<div class="pv-chart" data-bucket-count="${projection.bucketCount}" data-domain-low="${projection.low}" data-domain-high="${projection.high}" data-focus-price="${projection.currentPrice ?? ""}" data-domain-includes-current="${projection.domainIncludesCurrent ? "1" : "0"}"><div class="pv-bars">${bars}</div><div class="pv-axis" aria-hidden="true">${ticks}</div></div>`;
  host.dataset.pvTopology = topology;
  host.dataset.pvIdentity = identity;
  host.dataset.priceVolumeTopologyCommitCount = String(Number(host.dataset.priceVolumeTopologyCommitCount || 0) + 1);
  try {
    if (globalThis.localStorage?.getItem?.("marketDiagnostics") === "1") {
      const axisPrice = (slot) => projection.axis.find((item) => item.slot === slot)?.price ?? null;
      console.debug("[TradeflowChart]", {
        stream_id: vm?.streamId || vm?.stream_id || "",
        sequence: vm?.sequence ?? vm?.streamSequence ?? vm?.stream_sequence ?? vm?.recorder_sequence ?? null,
        low: projection.low,
        lower_mid: axisPrice("LM"),
        mid: axisPrice("M"),
        upper_mid: axisPrice("UM"),
        high: projection.high,
        current_price: projection.currentPrice,
        bucket_count: projection.bucketCount,
        domain_low: projection.low,
        domain_high: projection.high,
        domain_includes_current: projection.domainIncludesCurrent,
        focus_price: projection.currentIndex >= 0 ? projection.buckets[projection.currentIndex]?.price ?? null : null,
        render_count: renderCount,
      });
    }
  } catch (error) { console.warn("[order book: depth layout] failed", error); }
}
