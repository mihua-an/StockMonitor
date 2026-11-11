"use strict";

// Effective network addresses for one Node process (Health, Electron main), from the one resolver
// (config/js/network_config.js): manifest defaults <- ACTIVE saved network revision <- allowed start overrides.
// Built by the launcher (service/platform/js/launch_runtime.js loadRuntime) once it has set the install flavor and
// VAR_ROOT in the env it was given -- never at require time, where the process env may still name another flavor's
// config root. A port change is applied by Health's controlled restart, and Electron main rediscovers endpoints
// through the bootstrap record (06 section 6). Must never require("electron").

const path = require("path");
const networkConfig = require("./network_config.js");

function loadNetworkRuntime({ env, projectRoot, configRoot }) {
  const effective = networkConfig.effectiveFromDisk({
    env, configRoot, manifestFile: path.join(projectRoot, "config", "network_manifest.json"),
  });
  return {
    effective,
    revision: effective.revision,
    endpoint: (serviceId) => networkConfig.endpoint(effective, serviceId),
    baseUrl: (serviceId) => networkConfig.baseUrl(effective, serviceId),
    controllerBaseUrl: networkConfig.baseUrl(effective, "service_controller"),
  };
}

module.exports = { loadNetworkRuntime };
