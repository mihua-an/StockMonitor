// Event-marker layout and drawing for the trend canvas.
//
// 歷史事件標記採「全域碰撞排版」。事件文字框、最高/最低價格標籤、圖框邊界都會一起參與排版；
// 若畫面真的塞不下，低優先事件只保留事件點，不硬塞文字框。
import { formatChartPrice } from "../utility.js";
import { themeColor } from "../market_palette.js";

const LABEL_PADDING = 4;
const BOX_GAP = 5;
const VERTICAL_OFFSETS = [20, 40, 60, 80, 100, 120, 140];

const overlaps = (a, b, padding = BOX_GAP) => !(
  a.right + padding < b.left
  || a.left - padding > b.right
  || a.bottom + padding < b.top
  || a.top - padding > b.bottom
);

const pointInsideRect = (x, y, rect, padding = 0) => (
  x >= rect.left - padding
  && x <= rect.right + padding
  && y >= rect.top - padding
  && y <= rect.bottom + padding
);

const orientation = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function segmentsCross(a1, a2, b1, b2) {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))
    && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function leaderCrossCount(segments, usedLeaderSegments) {
  let count = 0;
  for (const segment of segments) {
    for (const used of usedLeaderSegments) {
      if (segmentsCross(segment.a, segment.b, used.a, used.b)) count += 1;
    }
  }
  return count;
}

// A leader line passing through an existing label box (point samples along each segment).
function leaderHitsBoxes(leaderSegments, occupiedLabelBoxes) {
  return occupiedLabelBoxes
    .filter((used) => used.kind !== "extrema-point")
    .some((used) => leaderSegments.some((segment) => {
      const samples = 8;
      for (let i = 1; i < samples; i += 1) {
        const ratio = i / samples;
        const sx = segment.a.x + (segment.b.x - segment.a.x) * ratio;
        const sy = segment.a.y + (segment.b.y - segment.a.y) * ratio;
        if (pointInsideRect(sx, sy, used, 1)) return true;
      }
      return false;
    }));
}

// The same bar-extreme marks the chart draws, so the reserved boxes sit where they are.
function extremaReservedBoxes(ctx, frame) {
  const { barHigh, barLow, points, plotBottom, plotLeft, plotRight, plotTop, xFromMinute, yFromPrice } = frame;
  if (!points.length) return [];
  const highPoint = points.reduce((best, point) => {
    const candidate = { minute: point.minute, price: barHigh(point) };
    return !best || candidate.price > best.price ? candidate : best;
  }, null);
  const lowPoint = points.reduce((best, point) => {
    const candidate = { minute: point.minute, price: barLow(point) };
    return !best || candidate.price < best.price ? candidate : best;
  }, null);
  const result = [];
  ctx.save();
  ctx.font = 'bold 12px "Microsoft JhengHei", sans-serif';
  const reserve = (point, placeAbove) => {
    if (!point) return;
    const x = xFromMinute(point.minute);
    const y = yFromPrice(point.price);
    const textWidth = Math.ceil(ctx.measureText(formatChartPrice(point.price)).width);
    const drawLeft = (plotRight - x) < textWidth + 12;
    const left = drawLeft ? x - 7 - textWidth : x + 7;
    const top = placeAbove ? y - 22 : y + 5;
    result.push({
      left: Math.max(plotLeft, left - 2),
      right: Math.min(plotRight, left + textWidth + 2),
      top: Math.max(plotTop, top - 2),
      bottom: Math.min(plotBottom, top + 18),
      kind: "extrema-label",
    });
    // 最高/最低點本身也保留一個小禁區，避免事件文字框直接壓在圓點上。
    result.push({ left: x - 7, right: x + 7, top: y - 7, bottom: y + 7, kind: "extrema-point" });
  };
  reserve(highPoint, true);
  if (lowPoint && highPoint && (lowPoint.minute !== highPoint.minute || lowPoint.price !== highPoint.price)) {
    reserve(lowPoint, false);
  }
  ctx.restore();
  return result;
}

// Whether the price line passes through a box. The trend's screen points are sorted by x once, so a candidate box
// looks only at the points inside its own x span (a marker has ~98 candidates; scanning every
// trend point for each is too slow).
function trendHitTester({ points, xFromMinute, yFromPrice }) {
  const trendScreenPoints = points.map((point) => ({ x: xFromMinute(point.minute), y: yFromPrice(point.price) }))
    .sort((left, right) => left.x - right.x);
  const firstAtOrAfter = (x) => {
    let low = 0;
    let high = trendScreenPoints.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (trendScreenPoints[mid].x < x) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  // 只要價格線實際穿過文字框，就視為候選位置不佳。用點取樣即可避免大多數「文字直接蓋住走勢」的情況。
  return (box) => {
    for (let i = firstAtOrAfter(box.left - 2); i < trendScreenPoints.length; i += 1) {
      const point = trendScreenPoints[i];
      if (point.x > box.right + 2) break;
      if (pointInsideRect(point.x, point.y, box, 2)) return true;
    }
    return false;
  };
}

// Each drawable marker with its position and label box size, in placement order: 被點選的事件永遠先拿位置；其後才依
// 重要性安排。同優先級維持時間順序，讓畫面不會每次重畫都跳位置。
function prepareMarkers(ctx, { axisSpan, eventMarkers, timeAxisPolicy, xFromMinute, yFromPrice }) {
  const prepared = eventMarkers.map((marker, markerIndex) => {
    const minute = timeAxisPolicy.coordinateForTime(marker?.timestamp ?? marker?.datetime ?? marker?.time);
    const price = Number(marker?.price);
    if (!Number.isFinite(minute) || minute < 0 || minute > axisSpan || !Number.isFinite(price)) return null;
    const rawLabel = String(marker?.label || "事件").trim() || "事件";
    const label = rawLabel.length > 14 ? `${rawLabel.slice(0, 13)}…` : rawLabel;
    const selected = Boolean(marker?.selected);
    ctx.font = `${selected ? "900" : "700"} 10px "Microsoft JhengHei", sans-serif`;
    const textWidth = Math.ceil(ctx.measureText(label).width);
    return {
      marker, markerIndex, minute, price,
      x: xFromMinute(minute), y: yFromPrice(price),
      rawLabel, label, selected,
      priority: Number(marker?.priority) || 0,
      placement: String(marker?.placement || "auto"),
      color: String(marker?.color || themeColor("--chart-marker")),
      boxWidth: textWidth + 10,
      boxHeight: 17,
    };
  }).filter(Boolean);
  prepared.sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.minute !== b.minute) return a.minute - b.minute;
    return a.markerIndex - b.markerIndex;
  });
  return prepared;
}

// The side tried first: the marker's own placement, else away from the middle; near the frame's top/bottom edge
// the other side is preferred before anything is squeezed.
function preferredSide(item, { plotTop, plotBottom, plotHeight }) {
  let preferAbove = item.placement === "above" ? true
    : item.placement === "below" ? false
      : item.y > plotTop + plotHeight * 0.48;
  const roomAbove = item.y - plotTop;
  const roomBelow = plotBottom - item.y;
  if (preferAbove && roomAbove < item.boxHeight + 26 && roomBelow > roomAbove) preferAbove = false;
  if (!preferAbove && roomBelow < item.boxHeight + 26 && roomAbove > roomBelow) preferAbove = true;
  return preferAbove;
}

// One candidate box (side, vertical offset, horizontal shift) with its leader, or null when it is not allowed.
function candidatePlacement(item, { above, offset, shift }, frame, placed, touchesTrend) {
  const { plotBottom, plotLeft, plotRight, plotTop } = frame;
  const boxX = Math.max(plotLeft + 2, Math.min(plotRight - item.boxWidth - 2, item.x + shift - item.boxWidth / 2));
  const boxY = above ? item.y - offset - item.boxHeight : item.y + offset;
  const box = { left: boxX, right: boxX + item.boxWidth, top: boxY, bottom: boxY + item.boxHeight };
  if (box.top < plotTop + 2 || box.bottom > plotBottom - 2) return null;
  if (placed.boxes.some((used) => overlaps(box, used))) return null;
  // 避免事件文字框直接壓住走勢線；選中的事件可稍微放寬，確保一定看得到。
  const hitsTrend = touchesTrend(box);
  if (hitsTrend && !item.selected) return null;
  const targetY = above ? box.bottom : box.top;
  const targetX = Math.max(box.left + LABEL_PADDING, Math.min(box.right - LABEL_PADDING, item.x));
  const elbow = { x: item.x, y: targetY };
  const leaderSegments = [
    { a: { x: item.x, y: item.y }, b: elbow },
    { a: elbow, b: { x: targetX, y: targetY } },
  ].filter((segment) => Math.abs(segment.a.x - segment.b.x) > 0.5 || Math.abs(segment.a.y - segment.b.y) > 0.5);
  // 線段如果穿過既有文字框也不接受。
  if (leaderHitsBoxes(leaderSegments, placed.boxes)) return null;
  return { box, boxX, boxY, above, targetX, targetY, leaderSegments, hitsTrend };
}

// The best allowed position for one label, or null (塞不下). X 不固定在事件點正中央：依標籤實際寬度左右錯位，並保留
// 正中央候選 -- 解掉密集事件「一柱香」的關鍵。
function placeLabel(item, frame, placed, touchesTrend) {
  const preferAbove = preferredSide(item, frame);
  const horizontalStep = Math.max(28, Math.min(72, item.boxWidth * 0.82));
  const horizontalShifts = [0, -horizontalStep, horizontalStep, -horizontalStep * 2, horizontalStep * 2,
    -horizontalStep * 3, horizontalStep * 3];
  let best = null;
  [preferAbove, !preferAbove].forEach((above, sideIndex) => {
    for (const offset of VERTICAL_OFFSETS) {
      horizontalShifts.forEach((shift, shiftIndex) => {
        const candidate = candidatePlacement(item, { above, offset, shift }, frame, placed, touchesTrend);
        if (!candidate) return;
        const score = sideIndex * 1000
          + leaderCrossCount(candidate.leaderSegments, placed.leaders) * 180
          + offset
          + Math.abs(shift) * 0.22
          + shiftIndex * 0.5
          + (candidate.hitsTrend ? 120 : 0);
        if (!best || score < best.score) {
          const { hitsTrend: _hitsTrend, ...layout } = candidate;
          best = { ...layout, score };
        }
      });
    }
  });
  return best;
}

// 先畫所有事件點，確保即使文字被省略仍看得到事件發生位置。
function drawMarkerDots(ctx, layouts) {
  layouts.slice().sort((a, b) => a.minute - b.minute).forEach((layout) => {
    // A marker may ask for its leader line and label only (the live 個股走勢 盤中事件 markers).
    if (layout.marker?.dot === false) return;
    ctx.fillStyle = layout.color;
    ctx.strokeStyle = layout.selected ? themeColor("--chart-marker-selected") : themeColor("--chart-marker-outline");
    ctx.lineWidth = layout.selected ? 2.5 : 1.25;
    ctx.beginPath();
    ctx.arc(layout.x, layout.y, layout.selected ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}

// 再畫 leader + label。低優先且塞不下的事件只有點，不會再製造重疊框。
function drawMarkerLabels(ctx, layouts) {
  layouts
    .filter((layout) => layout.showLabel)
    .sort((a, b) => (a.selected === b.selected ? a.minute - b.minute : a.selected ? 1 : -1))
    .forEach((layout) => {
      ctx.strokeStyle = layout.selected ? themeColor("--chart-marker-selected-ring") : layout.color;
      ctx.lineWidth = layout.selected ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(layout.x, layout.y);
      layout.leaderSegments.forEach((segment) => ctx.lineTo(segment.b.x, segment.b.y));
      ctx.stroke();

      ctx.fillStyle = themeColor("--chart-marker-label-bg");
      ctx.strokeStyle = layout.selected ? themeColor("--chart-marker-selected-ring") : layout.color;
      ctx.lineWidth = layout.selected ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(layout.boxX, layout.boxY, layout.boxWidth, layout.boxHeight, 4);
      ctx.fill();
      ctx.stroke();

      ctx.font = `${layout.selected ? "900" : "700"} 10px "Microsoft JhengHei", sans-serif`;
      ctx.fillStyle = layout.selected ? themeColor("--chart-marker-selected") : layout.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(layout.label, layout.boxX + layout.boxWidth / 2, layout.boxY + layout.boxHeight / 2 + 0.5);
    });
}

/**
 * Lays out and draws `frame.eventMarkers` on `ctx` inside the plot. `frame` carries the plot geometry and the
 * coordinate functions renderTrendCanvas computed for this frame.
 */
export function drawEventMarkers(ctx, frame) {
  const { eventMarkers, plotHeight, plotLeft, plotTop, plotWidth } = frame;
  if (!eventMarkers.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
  ctx.clip();

  const placed = { boxes: extremaReservedBoxes(ctx, frame), leaders: [] };
  const touchesTrend = trendHitTester(frame);
  const layouts = prepareMarkers(ctx, frame).map((item) => {
    const best = placeLabel(item, frame, placed, touchesTrend);
    if (!best) {
      // 真正塞不下時不再硬塞。事件點仍保留；被選中的事件因為第一個排，一般情況下都能取得合法位置。
      return { ...item, showLabel: false };
    }
    placed.boxes.push({ ...best.box, kind: "event-label" });
    placed.leaders.push(...best.leaderSegments);
    return { ...item, ...best, showLabel: true };
  });
  drawMarkerDots(ctx, layouts);
  drawMarkerLabels(ctx, layouts);
  ctx.restore();
}
