#!/bin/bash
# Interleaved A/B of two checkouts (e.g. a git worktree of the base commit and this one) on a loaded machine:
#   scripts/qa/ui_render_bench/ab.sh <treeA> <treeB> <rounds> <seconds> <outprefix>
# Each round runs one bench in A then one in B; prints medians. Both trees need this bench directory.
A=$1; B=$2; R=$3; SEC=$4; OUT=$5
for i in $(seq 1 $R); do
  for side in A B; do
    tree=$([ $side = A ] && echo "$A" || echo "$B")
    timeout 400 "$(dirname "$0")/../../../node_modules/electron/dist/electron.exe" "$tree/scripts/qa/ui_render_bench/run.cjs" --runs 1 --seconds $SEC --out "${OUT}_${side}_$i.json" >/dev/null 2>&1
  done
done
python - "$OUT" "$R" <<'PY'
import json,sys,statistics as st
out,R=sys.argv[1],int(sys.argv[2])
for side in "AB":
    rs=[json.load(open(f"{out}_{side}_{i}.json")) for i in range(1,R+1)]
    m=lambda f: st.median([f(r) for r in rs])
    print(side, "busy%", m(lambda r:r['main_thread']['busy_percent']), "script", m(lambda r:r['main_thread']['script_ms']), "paint", m(lambda r:r['main_thread']['prepaint_paint_ms']),
      "style", m(lambda r:r['main_thread']['style_ms']), "layout", m(lambda r:r['main_thread']['layout_ms']),
      "lat p50", {k:m(lambda r,k=k:r['latency_p50'][k]) for k in rs[0]['latency_p50']}, "p95", {k:m(lambda r,k=k:r['latency_p95'][k]) for k in rs[0]['latency_p95']},
      "longtask", m(lambda r:r['long_task_total_ms']), "busy list", [r['main_thread']['busy_percent'] for r in rs])
PY
