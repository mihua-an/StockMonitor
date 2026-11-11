import { positiveNumberOrNull } from "../numbers.js";

/**
 * The one reading of the providers' 均價, for the crosshair lookup (canvas_engine.js) and the 均價 line alike: each
 * point's session-to-now cumulative average as the provider sent it (average_price, else avg_price). A point whose
 * value is missing, blank, zero, negative or not a number carries the previous point's average (null before the
 * first one): a sparse point omits an update, it does not reset the average. Never synthesized from minute
 * turnover/volume or close price -- those have different session and adjustment semantics.
 */
export function normalizeProviderAverageSeries(points = []) {
  let last = null;
  return (Array.isArray(points) ? points : []).map((point) => {
    const average = positiveNumberOrNull(point?.average_price ?? point?.avg_price);
    if (average != null) last = average;
    return last;
  });
}

export class TrendIndicatorEngine {
  averagePrice(points = [], coordinateForPoint = null) {
    const source = Array.isArray(points) ? points : [];
    const averages = normalizeProviderAverageSeries(source);
    return source.map((point, index) => {
      const minute = coordinateForPoint?.(point, index, source.length) ?? point?.minute;
      return { minute: Number(minute), price: averages[index] };
    }).filter((point) => Number.isFinite(point.minute) && point.price != null);
  }
}

export const trendIndicatorEngine = new TrendIndicatorEngine();
