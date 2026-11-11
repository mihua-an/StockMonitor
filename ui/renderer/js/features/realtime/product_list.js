import { escapeHtml } from "../../core/utility.js";
import { columnSettingsButtonHtml } from "../../core/components/column_settings_editor.js";
import { buildCellRow, patchCellRow } from "../../core/cell_patch.js";
import { enableCompleteRowDataGridScroll } from "../../core/data_grid.js";
import { renderPanelTabs } from "../../core/panel_tabs.js";
import { componentUpdated } from "../../core/market_render_trace.js";

// Everything a tab strip binds -- its ResizeObserver, wheel/pointer listeners and the pending rAF -- per host, so the
// owner's teardown ends all of it: disposeProductPageTabs(host).
const tabRails = new WeakMap();

function railBinding(host) {
  let binding = tabRails.get(host);
  if (!binding) {
    // geometry/setOffset are installed by ensureProductPageScrollRail; every input path (drag, track click, wheel,
    // resize) reads the same ones.
    binding = { controller: new AbortController(), observer: null, frame: 0, wheel: false, geometry: null, setOffset: null };
    tabRails.set(host, binding);
  }
  return binding;
}

/** Ends what renderProductPageTabs bound on `host`. Safe to call for a host that was never rendered. */
export function disposeProductPageTabs(host) {
  const binding = host ? tabRails.get(host) : null;
  if (!binding) return;
  tabRails.delete(host);
  binding.controller.abort();
  binding.observer?.disconnect();
  if (binding.frame) cancelAnimationFrame(binding.frame);
}

// The strip takes the header's width left of the tool buttons, so its own width is the visible tab viewport.
function tabViewportGeometry(host, content) {
  const viewportWidth = host.clientWidth;
  return { viewportWidth, maxOffset: Math.max(0, content.scrollWidth - viewportWidth) };
}

function ensureProductPageScrollRail(host, content) {
  const strip = host?.closest?.(".product-list-header") || null;
  if (!strip || !content) return null;

  let rail = Array.from(strip.children).find((child) => child.classList?.contains("product-list-pages-rail")) || null;
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "product-list-pages-rail";
    rail.setAttribute("aria-hidden", "true");
    rail.innerHTML = '<div class="product-list-pages-thumb"></div>';
    strip.appendChild(rail);
  }

  const thumb = rail.firstElementChild;
  const geometry = () => tabViewportGeometry(host, content);
  const setOffset = (value) => {
    const { viewportWidth, maxOffset } = geometry();
    const offset = Math.max(0, Math.min(maxOffset, Number(value) || 0));
    host.dataset.productScrollOffset = String(offset);
    content.style.transform = `translateX(${-offset}px)`;
    return { offset, maxOffset, viewportWidth };
  };
  const sync = () => {
    const current = setOffset(host.dataset.productScrollOffset || 0);
    const maxScroll = current.maxOffset;
    const trackWidth = Math.max(0, rail.clientWidth);
    rail.hidden = trackWidth <= 0;
    if (rail.hidden) return;
    const thumbWidth = maxScroll <= 0
      ? trackWidth
      : Math.max(28, Math.min(trackWidth, trackWidth * current.viewportWidth / content.scrollWidth));
    const travel = Math.max(0, trackWidth - thumbWidth);
    const left = maxScroll > 0 ? travel * current.offset / maxScroll : 0;
    thumb.style.width = `${thumbWidth}px`;
    thumb.style.transform = `translateX(${left}px)`;
  };

  const binding = railBinding(host);
  binding.geometry = geometry;
  binding.setOffset = (value) => {
    setOffset(value);
    sync();
  };
  const { signal } = binding.controller;
  if (!binding.observer) {
    binding.observer = new ResizeObserver(sync);
    binding.observer.observe(host);

    rail.addEventListener("pointerdown", (event) => {
      if (event.target === thumb) return;
      const rect = rail.getBoundingClientRect();
      const maxScroll = binding.geometry().maxOffset;
      if (rect.width <= 0 || maxScroll <= 0) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      binding.setOffset(ratio * maxScroll);
    }, { signal });

    thumb.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startScroll = Number(host.dataset.productScrollOffset || 0);
      thumb.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        const maxScroll = binding.geometry().maxOffset;
        const travel = Math.max(1, rail.clientWidth - thumb.offsetWidth);
        binding.setOffset(startScroll + (moveEvent.clientX - startX) * maxScroll / travel);
      };
      const finish = () => {
        thumb.removeEventListener("pointermove", move);
        thumb.removeEventListener("pointerup", finish);
        thumb.removeEventListener("pointercancel", finish);
      };
      // Also ended by the strip's teardown in the middle of a drag.
      thumb.addEventListener("pointermove", move, { signal });
      thumb.addEventListener("pointerup", finish, { signal });
      thumb.addEventListener("pointercancel", finish, { signal });
    }, { signal });
  }

  if (binding.frame) cancelAnimationFrame(binding.frame);
  binding.frame = requestAnimationFrame(() => { binding.frame = 0; sync(); });
  return rail;
}

function productPageSnapOffsets(content, maxOffset) {
  const limit = Math.max(0, Number(maxOffset) || 0);
  const offsets = [0];
  for (const tab of Array.from(content?.children || [])) {
    const offset = Math.max(0, Math.min(limit, Number(tab?.offsetLeft) || 0));
    if (Math.abs(offset - offsets[offsets.length - 1]) > 0.5) offsets.push(offset);
  }
  if (Math.abs(limit - offsets[offsets.length - 1]) > 0.5) offsets.push(limit);
  return offsets;
}

function adjacentProductPageOffset(content, currentOffset, maxOffset, direction) {
  const current = Math.max(0, Math.min(maxOffset, Number(currentOffset) || 0));
  const offsets = productPageSnapOffsets(content, maxOffset);
  if (direction > 0) return offsets.find((offset) => offset > current + 0.5) ?? maxOffset;
  return [...offsets].reverse().find((offset) => offset < current - 0.5) ?? 0;
}

/** Shared variable-width, one-product-page-per-wheel-step navigation. */
export function enableSharedProductPageWheelSnap(host, content) {
  if (!host || !content) return;
  const binding = railBinding(host);
  if (binding.wheel) return;
  binding.wheel = true;
  host.addEventListener("wheel", (event) => {
    const wheelDelta = event.shiftKey
      ? (event.deltaY || event.deltaX)
      : (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX);
    if (!Number.isFinite(wheelDelta) || wheelDelta === 0) return;
    if (!binding.geometry) return;  // a host outside a product-list strip has no rail to scroll
    const maxScroll = binding.geometry().maxOffset;
    if (maxScroll <= 0) return;
    const current = Number(host.dataset.productScrollOffset || 0);
    const next = adjacentProductPageOffset(content, current, maxScroll, Math.sign(wheelDelta));
    if (next === current) return;
    event.preventDefault();
    binding.setOffset(next);
  }, { passive: false, signal: binding.controller.signal });
}

/**
 * Shared viewport/scroll contract for 商品列表 and 商品列表-A.
 * The visible vertical rail maps its thumb to a logical first-row index; the
 * native viewport remains only as the horizontal scrolling engine.
 */
export function enableSharedProductListScroll(root = document) {
  const table = root?.querySelector?.('[data-role="product-list-table"]') || null;
  const wrapper = table?.closest?.(".product-list-table-wrap") || null;
  if (!wrapper) return { grid: null, rowSnap: null, viewport: null };
  wrapper.dataset.standardGridStableColumns = "1";
  return enableCompleteRowDataGridScroll(wrapper, {
    rowHeightVar: "--row-height-watchlist",
    wheelStepRows: 1,
    discreteRail: true,
    minRowHeightVar: "--row-height-watchlist-min",
    maxRowHeightVar: "--row-height-watchlist-max",
  });
}

// row key -> <tr> of each product body, kept by the one writer of those rows (renderProductListRows) so an update
// finds its row without scanning the table. Rebuilt from the DOM when the body holds something else (the static
// shell's placeholder, the empty-state row).
const productRowIndex = new WeakMap();

// A row's identity: its code, and for a code listed again its occurrence (the second 2330 is "2330", 1). The index,
// the rows kept by a render and the DOM rebuild all use this one key, so every listing keeps its own row.
function productRowKey(code, occurrence) {
  return occurrence ? `${code}\u0000${occurrence}` : code;
}

function productRowsByCode(body, codeAttribute) {
  let index = productRowIndex.get(body);
  if (!index || index.attribute !== codeAttribute || index.rows.size !== body.children.length) {
    index = { attribute: codeAttribute, rows: new Map() };
    const occurrences = new Map();
    for (const node of body.children) {
      if (!node.hasAttribute(codeAttribute)) continue;
      const code = node.getAttribute(codeAttribute);
      const occurrence = occurrences.get(code) || 0;
      occurrences.set(code, occurrence + 1);
      index.rows.set(productRowKey(code, occurrence), node);
    }
    productRowIndex.set(body, index);
  }
  return index;
}

/**
 * Shared product-list body renderer for broker-specific quote domains. `cellsOf(row)` returns the row's cells as
 * data (core/cell_patch.js); a row is built once and later only its changed text and classes are written.
 * Returns the <tr>s it wrote (built, patched or given another class) when only the changed codes were drawn, or null
 * when every row was (a topology change, or no changed codes given).
 */
export function renderProductListRows({
  body, rows = [], columnCount = 1, emptyText = "尚無商品",
  codeOf = (row) => row?.code, classOf = () => "", cellsOf,
  codeAttribute = "data-product-code",
  changedCodes = null, topologyChanged = false,
  provider = "shioaji",
  // Lineage only. The arrival of the event that dirtied these rows, so the product row can be
  // measured as a Tick destination like the trade table and the trend already are.
  trace = null,
} = {}) {
  if (!body) return;
  if (!Array.isArray(rows) || !rows.length) {
    const empty = body.ownerDocument.createElement("tr");
    const td = body.ownerDocument.createElement("td");
    td.colSpan = Math.max(1, Number(columnCount) || 1);
    td.className = "empty";
    td.textContent = String(emptyText || "");
    empty.appendChild(td);
    body.replaceChildren(empty);
    productRowIndex.delete(body);
    if (body.isConnected && body.dataset) componentUpdated("product_list", { provider, code: "watchlist", trace }, body);
    return null;
  }
  const index = productRowsByCode(body, codeAttribute);
  if (!index.rows.size && body.children.length) body.replaceChildren();
  const kept = new Map();
  const occurrences = new Map();
  const written = [];
  rows.forEach((row, position) => {
    const code = String(codeOf(row) || "");
    const occurrence = occurrences.get(code) || 0;
    occurrences.set(code, occurrence + 1);
    const key = productRowKey(code, occurrence);
    let node = index.rows.get(key);
    const className = String(classOf(row) || "");
    const dirty = topologyChanged || !node || !(changedCodes instanceof Set) || changedCodes.has(code);
    let wrote = dirty;
    if (!node) node = buildCellRow(cellsOf(row), { className, attributes: { [codeAttribute]: code } });
    else if (dirty) patchCellRow(node, cellsOf(row));
    if (node.className !== className) { node.className = className; wrote = true; }
    if (body.children[position] !== node) body.insertBefore(node, body.children[position] || null);
    if (wrote) written.push(node);
    kept.set(key, node);
  });
  for (const [key, node] of index.rows) if (kept.get(key) !== node) node.remove();
  index.rows = kept;
  if (body.isConnected && body.dataset) componentUpdated("product_list", { provider, code: "watchlist", trace }, body);
  return topologyChanged || !(changedCodes instanceof Set) ? null : written;
}

/** Shared 商品列表 shell. Broker pages keep separate data/events, not separate UI. */
export function productListShellMarkup({ ariaLabel = "商品頁", provider = "shioaji" } = {}) {
  const source = String(provider || "shioaji").trim().toLowerCase() === "futu" ? "futu" : "shioaji";
  return `<div class="product-list" data-provider="${source}"><div class="tab-strip product-list-header">
    <div data-role="product-list-pages" data-provider="${source}" class="tab-list product-list-pages" role="tablist" aria-label="${escapeHtml(ariaLabel)}"></div>
    <div class="product-list-tools" data-role="product-list-tools">
      ${columnSettingsButtonHtml({ label: "設定商品列表欄位", attributes: `data-role="product-column-settings" data-provider="${source}"` })}
      <button data-role="product-page-edit" data-provider="${source}" class="product-list-tool-btn" type="button" aria-label="編輯商品頁">✎</button>
    </div>
  </div>
  <div class="table-wrap-plain product-list-table-wrap">
    <table data-role="product-list-table" data-provider="${source}" class="product-list-table lined-rows">
      <thead><tr></tr></thead>
      <tbody data-role="product-list-body" data-provider="${source}"><tr><td class="empty">尚無資料</td></tr></tbody>
    </table>
  </div>
  <div data-role="product-list-cards" class="product-list-cards" role="listbox" aria-label="${escapeHtml(ariaLabel)}"></div></div>`;
}

/** Shared 商品頁 tab renderer. Broker adapters only supply pages and events. */
export function renderProductPageTabs(host, {
  systemPages = [], overview = null, pages = [], activePageId = "overview", onSelect = null, loadError = "",
} = {}) {
  // Both broker product lists use the same scrolling/spacing contract (the shell's strip clips, no scrollbar).
  let content = host?.querySelector?.(":scope > .product-list-pages-content") || null;
  if (host && !content) {
    content = document.createElement("div");
    content.className = "product-list-pages-content panel-tabs-dense";
    host.replaceChildren(content);
  }
  enableSharedProductPageWheelSnap(host, content);
  const tabs = [...(Array.isArray(systemPages) ? systemPages : []), overview, ...(Array.isArray(pages) ? pages : [])].filter(Boolean);
  renderPanelTabs(content, {
    tabs,
    activeKey: String(activePageId || "overview"),
    keyOf: (page) => String(page?.id || ""),
    labelOf: (page) => page?.name || page?.id || "",
    countOf: (page) => Number(page?.count ?? page?.codes?.length ?? page?.items?.length ?? 0),
    onSelect: (key) => onSelect?.(String(key || "")),
    scrollActive: false,
  });
  // One notice after the tabs while the watch pages cannot be read, none once they can.
  let notice = host?.querySelector?.(":scope > .product-list-pages-error") || null;
  if (host && loadError) {
    if (!notice) {
      notice = document.createElement("span");
      notice.className = "product-list-pages-error";
      notice.textContent = "自訂商品頁讀取失敗";
      host.appendChild(notice);
    }
  } else notice?.remove();
  ensureProductPageScrollRail(host, content);
}
