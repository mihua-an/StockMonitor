"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Written last into a release directory: the release is complete (every file is in place). Not part of the tree.
const COMPLETE_MARKER = ".release-complete";

function readTree(root, relative = "", files = []) {
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!relative && item.name === COMPLETE_MARKER) continue;
    const name = path.join(relative, item.name);
    if (item.isDirectory()) readTree(root, name, files);
    else if (item.isFile()) files.push([name, fs.readFileSync(path.join(root, name))]);
    else throw new Error(`Renderer assets must be regular files: ${name}`);
  }
  return files;
}

function digest(files) {
  const hash = createHash("sha256");
  for (const [name, bytes] of files) {
    hash.update(JSON.stringify([name.replaceAll(path.sep, "/"), bytes.length]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

// The renderer HTML carries a CSP placeholder instead of addresses: connect-src follows the EFFECTIVE endpoints
// exactly (AGENTS.md section 5 -- never "all local ports", never a second hardcoded port table). The
// placeholder is replaced here, while the release tree is captured, with the resolver's renderer connect sources
// (config/js/network_config.js connectSources); the digest covers the result, so a port change is a new release.
// An unreplaced placeholder is an invalid CSP source and is ignored by the browser: the page can then reach
// nothing but itself -- it fails closed.
const CSP_PLACEHOLDER = "__STOCKMONITOR_CONNECT_SOURCES__";
const LOOPBACK_SOURCE = /^(http|ws):\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

function substituteConnectSources(files, connectSources) {
  const sources = [...new Set(connectSources || [])];
  for (const source of sources) {
    if (!LOOPBACK_SOURCE.test(source)) throw new Error(`refusing a non-loopback renderer connect source: ${source}`);
  }
  const value = sources.join(" ");
  return files.map(([name, bytes]) => (name.endsWith(".html") && bytes.includes(CSP_PLACEHOLDER)
    ? [name, Buffer.from(bytes.toString("utf8").split(CSP_PLACEHOLDER).join(value), "utf8")]
    : [name, bytes]));
}

// loadFile remains the entry mechanism. A content-addressed, complete local tree
// gives HTML, lazy pages, CSS and ES modules one immutable release URL namespace.
// No transport/store globals, generated imports or per-import version strings.
function prepareRendererAssets(sourceDir, cacheDir, { connectSources = [] } = {}) {
  const captured = readTree(sourceDir);
  const files = substituteConnectSources(captured, connectSources);
  const revision = digest(files);
  if (!files.some(([name]) => name === "index.html")) throw new Error("Missing renderer index.html");
  if (digest(readTree(sourceDir)) !== digest(captured)) throw new Error("Renderer changed during capture; restart after the update finishes");
  fs.mkdirSync(cacheDir, { recursive: true });
  // The directory is named by the digest's first 16 hex digits: every renderer URL is under it, and the full 64 put the
  // deepest module of a QA run's userData past Windows' 260-character path limit (the module never loaded and the
  // window stayed on its startup overlay). The marker keeps the full digest: a release of another digest sharing the
  // prefix is not this one and is written again.
  const releaseDir = path.join(cacheDir, revision.slice(0, RELEASE_NAME_LENGTH));
  const marker = path.join(releaseDir, COMPLETE_MARKER);
  if (fs.existsSync(marker) && markerRevision(marker) === revision) {
    if (digest(readTree(releaseDir)) !== revision) throw new Error("Renderer asset cache is incomplete or modified");
    try { const now = new Date(); fs.utimesSync(releaseDir, now, now); } catch (error) { console.warn("[RENDERER ASSETS touch release mtime] failed", error); }
    return releaseDir;
  }
  // Written in place and published by its completion marker -- never a directory rename. Renaming the freshly written
  // staging tree into place blocked the Electron main thread inside MoveFileEx until the App closed (4 of 10
  // launches after a renderer change stuck before WINDOW_CREATED; a file-system filter holding the new files
  // is the likely reason). A directory without its marker is a capture that never finished: it is written again.
  fs.rmSync(releaseDir, { recursive: true, force: true });
  for (const [name, bytes] of files) {
    const target = path.join(releaseDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: "wx" });
  }
  fs.writeFileSync(marker, JSON.stringify({ revision, files: files.length }), { flag: "wx" });
  return releaseDir;
}

const RELEASE_NAME_LENGTH = 16;
const RELEASE_NAME = /^[0-9a-f]{16}$/;

// The full digest a release's completion marker records; "" when the marker cannot be read (the release is written again).
function markerRevision(marker) {
  try { return String(JSON.parse(fs.readFileSync(marker, "utf8")).revision || ""); }
  catch (error) { console.warn("[RENDERER ASSETS read release marker] failed", error); return ""; }
}
const STALE_STAGING_MS = 60 * 60 * 1000;

/**
 * Bounded release cache: every renderer change publishes a new content-addressed release, so old ones must be
 * removed. Keeps the releases in `keep` (what windows show now) and the
 * `keepRecent` most recently used; removes older releases and abandoned `.prepare-*` staging trees. Returns the
 * removed names. A directory that cannot be removed now (a file still open) is left for the next pass.
 */
function pruneRendererAssets(cacheDir, { keep = [], keepRecent = 3, now = Date.now() } = {}) {
  let entries;
  try { entries = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch (error) { /* absent is not an error: no asset cache yet: nothing to prune */ if (error?.code !== "ENOENT") console.warn("[RENDERER ASSETS list cache] failed", error); return []; }
  const keepSet = new Set(keep.filter(Boolean).map((dir) => path.resolve(dir).toLowerCase()));
  const stat = (name) => { try { return fs.statSync(path.join(cacheDir, name)); } catch (error) { console.warn("[RENDERER ASSETS stat release] failed", error); return null; } };
  const releases = entries.filter((e) => e.isDirectory() && RELEASE_NAME.test(e.name))
    .map((e) => ({ name: e.name, mtime: stat(e.name)?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime);
  const doomed = releases.slice(keepRecent).map((r) => r.name)
    .filter((name) => !keepSet.has(path.resolve(cacheDir, name).toLowerCase()));
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(".prepare-") && now - (stat(e.name)?.mtimeMs ?? now) > STALE_STAGING_MS) doomed.push(e.name);
  }
  const removed = [];
  for (const name of doomed) {
    try { fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true }); removed.push(name); } catch (error) { console.warn("[RENDERER ASSETS remove old release] failed", error); }
  }
  return removed;
}

module.exports = { prepareRendererAssets, pruneRendererAssets, CSP_PLACEHOLDER };
