"use strict";

// Role credentials: Health is the only process of the App that mints them, and each child it starts is given exactly
// what its role needs through an allowlisted environment (service/platform/js/child_env.js), never a token file to
// read and never Health's own environment:
//
//   app_api            daemon token (it reads the provider daemons); digests of the client and management tokens
//   realtime_api       the same, plus the market_runtime viewer token (quote_api's RustViewClient reads A's views)
//   provider_shioaji   digests of the daemon and management tokens, plus the market_runtime provider:shioaji token
//   provider_futu      digests of the daemon and management tokens, plus the market_runtime provider:futu token
//   market_runtime     the digest-only credential file, by argument
//   analysis_runtime   its own market_runtime token file, by argument
//   materializer, training job, provider SDK install: nothing
//
// A verifier holds a digest, never the token, so it cannot present that credential to anyone else. Only Health holds
// the management token: no API can stop another API, no daemon can stop an API.
//
// Renewal (docs/decisions.md 角色 token 的更換): a full start -- no process an earlier Health started is still running --
// replaces every role token and the digest file. A Health that restarts while its children still run keeps them: those
// children were started with (or verify) the current ones. Electron main and the web gateway read their tokens at each
// use, so they follow a renewal without restarting.

const daemonAuthModule = require("../../service/platform/js/daemon_auth.js");
const runtimeCredentials = require("../../service/platform/js/runtime_credentials.js");
const { childEnv, pythonServiceThreadDefaults } = require("../../service/platform/js/child_env.js");

// The market_runtime roles each Python service is granted (by service id). Nothing else is granted one.
const API_RUNTIME_ROLES = { app_api: [], realtime_api: ["viewer"] };
const PROVIDER_RUNTIME_ROLES = { shioaji: ["provider:shioaji"], futu: ["provider:futu"] };

function prepareRoleCredentials({ fs, path, processRef = process, authRoot, renew }) {
  const env = processRef.env;
  if (renew) {
    daemonAuthModule.renewRoleTokens({ fs, path, processRef });
    runtimeCredentials.renewTokens(env);
  }
  const daemonAuth = daemonAuthModule.createDaemonAuthentication({ fs, path, processRef });
  const managementAuth = daemonAuthModule.createManagementAuthentication({ fs, path, processRef });
  const controllerAuth = daemonAuthModule.createControllerAuthentication({ fs, path, processRef });
  const clientAuth = daemonAuthModule.createClientAuthentication({ fs, path, processRef });
  const credentialsFile = path.join(authRoot, "market_runtime_credentials.json");
  runtimeCredentials.writeCredentialsFile(credentialsFile, env);
  const runtimeGrant = (roles) => Object.fromEntries(roles.map((role) => [runtimeCredentials.grantEnv(role), runtimeCredentials.loadOrCreateToken(role, env)]));

  // Each is read at every spawn, not captured at boot: an applied network revision changes STOCK_MONITOR_NETWORK_REVISION.
  const roleEnv = {
    api: (serviceId) => {
      const roles = API_RUNTIME_ROLES[serviceId];
      if (!roles) throw new Error(`no credential grant is defined for the API ${serviceId}`);
      return () => childEnv(env, { STOCK_MONITOR_DAEMON_TOKEN: daemonAuth.token,
        STOCK_MONITOR_CLIENT_TOKEN_SHA256: clientAuth.digest, STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256: managementAuth.digest,
        ...runtimeGrant(roles), ...pythonServiceThreadDefaults(env) });
    },
    provider: (source) => {
      const roles = PROVIDER_RUNTIME_ROLES[source];
      if (!roles) throw new Error(`no credential grant is defined for the provider ${source}`);
      return () => childEnv(env, { STOCK_MONITOR_DAEMON_TOKEN_SHA256: daemonAuth.digest,
        STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256: managementAuth.digest, ...runtimeGrant(roles), ...pythonServiceThreadDefaults(env) });
    },
    plain: () => childEnv(env),
  };
  return {
    daemonAuth, managementAuth, controllerAuth, clientAuth, credentialsFile, roleEnv,
    providerFetch: daemonAuthModule.providerClientFetch({ daemonAuth, managementAuth }),
    runtimeControllerToken: runtimeCredentials.loadOrCreateToken("controller", env),
    analysisRuntimeTokenFile: runtimeCredentials.tokenPath("analysis_runtime", env),
  };
}

module.exports = { prepareRoleCredentials, API_RUNTIME_ROLES, PROVIDER_RUNTIME_ROLES };
