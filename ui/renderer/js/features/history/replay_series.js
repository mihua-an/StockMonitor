// 歷史回放: the replay chart's benchmark overlays and 均價 at the replay time (split out of pages/history.js).
import { projectBenchmarkSeries } from "../../core/trend_overlay.js";
import { historyPage, historyState } from "./history_state.js";
import { historyReplayClockMinute, historySeriesUntil } from "./history_values.js";
import { themeColor } from "../../core/market_palette.js";

/** The replay chart's benchmarks (加權 / 期貨, from each one's 昨收) and 均價, up to the replay time. `cursor` is the
 * replay's { time, reference } (the stock's 昨收). */
export function buildHistoryTrendOverlaySeries(cursor, stockPoints) {
  const result = [];
  const cutoff = cursor?.time || historyState.replayCurrentTime;

  if (historyPage.benchmarkOverlayControls?.isSelected?.("taiex")) {
    const raw = historySeriesUntil(historyState.marketSession?.points, cutoff);
    const overlay = projectBenchmarkSeries({
      rawPoints: raw,
      stockReference: cursor?.reference,
      benchmarkReference: historyState.marketSession?.prev_close,
      strokeStyle: themeColor("--chart-benchmark-taiex"),
      lineWidth: 2,
      alpha: 0.95,
    });
    if (overlay) result.push(overlay);
  }

  if (historyPage.benchmarkOverlayControls?.isSelected?.("futures")) {
    const raw = historySeriesUntil(historyState.txfSession?.points, cutoff);
    const overlay = projectBenchmarkSeries({
      rawPoints: raw,
      stockReference: cursor?.reference,
      benchmarkReference: historyState.txfSession?.reference_price,
      strokeStyle: themeColor("--chart-benchmark-txf"),
      lineWidth: 2,
      alpha: 0.95,
    });
    if (overlay) result.push(overlay);
  }

  // 均價 is always shown, as in 個股走勢 (no switch).
  {
    const averagePoints = (Array.isArray(stockPoints) ? stockPoints : [])
      .map((point) => ({
        minute: historyReplayClockMinute(point?.time || point?.datetime || point?.timestamp),
        price: Number(point?.average_price ?? point?.avg_price),
      }))
      .filter((point) => Number.isFinite(point.minute) && Number.isFinite(point.price) && point.price > 0);
    if (averagePoints.length >= 2) result.push({
      id: "AVERAGE_PRICE", label: "均價", points: averagePoints, lineWidth: 1.5, alpha: 0.9, semantic: "AVERAGE_PRICE",
    });
  }
  return result;
}
