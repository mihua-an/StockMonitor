// Health's monitoring trend (health/monitoring/collector.js) as a page holds it. Health is its only owner: it adds a
// point when it really sampled and drops the points older than its retention. A page asks for the points after the
// last one it holds (getMonitoringSnapshot({ trendSince })) and keeps exactly those -- it never adds a point of its own
// for a snapshot it read, and keeps them for Health's span, not a length of its own.
export function createMonitoringTrend() {
  let points = [];
  return {
    /** The time of the last point held: Health answers the points sampled after it (0: all of them). */
    since: () => points.at(-1)?.t ?? 0,
    /** Takes the points this snapshot carries and drops those past Health's retention; returns the points held. */
    apply(snapshot) {
      const last = points.at(-1)?.t ?? 0;
      const added = Array.isArray(snapshot?.trend) ? snapshot.trend.filter((point) => Number.isFinite(point?.t) && point.t > last) : [];
      const sampledAt = Date.parse(snapshot?.sampled_at);
      const retention = Number(snapshot?.trend_retention_ms);
      points = points.concat(added);
      if (Number.isFinite(sampledAt) && Number.isFinite(retention)) points = points.filter((point) => point.t >= sampledAt - retention);
      return points;
    },
    points: () => points,
    reset() { points = []; },
  };
}
