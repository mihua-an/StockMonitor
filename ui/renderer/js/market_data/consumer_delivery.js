// Handing one view event to one consumer: the state attached as the consumer asked for it (every event, or only a
// snapshot's), the entry description read lazily, and the consumer isolated -- a throw is reported through `onFault`
// (once per fault streak marked by `firstOfStreak`) and never reaches the other consumers. Answers whether the consumer
// took the event.
export function deliverToConsumer({ callback, delivery, event, snapshotOf, describeOf, onFault }) {
  try {
    const includeState = delivery?.stateDelivery !== "snapshot-only" || event.type === "snapshot";
    const delivered = { ...event, state: includeState ? snapshotOf() : undefined };
    Object.defineProperty(delivered, "entry", { get: describeOf, enumerable: true });
    callback(delivered);
    if (delivery?.faulted) delivery.faulted = false;
    return true;
  } catch (error) {
    const firstOfStreak = Boolean(delivery && !delivery.faulted);
    if (delivery) delivery.faulted = true;
    onFault(error, firstOfStreak);
    return false;
  }
}
