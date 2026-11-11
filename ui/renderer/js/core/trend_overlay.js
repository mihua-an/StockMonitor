import { EQUITY_TIME_AXIS } from "./trend/time_axis_policy.js";
import { numberOrNull } from "./numbers.js";
import { themeColor } from "./market_palette.js";

// A point's x coordinate is the TimeAxisPolicy's (09:00/13:30 arithmetic lives there only).
function axisMinute(point, timeAxisPolicy) {
  const mapped = timeAxisPolicy?.coordinateForPoint?.(point, 0, 1);
  return Number.isFinite(mapped) ? mapped : null;
}

function positiveOrNull(value) {
  const number = numberOrNull(value);
  return number != null && number > 0 ? number : null;
}

// A benchmark (加權 / 期貨) on a stock's price axis: each minute's change from the benchmark's own 昨收 (reference
// price), applied to the stock's 昨收. The stock chart's axis is centered on that same 昨收, so a stock and its
// benchmark that moved the same percentage sit at the same height, and a benchmark is never drawn past the stock's
// own limits for a move the benchmark did not make. Without either reference there is no common baseline: no series.
export function projectBenchmarkSeries({
  rawPoints = [],
  stockReference = null,
  benchmarkReference = null,
  strokeStyle = themeColor("--chart-series"),
  lineWidth = 2,
  alpha = 0.95,
  targetTimeAxisPolicy = EQUITY_TIME_AXIS,
} = {}) {
  const raw = Array.isArray(rawPoints) ? rawPoints : [];
  if (raw.length < 2) return null;
  const stockBase = positiveOrNull(stockReference);
  const benchmarkBase = positiveOrNull(benchmarkReference);
  if (stockBase == null || benchmarkBase == null) return null;

  const projected = raw.map((point) => {
    const price = numberOrNull(point?.price ?? point?.close ?? point?.current);
    const minute = axisMinute(point, targetTimeAxisPolicy);
    if (price == null || minute == null) return null;
    const changeFromReference = (price - benchmarkBase) / benchmarkBase;
    return { minute, price: stockBase * (1 + changeFromReference) };
  }).filter(Boolean);
  // Snapshot history and live updates may overlap or arrive out of order.
  // Draw each time coordinate once, in chronological order, without retracing.
  const points = [...new Map(projected.map(point => [point.minute, point])).values()]
    .sort((a, b) => a.minute - b.minute);

  if (points.length < 2) return null;
  return { points, strokeStyle, lineWidth, alpha };
}
