"use strict";

// The network revision Health starts on. The saved one when it validates. When it no longer does, never the
// defaults -- every service would bind the default ports, possibly reaching another instance's -- but the store's last
// good revision, which the caller records; without a valid one there is nothing safe to start on and this throws.
class NoValidNetworkRevision extends Error {}

function resolveStartupNetwork({ networkConfig, manifest, store, saved, env }) {
  const effective = networkConfig.resolve(manifest, { saved, env });
  const rejected = effective.rejected?.find((layer) => layer.layer === "saved");
  if (!rejected) return { effective, fallback: null };
  let good = null;
  try { good = store.lastGood(); } catch (error) { console.warn("[reading the last good network revision] failed", error); }
  const retry = good && good.revision !== rejected.revision ? networkConfig.resolve(manifest, { saved: good, env }) : null;
  if (!retry || retry.rejected?.some((layer) => layer.layer === "saved")) {
    throw new NoValidNetworkRevision(`the saved network revision ${rejected.revision} is invalid and there is no valid last `
      + `good revision to start on (${JSON.stringify(effective.problems)})`);
  }
  return { effective: retry, fallback: { invalid_revision: rejected.revision, started_on: good.revision, problems: effective.problems } };
}

module.exports = { resolveStartupNetwork, NoValidNetworkRevision };
