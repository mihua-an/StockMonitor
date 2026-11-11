export class GridPolicy {
  ticks(timeAxisPolicy) { return (timeAxisPolicy?.gridTicks?.() || []).map((tick) => ({ ...tick })); }
}
export const DEFAULT_GRID_POLICY = new GridPolicy();
