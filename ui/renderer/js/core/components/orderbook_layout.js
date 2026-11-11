// The book's fitted size: the font and column widths that let every level's price and quantity fit the panel, solved
// from text measured once at 20 px (no layout reads per size tried).

import { byRole as role } from "../utility.js";

// Largest size the book is drawn at.
const ORDERBOOK_MAX_FONT_PX = 28;

// The edge columns hold only the H/L marker. A diff badge takes no width: it floats from the panel's outer side inward,
// over the H/L marker and the end of the quantity cell, for its two seconds (user decision). Reserving
// a three-digit badge on each side, so the font would not jump when one showed, cost the prices and quantities
// of a 260 px book about 18% of their size.
export const ORDERBOOK_EDGE_MARKER_TEXT = "H";

// The H/L marker is drawn at this fraction of the book's font.
export const ORDERBOOK_EXTREME_FONT_RATIO = 0.86;

// Breathing room per text column so a digit never touches its cell edge.
const ORDERBOOK_TEXT_SLACK_PX = 4;

let orderbookMeasureContext = null;
/** Width of `text` drawn at 20 px in `styleNode`'s font (independent of the size anything is shown at now). */
export function orderbookTextWidthAt20(styleNode, text = styleNode?.textContent) {
  const value = String(text || "").trim();
  if (!value) return 0;
  const style = globalThis.getComputedStyle?.(styleNode);
  try {
    orderbookMeasureContext ||= globalThis.document?.createElement?.("canvas")?.getContext?.("2d") || null;
  } catch (_error) { /* not an error: no canvas text measurement here: the width is estimated below */ 
    orderbookMeasureContext = null;
  }
  if (orderbookMeasureContext) {
    orderbookMeasureContext.font = `${style?.fontWeight || "normal"} 20px ${style?.fontFamily || "sans-serif"}`;
    const width = Number(orderbookMeasureContext.measureText(value).width || 0);
    if (width > 0) return width;
  }
  // No canvas (tests): an estimate from the text, never from the element's box.
  return value.length * 11;
}

export function horizontalPadding(from, to) {
  let padding = 0;
  for (let box = from; box; box = box === to ? null : box.parentElement) {
    const style = globalThis.getComputedStyle?.(box);
    padding += (Number.parseFloat(style?.paddingLeft || "0") || 0) + (Number.parseFloat(style?.paddingRight || "0") || 0);
  }
  return padding;
}

/**
 * The book's layout from the text it shows: the largest size at which price and quantity fit their columns with a
 * little room, the edge columns hold the H/L marker (`edge20`: its width at 20 px, drawn at the marker's share of the
 * font, plus `edgePad`), and the rest of the width goes to the quantity (its bar).
 * Fixed percentage columns forced the text into whatever width they left: on a 305 px panel that was ~12 px text,
 * edge columns too narrow to show a diff, and quantities losing a third of their cell to padding.
 * Pure: `measure` gives widths at 20 px, so it is testable without a browser.
 */
export function solveOrderBookLayout({ width, rowHeight, price20, qty20, edge20 = 0, edgePad = 0, pricePad, qtyPad, edges = true }) {
  const slack = ORDERBOOK_TEXT_SLACK_PX;
  const marker20 = edges ? edge20 * ORDERBOOK_EXTREME_FONT_RATIO : 0;
  const edgeFixed = edges ? edgePad + 2 : 0;
  const fixed = 2 * (pricePad + slack) + 2 * (qtyPad + slack) + 2 * edgeFixed;
  const perPx = (2 * price20 + 2 * qty20 + 2 * marker20) / 20;
  const byWidth = perPx > 0 ? (width - fixed) / perPx : ORDERBOOK_MAX_FONT_PX;
  const font = Math.max(8, Math.min(ORDERBOOK_MAX_FONT_PX, rowHeight * 0.5, byWidth));
  const edge = edges ? marker20 * font / 20 + edgeFixed : 0;
  const price = price20 * font / 20 + pricePad + slack;
  const qty = Math.max(qty20 * font / 20 + qtyPad + slack, (width - 2 * edge - 2 * price) / 2);
  return { font, columns: { edge, price, qty } };
}

// Fits one book's rows, fonts and columns to its table: after a resize of the table (its own observer), and after an
// update whose texts could change the widths (scheduleFor(signature): only when the signature differs). One frame at a
// time; destroy() ends the observer and a frame not yet run. It writes only the --orderbook-fit-* variables and the
// column/row sizes.
export class DepthLayoutController {
  constructor(root) {
    this.root = root;
    this.frame = 0;
    this.observer = null;
    this.signature = "";
  }

  observe(tableWrap) {
    if (!tableWrap || typeof ResizeObserver === "undefined") return;
    this.observer?.disconnect?.();
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(tableWrap);
  }

  schedule() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sync();
    });
  }

  scheduleFor(signature) {
    if (signature === this.signature) return;
    this.signature = signature;
    this.schedule();
  }

  sync() {
    const root = this.root;
    if (!root) return;
    const wrap = root.querySelector?.(".orderbook-table-wrap");
    const body = role(root, "orderbook-body");
    if (!wrap || !body) return;
    const rows = [...body.querySelectorAll("tr[data-orderbook-level]")];
    if (!rows.length) return;

    const availableHeight = Number(wrap.clientHeight || 0);
    const availableWidth = Number(wrap.clientWidth || 0);
    if (!(availableHeight > 0) || !(availableWidth > 0)) return;
    // Each row also draws its cells' bottom border (collapsed borders sit outside the row's own height): without taking
    // it off, N rows were N px taller than the wrap and the last level was cut by the totals bar.
    const firstCell = rows[0].querySelector?.("td");
    const border = firstCell && typeof getComputedStyle === "function" ? Number.parseFloat(getComputedStyle(firstCell).borderBottomWidth) || 0 : 0;
    const rowHeight = Math.max(12, availableHeight / rows.length - border);
    const widest = (selector, floor = "") => {
      let node = null, width = 0;
      for (const candidate of root.querySelectorAll?.(selector) || []) {
        const w = orderbookTextWidthAt20(candidate);
        if (w >= width) { node = candidate; width = w; }
      }
      return { node, width: Math.max(width, node && floor ? orderbookTextWidthAt20(node, floor) : 0) };
    };
    const price = widest(".orderbook-price-value");
    // A quantity column is never sized below four digits, so a book that grows from 999 to 1,200 does not jump.
    const qty = widest(".orderbook-qty-text", "8,888");
    const edgeCell = rows[0]?.querySelector?.(".orderbook-extreme-cell") || null;
    const edges = Boolean(edgeCell);
    const layout = solveOrderBookLayout({
      width: availableWidth, rowHeight,
      price20: price.width, qty20: qty.width,
      edge20: edges ? orderbookTextWidthAt20(edgeCell, ORDERBOOK_EDGE_MARKER_TEXT) : 0,
      edgePad: edges ? horizontalPadding(edgeCell, edgeCell) : 0,
      pricePad: price.node ? horizontalPadding(price.node, price.node.closest?.("td")) : 8,
      qtyPad: qty.node ? horizontalPadding(qty.node, qty.node.closest?.("td")) : 8,
      edges,
    });
    const fontSize = layout.font;
    const extremeFontSize = fontSize * ORDERBOOK_EXTREME_FONT_RATIO;
    const barInset = Math.max(2, Math.min(7, rowHeight * 0.16));
    const cols = [...(root.querySelectorAll?.("col") || [])];
    const px = (value) => `${Math.max(0, value).toFixed(1)}px`;
    for (const col of cols) {
      const name = String(col.className || "");
      const w = name.includes("extreme") ? layout.columns.edge : name.includes("price") ? layout.columns.price : layout.columns.qty;
      col.style?.setProperty?.("width", px(w));
    }

    root.style.setProperty("--orderbook-fit-row-height", `${rowHeight.toFixed(2)}px`);
    root.style.setProperty("--orderbook-fit-font-size", `${fontSize.toFixed(2)}px`);
    root.style.setProperty("--orderbook-fit-extreme-font-size", `${extremeFontSize.toFixed(2)}px`);
    root.style.setProperty("--orderbook-fit-bar-inset", `${barInset.toFixed(2)}px`);
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.observer?.disconnect?.();
    this.observer = null;
    this.signature = "";
    this.root = null;
  }
}
