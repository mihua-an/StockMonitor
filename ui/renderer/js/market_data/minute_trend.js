// Market Runtime's trend point (native wire.rs trend_point / analysis accum.rs MinuteRecord::wire) names its minute
// by `timestamp`; that one field is the key. A point without it is refused (logged), never stored unkeyed.
function pointTimestamp(point = {}) {
  return point?.timestamp || "";
}

// A trend point is never modified once it is in a series (every upsert stores a copy), so its minute key is
// parsed once per point: the binary search of each upsert asked for it ~log2(270) times, each a Date.parse.
const minuteKeys = new WeakMap();

export function minuteTrendKey(point = {}) {
  if (!point || typeof point !== "object") return minuteKeyOf(point);
  let key = minuteKeys.get(point);
  if (key === undefined) { key = minuteKeyOf(point); minuteKeys.set(point, key); }
  return key;
}

function minuteKeyOf(point = {}) {
  const raw = String(pointTimestamp(point) || "").trim();
  if (!raw) return "";
  const parsed = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  if (Number.isFinite(parsed)) {
    const date = new Date(parsed);
    date.setSeconds(0, 0);
    return date.toISOString().slice(0, 16);
  }
  const clock = raw.match(/(?:^|[ T])(\d{1,2}):(\d{2})/);
  if (clock) return `${String(clock[1]).padStart(2, "0")}:${clock[2]}`;
  return raw.slice(0, 16);
}

function refuseKeyless(point) {
  console.warn("[minute trend] point without a timestamp refused", point);
}

export function upsertMinuteTrendPoint(points = [], rawPoint = {}) {
  const key = minuteTrendKey(rawPoint);
  const next = Array.isArray(points) ? points.slice() : [];
  const point = { ...rawPoint };
  minuteKeys.set(point, key);  // the stored copy has the same minute
  if (!key) {
    refuseKeyless(rawPoint);
    return next;
  }
  // Canonical series are sorted. The hot path updates the tail or appends a
  // minute; a late historical correction uses binary search, not a full sort.
  let lo=0, hi=next.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(minuteTrendKey(next[mid])<key)lo=mid+1;else hi=mid;}
  const index = lo < next.length && minuteTrendKey(next[lo]) === key ? lo : -1;
  // Market Runtime sends a minute again only when it changed (forming close, B's revision): the later one replaces it.
  if (index >= 0) {
    next[index] = point;
  } else {
    next.splice(lo, 0, point);
  }
  return next;
}

// One pass keyed by minute, then one sort -- the same result as upserting point by point, which copied the array
// per point: merging a day's series for each of 74 rows on return to 即時報價 cost ~1 s.
export function normalizeMinuteTrendSeries(points = []) {
  const byKey = new Map();
  for (const raw of Array.isArray(points) ? points : []) {
    const point = { ...(raw || {}) };
    const key = minuteTrendKey(raw || point);
    minuteKeys.set(point, key);
    if (!key) { refuseKeyless(raw); continue; }
    byKey.set(key, point);
  }
  return [...byKey.keys()].sort().map((key) => byKey.get(key));
}

