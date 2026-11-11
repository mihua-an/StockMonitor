import { positiveNumberOrNull as positiveFinite } from "../numbers.js";

export class PriceScalePolicy {
  constructor({ minimumAbsolute = 0.01, minimumRatio = 0.0005, paddingRatio = 1 } = {}) {
    this.minimumAbsolute = Math.max(0.000001, Number(minimumAbsolute) || 0.01);
    this.minimumRatio = Math.max(0, Number(minimumRatio) || 0);
    this.paddingRatio = Math.max(1, Number(paddingRatio) || 1);
  }

  resolve({ referencePrice, prices = [], fallbackCenter = null } = {}) {
    // Main price charts always operate in absolute-price space. Zero is a valid
    // return/delta reference, but it is not a valid Taiwan stock/index/futures
    // market price and must never become the center of a price axis.
    const valid = (prices || []).map(positiveFinite).filter((value) => value != null);
    const high = valid.length ? Math.max(...valid) : null;
    const low = valid.length ? Math.min(...valid) : null;

    const authoritative = positiveFinite(referencePrice);
    const explicitFallback = positiveFinite(fallbackCenter);
    const visibleMidpoint = high != null && low != null ? (high + low) / 2 : (high ?? low ?? null);
    const reference = authoritative ?? explicitFallback ?? visibleMidpoint;

    // No price data: keep transform finite without inventing a zero-centered
    // market scale. Callers normally render an empty overlay in this state.
    const center = reference ?? 1;
    const resolvedHigh = high ?? center;
    const resolvedLow = low ?? center;
    // The five price-axis levels are defined directly from the authoritative
    // reference and the observed session extremes:
    //   reference +/- max(high-reference, reference-low)
    //   reference +/- interval/2
    // Do not pad this interval. Padding an integer TXF distance by 1.08 created
    // artificial .02/.98 labels that are not market prices.
    const observed = Math.max(resolvedHigh - center, center - resolvedLow, 0);
    const marketMinimum = Math.abs(center) * this.minimumRatio;
    const maxDiff = Math.max(observed * this.paddingRatio, marketMinimum, this.minimumAbsolute);

    return {
      reference: center,
      referenceAvailable: authoritative != null,
      high: resolvedHigh,
      low: resolvedLow,
      maxDiff,
      top: center + maxDiff,
      bottom: center - maxDiff,
      fallbackUsed: authoritative == null,
    };
  }
}

export const DEFAULT_PRICE_SCALE_POLICY = new PriceScalePolicy();
