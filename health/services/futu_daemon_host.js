"use strict";

// The Futu provider daemon: everything but its identity and file names is the shared provider host.
const { ProviderDaemonHost } = require("./provider_daemon_host");

const FUTU = Object.freeze({
  name: "futu",
  label: "MOOMOO DAEMON",
  serviceId: "provider_futu",
  script: ["backend", "futu", "run_futu_daemon.py"],
  detachedFlag: "MOOMOO_DAEMON_DETACHED",
  logName: "moomoo_daemon.log",
  ownerFile: "moomoo_daemon_owner.json",
  // OpenD's own teardown can take a minute; the owner record's grace waits for it before terminating.
  budgets: Object.freeze({ stopGraceMs: 90000 }),
});

class FutuDaemonHost extends ProviderDaemonHost {
  constructor(options = {}) {
    super(FUTU, options);
  }
}

module.exports = { FutuDaemonHost };
