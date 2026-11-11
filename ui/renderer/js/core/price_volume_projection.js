import { positiveNumberOrNull } from "./numbers.js";

const finitePrice = positiveNumberOrNull;
// A volume that is missing or not above zero adds nothing to a bucket.
const finiteVolume = (value) => positiveNumberOrNull(value) ?? 0;

function nearestBucketIndex(buckets, target) {
  if (!buckets.length || !Number.isFinite(Number(target))) return -1;
  let best = 0;
  let distance = Math.abs(Number(buckets[0].price) - Number(target));
  for (let index = 1; index < buckets.length; index += 1) {
    const next = Math.abs(Number(buckets[index].price) - Number(target));
    if (next < distance - 1e-9) { best = index; distance = next; }
  }
  return best;
}

export function buildPriceVolumeProjection(rows = [], currentPrice = null) {
  // `rows` is already one canonical bucket per price from Market Daemon.
  // Renderer owns only display geometry; it must never add Tick volume or
  // merge duplicate price facts into a second business projection.
  const buckets = (Array.isArray(rows) ? rows : []).map((raw) => {
    const price = finitePrice(raw?.price);
    if (price == null) return null;
    return {
      price,
      out: finiteVolume(raw?.out ?? raw?.buy_volume),
      in: finiteVolume(raw?.in ?? raw?.sell_volume),
    };
  }).filter(Boolean).sort((a, b) => a.price - b.price);
  const focusPrice = finitePrice(currentPrice);

  if (!buckets.length) return {
    buckets: [], axis: [], low: null, high: null, currentPrice: focusPrice,
    currentIndex: -1, maxVolume: 1, bucketCount: 0,
  };

  const low = buckets[0].price;
  const high = buckets[buckets.length - 1].price;
  const mid = (low + high) / 2;
  const targets = [low, (low + mid) / 2, mid, (mid + high) / 2, high];
  const labels = ["L", "LM", "M", "UM", "H"];
  const seen = new Set();
  const axis = [];
  targets.forEach((target, slot) => {
    const index = nearestBucketIndex(buckets, target);
    if (index < 0 || seen.has(index)) return;
    seen.add(index);
    axis.push({ slot: labels[slot], index, price: buckets[index].price, position: buckets.length <= 1 ? 50 : index / (buckets.length - 1) * 100 });
  });
  axis.sort((a, b) => a.index - b.index);

  const currentIndex = focusPrice == null ? -1 : buckets.findIndex((row) => Math.abs(Number(row.price) - focusPrice) < 1e-7);
  const domainIncludesCurrent = focusPrice == null || (focusPrice >= low - 1e-7 && focusPrice <= high + 1e-7 && currentIndex >= 0);
  // 逐價內外盤 shows buyer- and seller-initiated volume only: a print whose side cannot be told is not drawn and does
  // not count toward a bar's height (使用者 10-21).
  const maxVolume = Math.max(1, ...buckets.map((row) => finiteVolume(row.out) + finiteVolume(row.in)));
  return { buckets, axis, low, high, currentPrice: focusPrice, currentIndex, domainIncludesCurrent, maxVolume, bucketCount: buckets.length };
}
