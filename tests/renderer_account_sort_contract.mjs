import assert from "node:assert/strict";

// Every sortable 帳務 table shares one comparator: a missing value goes last in both directions (Number(null) sorted
// as 0 before), numbers before text, text numeric-aware, and a real 0 is a value.
const { compareAccountSortValue } = await import("../ui/renderer/js/features/account/sort_utils.js");
const { sortDaytradeMetricItems } = await import("../ui/renderer/js/features/account/reports.js");

const rows = [{ id: "none", v: null }, { id: "zero", v: 0 }, { id: "one", v: 1 }, { id: "minus", v: -1 }, { id: "blank", v: "" }];
const order = (direction) => [...rows].sort((a, b) => compareAccountSortValue(a, b, "v", direction)).map((row) => row.id);
assert.deepEqual(order("asc"), ["minus", "zero", "one", "none", "blank"], "ascending: missing values last");
assert.deepEqual(order("desc"), ["one", "zero", "minus", "none", "blank"], "descending: missing values still last");

const codes = [{ code: "2330" }, { code: "00878" }, { code: "TSLA" }, { code: "aapl" }];
assert.deepEqual([...codes].sort((a, b) => compareAccountSortValue(a, b, "code", "asc")).map((row) => row.code),
  ["00878", "2330", "aapl", "TSLA"], "numbers before text; text ignores case");
assert.deepEqual([{ d: "2026-11-02" }, { d: "2026-11-10" }].sort((a, b) => compareAccountSortValue(a, b, "d", "desc")).map((row) => row.d),
  ["2026-11-10", "2026-11-02"], "dates sort as text");

const tied = [{ code: "B", v: 1 }, { code: "A", v: 1 }];
assert.deepEqual([...tied].sort((a, b) => compareAccountSortValue(a, b, "v", "desc", "code")).map((row) => row.code), ["A", "B"],
  "a tie is ordered by the tiebreak field ascending, in either direction");

const buckets = [{ bucket_index: 2, pnl: 5 }, { bucket_index: 0, pnl: null }, { bucket_index: 1, pnl: 5 }];
assert.deepEqual(sortDaytradeMetricItems(buckets, { key: "pnl", direction: "desc" }).map((row) => row.bucket_index), [1, 2, 0]);
assert.deepEqual(sortDaytradeMetricItems(buckets, {}).map((row) => row.bucket_index), [0, 1, 2], "the buckets' own order by default");

console.log("renderer account sort contract passed");
