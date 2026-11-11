// 歷史回放 時間條: the replayed day as a bar of seconds of the Taipei day, over the market's span in Market Runtime's
// recording, and the time the thumb stands on shown right of the transport buttons (HH:MM:SS). The bar only shows and
// asks: the time itself is Market Runtime's replay position (engine_controller.js).
import { $ } from "../../core/utility.js";
import { taipeiTimeToNs } from "./engine_replay.js";

const SECONDS_PER_DAY = 86_400n;
const TAIPEI_OFFSET_SECONDS = 8n * 3600n;

/** Epoch ns (decimal string or number) -> second of the Taipei day (0..86399); null when it is not a time. */
export function taipeiSecondOfDay(ns) {
  let seconds;
  try { seconds = BigInt(String(ns)) / 1_000_000_000n; } catch (_error) { /* not an error: a value that is not an integer nanosecond time has no second of day by contract */ return null; }
  if (seconds <= 0n) return null;
  return Number(((seconds + TAIPEI_OFFSET_SECONDS) % SECONDS_PER_DAY + SECONDS_PER_DAY) % SECONDS_PER_DAY);
}

/** Second of the day -> "HH:MM:SS". */
export function clockOfSecond(second) {
  const s = Math.max(0, Math.min(86_399, Math.floor(Number(second) || 0)));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The replay time that shows second `second` of `tradingDate` whole: its last nanosecond, as a decimal string. */
export function endOfSecondNs(tradingDate, second) {
  const start = taipeiTimeToNs(tradingDate, clockOfSecond(second));
  return start == null ? null : (BigInt(start) + 999_999_999n).toString();
}

function bar() {
  return { range: $("historyTimeRange"), now: $("historyTimeNow"), start: $("historyStartTime"), end: $("historyEndTime"),
    buffer: $("historyTimeBuffer"), track: $("historyTimeTrack") };
}

const NO_TIME = "--:--:--";

// The thumb's place (the played part of the rail reads --history-thumb-ratio) and its time beside the transport.
function placeThumb(range, now, second) {
  const min = Number(range?.min) || 0;
  const max = Number(range?.max) || 0;
  const ratio = max > min ? Math.max(0, Math.min(1, (second - min) / (max - min))) : 0;
  bar().track?.style.setProperty("--history-thumb-ratio", String(ratio));
  const text = clockOfSecond(second);
  if (now && now.textContent !== text) now.textContent = text;
}

/** The bar for a replay's day: the market's span in the recording (its first to last print, book or quote), at the
 * replay's position. */
export function setupHistoryTimeline(status) {
  const { range, start, end } = bar();
  const first = taipeiSecondOfDay(status?.recording?.market_first_ns);
  const last = taipeiSecondOfDay(status?.recording?.market_last_ns);
  if (first == null || last == null || !range) return;
  range.disabled = false;
  range.min = String(first);
  range.max = String(Math.max(first, last));
  if (start) start.textContent = clockOfSecond(first).slice(0, 5);
  if (end) end.textContent = clockOfSecond(last).slice(0, 5);
  showHistoryTimelinePosition(taipeiSecondOfDay(status?.position_ns) ?? first);
}

/** Where the replay stands (or where the held thumb is). */
export function showHistoryTimelinePosition(second) {
  const { range, now } = bar();
  if (!range || second == null) return;
  const value = String(second);
  if (range.value !== value) range.value = value;
  placeThumb(range, now, second);
}

/** The times whose Rust B analysis Market Runtime holds (status.analysis.buffered: ranges of replay times), drawn under
 * the bar: inside them a seek shows the analysis at once, outside 計算中 until B gets there. Its segments are kept
 * and only moved. */
export function showHistoryTimelineBuffer(buffered) {
  const { range, buffer } = bar();
  if (!range || !buffer) return;
  const min = Number(range.min) || 0;
  const max = Number(range.max) || 0;
  const ranges = Array.isArray(buffered?.ranges) ? buffered.ranges : [];
  const spans = max > min ? ranges.map(([a, b]) => [taipeiSecondOfDay(a), taipeiSecondOfDay(b)])
    .filter(([a, b]) => a != null && b != null)
    .map(([a, b]) => [Math.max(0, (a - min) / (max - min)), Math.min(1, (b + 1 - min) / (max - min))])
    .filter(([a, b]) => b > a) : [];
  while (buffer.children.length > spans.length) buffer.lastElementChild.remove();
  while (buffer.children.length < spans.length) buffer.append(document.createElement("span"));
  spans.forEach(([a, b], i) => {
    const segment = buffer.children[i];
    const left = `${(a * 100).toFixed(3)}%`;
    const width = `${((b - a) * 100).toFixed(3)}%`;
    if (segment.style.left !== left) segment.style.left = left;
    if (segment.style.width !== width) segment.style.width = width;
  });
}

/** The time under the pointer while it is over the bar, shown above it (YouTube-like). */
export function bindHistoryTimelineHover() {
  const { range, track } = bar();
  const hover = $("historyTimeHover");
  if (!range || !track || !hover) return;
  // The thumb's centre (half its 13 px) is where the value's travel starts and ends.
  const inset = 6.5;
  range.addEventListener("pointermove", (event) => {
    if (range.disabled) return;
    const rect = range.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - inset) / Math.max(1, rect.width - 2 * inset)));
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 0;
    track.style.setProperty("--history-hover-ratio", String(ratio));
    const text = clockOfSecond(Math.round(min + ratio * (max - min)));
    if (hover.textContent !== text) hover.textContent = text;
    hover.hidden = false;
  });
  range.addEventListener("pointerleave", () => { hover.hidden = true; });
}

/** No replay: the bar is idle and shows no time. */
export function clearHistoryTimeline() {
  const { range, now, start, end, buffer } = bar();
  buffer?.replaceChildren();
  if (range) {
    range.disabled = true;
    range.min = "0";
    range.max = "0";
    range.value = "0";
  }
  if (now) now.textContent = NO_TIME;
  if (start) start.textContent = "09:00";
  if (end) end.textContent = "13:30";
}
