/** Account daytrade report row ordering policy. */
import { compareAccountSortValue } from "./sort_utils.js";

export function sortDaytradeMetricItems(items, state = {}) {
  const rows = Array.isArray(items) ? [...items] : [];
  const key = state?.key || "bucket_index";
  const direction = state?.direction === "desc" ? "desc" : "asc";
  return rows.sort((a, b) => compareAccountSortValue(a, b, key, direction, "bucket_index"));
}
