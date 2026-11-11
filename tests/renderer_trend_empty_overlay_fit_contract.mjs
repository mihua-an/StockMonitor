// The empty-chart message fits a narrow pane (Futu 個股走勢 in a 230 px column cut it off at both edges): the font steps
// down to 11 px, then the message breaks into two lines. Wide panes keep the 18 px single line.
import assert from "node:assert/strict";
import { drawEmptyOverlay } from "../ui/renderer/js/core/trend/trend_chart_manager.js";

const fakeContext = () => {
  const drawn = [];
  return { drawn, font: "", save() {}, restore() {}, fillText(text, x, y) { drawn.push({ text, x, y }); },
    // One character is as wide as the font size: enough to exercise the fitting.
    measureText(text) { return { width: text.length * Number(/(\d+)px/.exec(this.font)[1]) }; } };
};

{
  const ctx = fakeContext();
  assert.deepEqual(drawEmptyOverlay(ctx, "尚無資料", 600, 400), { size: 18, lines: ["尚無資料"] });
  assert.deepEqual(ctx.drawn, [{ text: "尚無資料", x: 300, y: 200 }]);
}
{
  const ctx = fakeContext();
  const result = drawEmptyOverlay(ctx, "請先在 Futu 商品列表選擇商品", 230, 400);
  assert.ok(result.size < 18 && result.size >= 11);
  assert.equal(result.lines.length, 1, "shrinking was enough");
}
{
  const ctx = fakeContext();
  const result = drawEmptyOverlay(ctx, "請先在 Futu 商品列表選擇商品", 150, 400);
  assert.equal(result.size, 11);
  assert.equal(result.lines.join(""), "請先在 Futu 商品列表選擇商品", "two lines carry the whole message");
  assert.equal(ctx.drawn.length, 2);
  assert.ok(ctx.drawn[0].y < 200 && ctx.drawn[1].y > 200, "centred around the middle");
}
console.log("trend empty overlay fit contract passed");
