// One day's small candle (open / high / low / close), as markup: 歷史回放's stock list and the compact product lists.
const number = (value) => {
  if (value === null || value === undefined || value === "") return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

export function miniCandleMarkup({ open, high, low, close } = {}) {
  const o = number(open), h = number(high), l = number(low), c = number(close);
  if (![o, h, l, c].every(Number.isFinite)) return `<div class="mini-candle is-empty"></div>`;
  const safeHigh = Math.max(h, o, c);
  const safeLow = Math.min(l, o, c);
  const range = Math.max(safeHigh - safeLow, Math.abs(safeHigh) * 0.001, 0.01);
  const y = (value) => 1 + ((safeHigh - value) / range) * 32;
  const openY = y(o), closeY = y(c);
  const bodyTop = Math.min(openY, closeY);
  const bodyHeight = Math.max(2, Math.abs(closeY - openY));
  const candleClass = c > o ? "up" : c < o ? "down" : "flat";
  return `<svg class="mini-candle ${candleClass}" viewBox="0 0 14 34" aria-hidden="true"><line x1="7" x2="7" y1="${y(safeHigh).toFixed(2)}" y2="${y(safeLow).toFixed(2)}"></line><rect x="3" y="${bodyTop.toFixed(2)}" width="8" height="${bodyHeight.toFixed(2)}" rx="1"></rect></svg>`;
}
