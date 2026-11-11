import { marketPalette, themeColor } from "../market_palette.js";
export const SEGMENT_STYLE = Object.freeze({
  NEUTRAL_GREY: "NEUTRAL_GREY",
  POSITIVE: "POSITIVE",
  NEGATIVE: "NEGATIVE",
  FLAT: "FLAT",
  DEFAULT_MARKET: "DEFAULT_MARKET",
  HIDDEN: "HIDDEN",
});

export class ReplayStylePolicy {
  resolve({ previous, current, tradeInterval = null, options = {} } = {}) {
    if (!tradeInterval) return { token: SEGMENT_STYLE.DEFAULT_MARKET };
    const coordinate = (Number(previous?.minute) + Number(current?.minute)) / 2;
    const lower = Math.min(Number(tradeInterval.startMinute), Number(tradeInterval.endMinute));
    const upper = Math.max(Number(tradeInterval.startMinute), Number(tradeInterval.endMinute));
    if (!Number.isFinite(coordinate) || !Number.isFinite(lower) || !Number.isFinite(upper) || coordinate < lower || coordinate > upper) {
      return { token: SEGMENT_STYLE.NEUTRAL_GREY, color: options.mutedLineColor || themeColor("--chart-muted-line"), width: 1.7 };
    }
    const base = Number(options.tradeBasePrice);
    const midpoint = (Number(previous?.price) + Number(current?.price)) / 2;
    if (Number.isFinite(base) && base > 0 && Number.isFinite(midpoint)) {
      return midpoint > base
        ? { token: SEGMENT_STYLE.POSITIVE, color: options.tradeUpColor || marketPalette().up, width: 3 }
        : midpoint < base
          ? { token: SEGMENT_STYLE.NEGATIVE, color: options.tradeDownColor || marketPalette().down, width: 3 }
          : { token: SEGMENT_STYLE.FLAT, color: options.tradeFlatColor || themeColor("--chart-trade-flat"), width: 3 };
    }
    return { token: SEGMENT_STYLE.DEFAULT_MARKET, width: 3 };
  }
}

export const DEFAULT_REPLAY_STYLE_POLICY = new ReplayStylePolicy();
