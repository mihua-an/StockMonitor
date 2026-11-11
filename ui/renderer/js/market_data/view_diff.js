// A replay view moved by a seek (`view.replay_diff`): Market Runtime's operations from the view this window holds to
// the view at the new time (native/market_runtime/src/view_diff.rs). Each names a path (keys and indices from the top)
// and sets the value there (`set`), removes the field (`remove`), or makes the array there `prepend`, its elements
// `keep[0]..keep[1]`, then `append` (a tape that moved on or back, a newest-first list that grew at its head, a series
// that grew or was cut back).
//
// Applied without touching what did not change: every object and array on an operation's path is copied once, the
// rest of the view is the same objects as before, so a panel whose inputs are the same objects draws nothing.

/** The view `ops` turn `state` into, or throws when an operation does not fit `state` (not the view they were made from). */
export function applyViewDiff(state, ops) {
  if (!state || typeof state !== "object") throw new Error("no view held to apply the diff to");
  if (!Array.isArray(ops)) throw new Error("the diff carries no operations");
  const root = { ...state };
  const copied = new WeakSet([root]);
  const own = (parent, key, path) => {
    const value = parent[key];
    if (!Object.hasOwn(parent, key) || value === null || typeof value !== "object") throw new Error(`${JSON.stringify(path)}: no object or array at ${key}`);
    if (copied.has(value)) return value;
    const copy = Array.isArray(value) ? value.slice() : { ...value };
    copied.add(copy);
    parent[key] = copy;
    return copy;
  };
  for (const op of ops) {
    const path = op?.path;
    if (!Array.isArray(path) || !path.length) throw new Error("an operation without a path");
    let at = root;
    for (const key of path.slice(0, -1)) at = own(at, key, path);
    const last = path.at(-1);
    if (Object.hasOwn(op, "set")) {
      if (Array.isArray(at) && !(Number.isInteger(last) && last < at.length)) throw new Error(`${JSON.stringify(path)}: no element ${last}`);
      at[last] = op.set;
    } else if (op.remove === true) {
      if (Array.isArray(at) || !Object.hasOwn(at, last)) throw new Error(`${JSON.stringify(path)}: no field to remove`);
      delete at[last];
    } else if (Array.isArray(op.keep) && Array.isArray(op.prepend) && Array.isArray(op.append)) {
      const items = at[last];
      const [start, end] = op.keep;
      if (!Array.isArray(items) || !(Number.isInteger(start) && Number.isInteger(end) && start <= end && end <= items.length)) {
        throw new Error(`${JSON.stringify(path)}: keep ${start}..${end} does not fit`);
      }
      at[last] = op.prepend.concat(items.slice(start, end), op.append);
    } else {
      throw new Error(`${JSON.stringify(path)}: an operation that sets, removes or keeps nothing`);
    }
  }
  return root;
}
