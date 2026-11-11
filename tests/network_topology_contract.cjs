"use strict";
// The service graph is the manifest's: Health (health/operations.js) and settings_api (config/network_config.py)
// derive the start order, the address readers and the self-handoff services from config/network_manifest.json by
// the same rule, and a manifest whose graph names an unknown service or has a cycle does not load.
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const nc = require("../config/js/network_config.js");
const ops = require("../health/operations.js");

const manifest = nc.loadManifest();
const node = nc.topology(manifest);
assert.deepEqual([...ops.START_ORDER], node.startOrder);
assert.deepEqual({ ...ops.CLIENTS }, node.clients);
// Every managed service starts after what it depends on and after every address it reads.
const at = Object.fromEntries(node.startOrder.map((sid, index) => [sid, index]));
for (const spec of manifest.services) {
  if (!(spec.service_id in at)) continue;
  for (const dep of [...(spec.depends_on || []), ...(spec.reads_addresses_at_start || [])]) {
    if (dep in at) assert.ok(at[dep] < at[spec.service_id], `${spec.service_id} starts after ${dep}`);
  }
}
assert.deepEqual(node.selfServices.sort(), ["app_api", "service_controller"]);

const python = process.env.PYTHON || "python";
const root = path.resolve(__dirname, "..");
const py = spawnSync(python, ["-c", "import json, sys; sys.path.insert(0, sys.argv[1]); from config import network_config as nc; "
  + "print(json.dumps(nc.topology(nc.load_manifest())))", root], { encoding: "utf8", cwd: root });
assert.equal(py.status, 0, py.stderr);
const pyTopology = JSON.parse(py.stdout);
assert.deepEqual(pyTopology.start_order, node.startOrder, "both languages order the services the same way");
assert.deepEqual(pyTopology.clients, node.clients);
assert.deepEqual(pyTopology.self_services, node.selfServices);

const broken = (edit) => { const copy = JSON.parse(JSON.stringify(manifest)); edit(copy.services); return nc.manifestProblems(copy); };
assert.match(broken((s) => { s.find((x) => x.service_id === "market_runtime").depends_on = ["realtime_api"]; }).join(), /cycle/);
assert.match(broken((s) => { s[0].reads_addresses_at_start = ["nowhere"]; }).join(), /unknown service nowhere/);
console.log("network topology contract passed");
