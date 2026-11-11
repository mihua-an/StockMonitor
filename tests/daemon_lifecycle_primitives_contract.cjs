"use strict";
const assert = require("node:assert/strict");
// The startup-handoff lease primitive was removed with its last caller: only Health ensures daemons.
const daemonConnection = require("../service/platform/js/daemon_connection");
assert.equal(daemonConnection.createDaemonStartupLease, undefined);
console.log("Common daemon primitives contract passed");
