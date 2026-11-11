function hourFromLabel(label) {
  const match = String(label || "").match(/^(\d{2}):00$/);
  return match ? Number(match[1]) : null;
}

function compactHour(label) {
  const hour = hourFromLabel(label);
  return hour == null ? String(label || "") : String(hour).padStart(2, "0");
}

function dedupe(ticks) {
  const seen = new Set();
  return ticks.filter((tick) => {
    const key = `${Math.round(Number(tick.coordinate) * 1000)}:${tick.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class TimeLabelPolicy {
  constructor({ minimumLabelSpacingPx = 42 } = {}) {
    this.minimumLabelSpacingPx = Math.max(24, Number(minimumLabelSpacingPx) || 42);
  }

  candidates(timeAxisPolicy) {
    const grid = timeAxisPolicy?.gridTicks?.() || [];
    const id = String(timeAxisPolicy?.id || "");
    // Shared trend charts label every whole clock hour, including an opening or
    // closing boundary when that boundary itself is HH:00. Non-hour boundaries
    // such as 08:45, 09:30, 13:30 and 13:45 remain grid geometry without text.
    const hourly = grid.filter((tick) => hourFromLabel(tick.label) != null);

    if (id === "txf-night") {
      return hourly.filter((tick) => {
        const hour = hourFromLabel(tick.label);
        return hour != null && [15,17,19,21,23,1,3,5].includes(hour);
      }).map((tick) => ({ ...tick, label: compactHour(tick.label), priority: 3 }));
    }

    if (id === "txf-day") {
      return hourly.filter((tick) => {
        const hour = hourFromLabel(tick.label);
        return hour != null && [9,10,11,12,13].includes(hour);
      }).map((tick) => ({ ...tick, label: compactHour(tick.label), priority: 3 }));
    }

    if (id === "txf-full") {
      // Full-session keeps the 05:00 -> 08:45 break as a grid/session-break
      // marker, but the text labels stay focused on tradable-session anchors.
      // Rendering a literal "休市" label here can collide with 05/09 when the
      // chart is narrower, causing the important session labels to disappear.
      const selected = hourly.filter((tick) => {
        const hour = hourFromLabel(tick.label);
        return hour != null && [15,17,19,21,23,1,3,5,9,11,13].includes(hour);
      }).map((tick) => ({
        ...tick,
        label: compactHour(tick.label),
        priority: 3,
      }));
      return dedupe(selected);
    }

    return dedupe(hourly.map((tick) => ({ ...tick, label: compactHour(tick.label), priority: 2 })));
  }

  ticks(timeAxisPolicy, { plotWidth = 0, minimumLabelSpacingPx = this.minimumLabelSpacingPx } = {}) {
    const candidates = this.candidates(timeAxisPolicy);
    const width = Number(plotWidth);
    const span = Math.max(1e-9, Number(timeAxisPolicy?.span) || 1);
    if (!Number.isFinite(width) || width <= 0 || candidates.length < 2) return candidates;

    const spacing = Math.max(24, Number(minimumLabelSpacingPx) || this.minimumLabelSpacingPx);
    // Highest-priority anchors win collisions. Then restore chronological order.
    const accepted = [];
    [...candidates]
      .sort((a, b) => (Number(b.priority || 0) - Number(a.priority || 0)) || (a.coordinate - b.coordinate))
      .forEach((tick) => {
        const x = (Number(tick.coordinate) / span) * width;
        if (!accepted.some((item) => Math.abs(item.x - x) < spacing)) accepted.push({ ...tick, x });
      });
    return accepted.sort((a, b) => a.coordinate - b.coordinate).map(({ x, ...tick }) => tick);
  }
}

export const DEFAULT_TIME_LABEL_POLICY = new TimeLabelPolicy();
