// 個股走勢's 加權 / 期貨 overlay is drawn from each one's 昨收, the same baseline the stock chart's axis is centered on.
// 11-06: 台玻 (1802, 昨收 60.10) opened at its limit-down 54.10; the overlay was projected from the two opens, so
// 加權's open sat on 54.10 and every further point of 加權 falling was drawn below the stock's limit-down.
import assert from "node:assert/strict";
import { projectBenchmarkSeries } from "../ui/renderer/js/core/trend_overlay.js";

const axis = { coordinateForPoint: (point) => point.minute };
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

// 加權: 昨收 27000, opens 26800, falls to 26600 (-1.48% from 昨收).
const taiex = [{ minute: 0, price: 26800 }, { minute: 1, price: 26700 }, { minute: 2, price: 26600 }];
{
  const series = projectBenchmarkSeries({ rawPoints: taiex, stockReference: 60.10, benchmarkReference: 27000, targetTimeAxisPolicy: axis });
  assert.ok(series, "both references known: the overlay is drawn");
  close(series.points[0].price, 60.10 * 26800 / 27000, "加權's open sits at its own change from 昨收 on the stock's axis");
  close(series.points[2].price, 60.10 * 26600 / 27000, "加權 -1.48% is 台玻 -1.48%");
  assert.ok(Math.min(...series.points.map((p) => p.price)) > 54.10, "a -1.48% index is never drawn below a -10% limit-down");
}

// A benchmark at its 昨收 sits on the stock's 昨收 line, whatever either one opened at.
{
  const series = projectBenchmarkSeries({ rawPoints: [{ minute: 0, price: 27000 }, { minute: 1, price: 27000 }],
    stockReference: 60.10, benchmarkReference: 27000, targetTimeAxisPolicy: axis });
  close(series.points[1].price, 60.10, "unchanged benchmark on the 昨收 line");
}

// Without either 昨收 there is no common baseline: no series (no guess from an open or a first print).
assert.equal(projectBenchmarkSeries({ rawPoints: taiex, stockReference: null, benchmarkReference: 27000, targetTimeAxisPolicy: axis }), null);
assert.equal(projectBenchmarkSeries({ rawPoints: taiex, stockReference: 60.10, benchmarkReference: 0, targetTimeAxisPolicy: axis }), null);

console.log("trend overlay reference contract passed");
