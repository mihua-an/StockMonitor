/**
 * Pixel-aware display projection. It preserves the first/last and local extrema
 * instead of blindly dropping every Nth point. One pass: each bucket's extremes are found by index, in source order,
 * so the work is linear in the series and a point object repeated in the series is kept where it was found.
 */
const priceOf = (point) => Number(point?.price ?? point?.close);

export function projectTrendForDisplay(points = [], { pixelWidth = 0, maxPoints = 0 } = {}) {
  const source = Array.isArray(points) ? points : [];
  const capacity = Math.max(32, Number(maxPoints) || Math.floor(Math.max(0, Number(pixelWidth)) * 1.5) || source.length);
  if (source.length <= capacity) return source;
  const interiorCapacity = Math.max(2, capacity - 2);
  const bucketSize = Math.max(1, Math.ceil((source.length - 2) / Math.ceil(interiorCapacity / 2)));
  const selected = [source[0]];
  for (let start = 1; start < source.length - 1; start += bucketSize) {
    const end = Math.min(source.length - 1, start + bucketSize);
    let minIndex = start, maxIndex = start;
    let minPrice = priceOf(source[start]), maxPrice = minPrice;
    for (let index = start + 1; index < end; index += 1) {
      const price = priceOf(source[index]);
      if (price < minPrice) { minPrice = price; minIndex = index; }
      if (price > maxPrice) { maxPrice = price; maxIndex = index; }
    }
    if (minIndex === maxIndex) selected.push(source[minIndex]);
    else selected.push(source[Math.min(minIndex, maxIndex)], source[Math.max(minIndex, maxIndex)]);
  }
  const last = source.at(-1);
  // Always reserve the final slot for the newest market point. Truncating the
  // completed selection directly could leave the chart visually behind live.
  return [...selected.slice(0, capacity - 1), last];
}
