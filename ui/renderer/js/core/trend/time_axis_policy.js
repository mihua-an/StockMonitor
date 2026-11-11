function clockMinutes(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  const match = text.match(/(?:^|T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
  return hour * 60 + minute + second / 60;
}

function labelClock(totalMinutes) {
  let minute = Math.round(Number(totalMinutes) || 0) % 1440;
  if (minute < 0) minute += 1440;
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function segmentLength(start, end) {
  return end >= start ? end - start : (1440 - start) + end;
}

// A segment as clock-minute intervals [from, to) of one day: one, or two when it runs past midnight.
function dayIntervals(start, end) {
  return end >= start ? [[start, end]] : [[start, 1440], [0, end]];
}

function overlapping(left, right) {
  return dayIntervals(left.start, left.end).some(([a, b]) => dayIntervals(right.start, right.end)
    .some(([c, d]) => Math.max(a, c) < Math.min(b, d)));
}

function insideClock(clock, start, end) {
  if (end >= start) return clock >= start && clock <= end;
  return clock >= start || clock <= end;
}

// A policy is checked when it is built: a non-empty list of segments in axis order, each with two readable clock
// endpoints and a positive length, no two sharing a minute (touching ends are fine). A wrong one is refused with the
// policy id and the segment index, instead of drawing a plausible 00:00 axis of span 1.
export class TimeAxisPolicy {
  constructor({ id = "equity", segments = [], gapMinutes = 0, directMinute = false } = {}) {
    if (!Array.isArray(segments) || !segments.length) throw new TypeError(`TimeAxisPolicy ${id}: segments must be a non-empty array`);
    this.id = id;
    this.directMinute = Boolean(directMinute);
    this.gapMinutes = Math.max(0, Number(gapMinutes) || 0);
    let offset = 0;
    this.segments = segments.map((segment, index) => {
      const start = clockMinutes(segment?.start);
      const end = clockMinutes(segment?.end);
      if (start == null || end == null) {
        throw new TypeError(`TimeAxisPolicy ${id}: segment ${index} has an unreadable ${start == null ? "start" : "end"} (${start == null ? segment?.start : segment?.end})`);
      }
      const length = segmentLength(start, end);
      if (!(length > 0)) throw new TypeError(`TimeAxisPolicy ${id}: segment ${index} is empty (${segment.start}-${segment.end})`);
      const result = {
        ...segment,
        index,
        start,
        end,
        length,
        offset,
        endOffset: offset + length,
      };
      offset += length;
      if (index < segments.length - 1) offset += this.gapMinutes;
      return result;
    });
    this.segments.forEach((segment, index) => {
      const earlier = this.segments.findIndex((other, at) => at < index && overlapping(other, segment));
      if (earlier >= 0) throw new TypeError(`TimeAxisPolicy ${id}: segment ${index} overlaps segment ${earlier}`);
    });
    this.span = offset;
    Object.freeze(this.segments.map(Object.freeze));
    Object.freeze(this);
  }

  coordinateFromClock(clock) {
    const value = Number(clock);
    if (!Number.isFinite(value)) return null;
    for (const segment of this.segments) {
      if (!insideClock(value, segment.start, segment.end)) continue;
      const delta = value >= segment.start ? value - segment.start : 1440 - segment.start + value;
      return segment.offset + Math.min(segment.length, Math.max(0, delta));
    }
    return null;
  }

  coordinateForPoint(point, index = 0, count = 1) {
    if (this.directMinute) {
      const direct = Number(point?.minute);
      if (Number.isFinite(direct) && direct >= 0 && direct <= this.span) return direct;
    }
    const clock = clockMinutes(point?.timestamp ?? point?.datetime ?? point?.exchange_time ?? point?.time);
    const mapped = this.coordinateFromClock(clock);
    if (mapped != null) return mapped;
    // A parseable clock outside every session segment is authoritative "closed
    // session", not missing metadata.  Never index-project it into the chart, or
    // 05:00→08:45 / non-session ticks would look like real trading.
    if (clock != null) return null;
    if (count > 1) return (index / (count - 1)) * this.span;
    return 0;
  }

  coordinateForTime(value) {
    return this.coordinateFromClock(clockMinutes(value));
  }

  formatCoordinate(coordinate) {
    const value = Number(coordinate);
    if (!Number.isFinite(value)) return "--:--";
    for (const segment of this.segments) {
      if (value < segment.offset - 1e-6 || value > segment.endOffset + 1e-6) continue;
      const delta = Math.max(0, Math.min(segment.length, value - segment.offset));
      return labelClock(segment.start + delta);
    }
    return "--:--";
  }

  gridTicks() {
    const ticks = [];
    for (const segment of this.segments) {
      ticks.push({ coordinate: segment.offset, label: labelClock(segment.start), kind: "session-start" });
      const firstHour = Math.ceil(segment.start / 60) * 60;
      const length = segment.length;
      for (let elapsed = 0; elapsed < length; elapsed += 1) {
        const clock = (segment.start + elapsed) % 1440;
        if (elapsed > 0 && clock % 60 === 0) {
          ticks.push({ coordinate: segment.offset + elapsed, label: labelClock(clock), kind: "hour" });
        }
      }
      ticks.push({ coordinate: segment.endOffset, label: labelClock(segment.end), kind: "session-end" });
      if (segment.index < this.segments.length - 1 && this.gapMinutes > 0) {
        ticks.push({ coordinate: segment.endOffset + this.gapMinutes / 2, label: "休市", kind: "session-break" });
      }
    }
    const seen = new Set();
    return ticks.filter((tick) => {
      const key = `${Math.round(tick.coordinate * 1000)}:${tick.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  containsPoint(point) {
    return this.coordinateForPoint(point, 0, 1) != null;
  }
}

export const EQUITY_TIME_AXIS = new TimeAxisPolicy({
  id: "equity-day",
  segments: [{ start: "09:00", end: "13:30" }],
  directMinute: true,
});

export const TAIEX_TIME_AXIS = EQUITY_TIME_AXIS;

// The DAY session ends 13:45 on every trading date (config/trading_sessions.json, the session contract Market Runtime
// partitions by). One immutable policy per session: the futures adapter asks on every draw, and the trend canvas keeps
// its static grid layer while the policy it was drawn with is the same object.
const futuresTimeAxes = new Map();
export function createFuturesTimeAxis(session = "full") {
  const mode = String(session || "full").toLowerCase();
  let policy = futuresTimeAxes.get(mode);
  if (!policy) { policy = buildFuturesTimeAxis(mode); futuresTimeAxes.set(mode, policy); }
  return policy;
}

function buildFuturesTimeAxis(mode) {
  const dayEnd = "13:45";
  if (mode === "day") {
    return new TimeAxisPolicy({ id: "txf-day", segments: [{ start: "08:45", end: dayEnd }] });
  }
  if (mode === "night") {
    return new TimeAxisPolicy({ id: "txf-night", segments: [{ start: "15:00", end: "05:00" }] });
  }
  return new TimeAxisPolicy({
    id: "txf-full",
    segments: [
      { start: "15:00", end: "05:00", name: "night" },
      { start: "08:45", end: dayEnd, name: "day" },
    ],
    gapMinutes: 30,
  });
}
