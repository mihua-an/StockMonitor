"use strict";

// 新版提示 (user 11-11; decisions.md 發布管道): the installed App asks GitHub for the newest release of its own repository
// (package.json `repository`) a minute after it starts and once a day after that, and tells the main window when that
// release is newer than itself. It never downloads or installs anything: the user opens the release page in the
// browser and runs the new installer, which installs over this one (data and credentials live outside the install
// directory). The App run from source is updated with git and never asks.

const CHECK_DELAY_MS = 60 * 1000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const NOTES_MAX = 4000;

/** [major, minor, patch] of "1.2.3" or "v1.2.3", or null for anything else (a pre-release tag is not offered). */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

/** Whether version `a` is newer than `b` (both as parseVersion gives them). */
function isNewer(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** "owner/name" of a GitHub repository from package.json's `repository` (a string or { url }), or null. */
function repositorySlug(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  const match = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || ""));
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The release page `url` when it is one of `slug`'s releases on github.com over https, else null: the only kind of
 * page this module ever hands to the browser. */
function releasePage(url, slug) {
  let parsed;
  try { parsed = new URL(String(url || "")); } catch (error) { /* not an error: a value that is no URL is refused below */ void error; return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.port) return null;
  return parsed.pathname.startsWith(`/${slug}/releases/`) ? parsed.href : null;
}

function createAppUpdate({ enabled, currentVersion, repository, fetchImpl, logger = console, onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, clock = () => Date.now() }) {
  const slug = repositorySlug(repository);
  const current = parseVersion(currentVersion);
  const active = Boolean(enabled && slug && current && typeof fetchImpl === "function");
  let state = { enabled: active, current: String(currentVersion || ""), latest: null, url: null, name: null, notes: "",
    publishedAt: null, available: false, checkedAt: null, error: null };
  let timer = null;

  function set(next) {
    const before = state.available ? state.latest : null;
    state = { ...state, ...next };
    if ((state.available ? state.latest : null) !== before) onChange({ ...state });
  }

  // One check: GitHub's newest published release (drafts and pre-releases are never "latest").
  async function check() {
    if (!active) return { ...state };
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "StockMonitor-update-check" },
      });
      if (response.status === 404) {
        // The repository has no published release yet, or is not public: nothing to offer, said in the log.
        logger.warn?.(`[APP UPDATE] ${slug} has no public release (404)`);
        set({ checkedAt: clock(), error: "no_release", available: false });
        return { ...state };
      }
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const release = await response.json();
      const latest = parseVersion(release?.tag_name);
      const url = releasePage(release?.html_url, slug);
      if (!latest || !url) throw new Error(`the newest release is not a version tag with its release page (${String(release?.tag_name).slice(0, 40)})`);
      set({ checkedAt: clock(), error: null, latest: latest.join("."), url, name: String(release?.name || "").slice(0, 200),
        notes: String(release?.body || "").slice(0, NOTES_MAX), publishedAt: release?.published_at || null, available: isNewer(latest, current) });
    } catch (error) {
      logger.warn?.(`[APP UPDATE] checking ${slug} for a newer release failed`, error);
      set({ checkedAt: clock(), error: String(error?.message || error).slice(0, 200) });
    }
    return { ...state };
  }

  function schedule(ms) {
    timer = setTimer(() => { timer = null; void check().finally(() => { if (active) schedule(CHECK_EVERY_MS); }); }, ms);
    timer?.unref?.();
  }

  return {
    state: () => ({ ...state }),
    check,
    start() { if (active && !timer) schedule(CHECK_DELAY_MS); },
    stop() { if (timer) clearTimer(timer); timer = null; },
    /** The release page to open for the newest release, or null when there is no newer one. */
    pageToOpen: () => (state.available ? releasePage(state.url, slug) : null),
  };
}

module.exports = { createAppUpdate, parseVersion, isNewer, repositorySlug, releasePage, CHECK_DELAY_MS, CHECK_EVERY_MS };
