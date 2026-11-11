// One view.delta.batch frame, delivered as one notification per view: while it is applied, the store's notifications
// and metrics are collected here instead of going out one delta at a time, and flushed once when the batch ends.

export class DeliveryBatch {
  constructor() {
    // view key -> { entry, deltas, channels, event }
    this.notifications = new Map();
    // (view, name, reason) -> { entry, name, detail } with detail.count
    this.metrics = new Map();
  }

  addNotification(entry, event) {
    const pending = this.notifications.get(entry.key) || { entry, deltas: [], channels: new Set() };
    if (event.delta) {
      pending.deltas.push(event.delta);
      for (const channel of event.delta.channels || [event.delta.channel || event.delta.delta_type]) pending.channels.add(channel);
    }
    pending.event = event;
    this.notifications.set(entry.key, pending);
  }

  // Inside a batch a metric is counted, and emitted once per (view, name, reason) when the batch ends.
  addMetric(entry, name, detail = {}) {
    const key = `${entry?.key || ""}:${name}:${detail.reason || ""}`;
    const previous = this.metrics.get(key);
    if (previous) { const count = previous.detail.count + 1; Object.assign(previous.detail, detail); previous.detail.count = count; }
    else this.metrics.set(key, { entry, name, detail: { ...detail, count: 1 } });
  }

  // Emits the collected metrics, then one notification per view: `batch` deliberately does not clone the growing full
  // state for snapshot-only subscribers. Consumers receive ordered deltas + channels once, while the store remains the
  // current-state read authority.
  flush({ emitMetric, notify }, batch) {
    for (const metric of this.metrics.values()) emitMetric(metric.entry, metric.name, metric.detail);
    for (const pending of this.notifications.values()) {
      notify(pending.entry, { ...pending.event, type: pending.entry.resync_required ? "gap" : "batch",
        sequence: pending.entry.last_sequence, watermark: pending.entry.last_sequence,
        deltas: pending.deltas, changedChannels: [...pending.channels], batch });
    }
  }
}

// Applies the batch's items in order through `apply` (the store's single-delta path: every item keeps the same
// stream / generation / sequence validation as a standalone delta -- no batch watermark shortcut). Once an item leaves
// its view waiting for a resync, that subscription's later items are refused through `refuseBlocked` without being
// applied. Returns { accepted, aborted, abortPositions, failure }: an item that throws stops the batch there, and
// `failure` is that error (the items before it stay applied).
export function applyBatchItems(items, inheritedSubscription, { apply, entryOf, refuseBlocked }) {
  const abortPositions = [];
  const blockedSubscriptions = new Set();
  let accepted = 0;
  let failure = null;
  try {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const delta = item && typeof item === "object" ? item : {};
      const subscription = String(delta.subscription_id || inheritedSubscription);
      if (blockedSubscriptions.has(subscription)) {
        refuseBlocked(entryOf(subscription), delta);
        continue;
      }
      if (apply({ ...delta, subscription_id: subscription })) {
        accepted += 1;
      } else if (["RESYNC_REQUIRED", "RESYNCING"].includes(entryOf(subscription)?.status)) {
        abortPositions.push(index);
        blockedSubscriptions.add(subscription);
      }
    }
  } catch (error) {
    failure = error;
  }
  return { accepted, aborted: abortPositions.length > 0, abortPositions, failure };
}
