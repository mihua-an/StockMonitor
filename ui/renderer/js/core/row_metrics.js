// Row geometry as pure arithmetic: which row a scroll offset shows, and how many whole rows a viewport holds.
// No DOM: the row-snap controller and the discrete scrollbar compute their positions through these.
import { clamp } from "./utility.js";

export function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}


// Canonical row-index math shared by wheel, thumb, keyboard and programmatic
// scrolling. Pixel offsets are never a public state: divide by the rendered
// row pitch, choose the nearest logical row, then project back to rowPitch * i.

export function rowIndexFromScrollOffset(scrollTop, rowPitch, maxIndex = Number.POSITIVE_INFINITY) {
  const pitch = Math.max(1, finite(rowPitch, 1));
  const rawIndex = Math.round(Math.max(0, finite(scrollTop, 0)) / pitch);
  const finiteMax = Number.isFinite(Number(maxIndex)) ? Math.max(0, Math.trunc(Number(maxIndex))) : rawIndex;
  return clamp(rawIndex, 0, finiteMax);
}

// Complete-row metric of a fixed-pitch (non-adaptive) list. Adaptive DataGrid lists use
// distributedRowViewportMetrics() below so the remainder is
// shared across rows instead of becoming a blank strip.
export function completeRowViewportMetrics(availableHeight, rowPitch, logicalRows = 0) {
  const pitch = Math.max(1, finite(rowPitch, 1));
  const available = Math.max(0, finite(availableHeight, 0));
  const rows = Math.max(0, Math.trunc(finite(logicalRows, 0)));
  const visibleRows = Math.max(1, Math.floor((available + 0.01) / pitch));
  const alignedHeight = visibleRows * pitch;
  const remainder = Math.max(0, available - alignedHeight);
  const maxIndex = Math.max(0, rows - visibleRows);
  return {
    rowPitch: pitch,
    availableHeight: available,
    visibleRows,
    alignedHeight,
    remainder,
    logicalRows: rows,
    maxIndex,
    maxScroll: maxIndex * pitch,
  };
}

// Adaptive complete-row layout. The viewport keeps its full panel height and
// only the row pitch changes. `frameHeight` is the body's inner border-box
// height; the *actual* horizontal scrollbar lane is subtracted before deciding
// how many whole rows fit. Any remaining pixels are distributed evenly across
// those rows, bounded by min/max so a resize never creates absurdly short/tall
// records. This is pure arithmetic and is safe to reuse without DOM reads.
export function distributedRowViewportMetrics({
  frameHeight,
  horizontalScrollbarHeight = 0,
  preferredRowPitch,
  minRowPitch,
  maxRowPitch,
  logicalRows = 0,
} = {}) {
  const frame = Math.max(0, finite(frameHeight, 0));
  const scrollbar = clamp(Math.max(0, finite(horizontalScrollbarHeight, 0)), 0, frame);
  const available = Math.max(0, frame - scrollbar);
  const preferred = Math.max(1, finite(preferredRowPitch, 28));
  const minPitch = Math.max(1, finite(minRowPitch, preferred));
  const maxPitch = Math.max(minPitch, finite(maxRowPitch, Math.max(minPitch, preferred + 6)));
  const rows = Math.max(0, Math.trunc(finite(logicalRows, 0)));

  // Preserve the established "how many rows fit at the preferred size" rule.
  // If the leftover would push rows above max, admit one more row when doing so
  // stays above min. This is the only boundary correction required.
  // Row geometry is a viewport property, not a data-volume property.  Do NOT
  // shrink the capacity to the current number of records: live Tick/Event lists
  // grow one row at a time and tying rowPitch to logicalRows would resize every
  // visible row on every incoming event.  That was the main source of the
  // dashboard-wide jitter when the upper quote list and lower trade list were
  // both mounted.  Keep a stable viewport capacity; row count only affects the
  // logical max scroll index below.
  let visibleRows = Math.max(1, Math.floor((available + 0.01) / preferred));
  let targetPitch = available > 0 ? available / Math.max(1, visibleRows) : preferred;
  if (targetPitch > maxPitch) {
    const rowsForMax = Math.max(1, Math.ceil(available / maxPitch));
    if (rowsForMax > visibleRows && available / rowsForMax >= minPitch) {
      visibleRows = rowsForMax;
      targetPitch = available / visibleRows;
    }
  }
  // Chromium lays boxes out in 1/64 px units: a row given 33.1667px is laid out at 33.15625px. The pitch is the laid-out
  // value, so scrolling by it stays on the rows however deep the list goes.
  const rowPitch = Math.floor(clamp(targetPitch || preferred, minPitch, maxPitch) * 64) / 64;
  const alignedHeight = visibleRows * rowPitch;
  const remainder = Math.max(0, available - alignedHeight);
  const maxIndex = Math.max(0, rows - visibleRows);
  return {
    rowPitch,
    preferredRowPitch: preferred,
    minRowPitch: minPitch,
    maxRowPitch: maxPitch,
    frameHeight: frame,
    horizontalScrollbarHeight: scrollbar,
    availableHeight: available,
    visibleRows,
    alignedHeight,
    remainder,
    logicalRows: rows,
    maxIndex,
    maxScroll: maxIndex * rowPitch,
  };
}

// ---- Rows of different heights (RowStopController): every resting position is a row's top, its "stop". `stops` are
// the rows' tops in the list, ascending, each already within the list's maximum scroll.

/** The index of the stop the list rests on or has passed at `offset` (the last stop not below it); -1 with no stops. */
export function rowStopIndex(stops, offset) {
  let index = -1;
  for (let at = 0; at < stops.length; at += 1) {
    if (stops[at] <= offset + 0.5) index = at;
    else break;
  }
  return index;
}

/** Where `rows` rows down (positive) or up (negative) from `offset` rests. Between two stops, one row up is the top
 * of the row the list is in, not the one above it. */
export function rowStopTarget(stops, offset, rows) {
  if (!stops.length || !rows) return offset;
  const index = Math.max(0, rowStopIndex(stops, offset));
  const between = offset > stops[index] + 0.5;
  const next = rows > 0 ? index + rows : index + rows + (between ? 1 : 0);
  return stops[Math.max(0, Math.min(stops.length - 1, next))];
}

/** The stop nearest `offset` (a dragged scrollbar settles there). */
export function nearestRowStop(stops, offset) {
  return stops.reduce((best, stop) => (Math.abs(stop - offset) < Math.abs(best - offset) ? stop : best), stops[0] ?? offset);
}

// A row taller than the view (an open 配對回放 under its trade) cannot be seen from one stop: between its top and the
// offset where its bottom meets the view's bottom the list scrolls freely, a pixel step at a time, and rests anywhere.
// `ranges` are those spans, [{ from, to }] ascending; `to` is a stop too, so the next row step leaves the row.

/** The free span `offset` lies in (ends included), or null. */
export function rowStopFreeRange(ranges, offset) {
  return ranges.find((range) => offset >= range.from - 0.5 && offset <= range.to + 0.5) || null;
}

/** Where a step of `rows` rows from `offset` rests: inside a free span `rows * pixels` within it, else a row stop. */
export function rowStopStep(stops, ranges, offset, rows, pixels = 100) {
  if (!rows) return offset;
  const inside = ranges.find((range) => (rows > 0
    ? offset >= range.from - 0.5 && offset < range.to - 0.5
    : offset > range.from + 0.5 && offset <= range.to + 0.5));
  if (inside) return rows > 0 ? Math.min(inside.to, offset + rows * pixels) : Math.max(inside.from, offset + rows * pixels);
  return rowStopTarget(stops, offset, rows);
}

/** Where a dragged scrollbar settles: anywhere inside a free span, else the nearest stop. */
export function rowStopSettle(stops, ranges, offset) {
  return rowStopFreeRange(ranges, offset) ? offset : nearestRowStop(stops, offset);
}
