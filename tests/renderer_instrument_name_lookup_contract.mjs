import assert from "node:assert/strict";
import * as names from "../ui/renderer/js/core/instrument_names.js";

const {
  displayInstrumentName, resolveInstrumentDisplayName, requestInstrumentNames, catalogRevisionChanged, setCatalogNameSource,
  onInstrumentNamesLearned, setInstrumentNameRetryRecorder, _resetInstrumentNamesForTest,
} = names;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The product catalog is the one owner of a name: the cache has no writer other than the catalog's answers (D03-06).
// Before, rememberInstrumentName let the watch page, a catalog fetch and a search each write it, the last one winning.
assert.equal(names.rememberInstrumentName, undefined, "no module but the catalog lookup writes a name");

// A catalog whose names and revision a test changes.
function fakeCatalog(initial, revision = "r1") {
  const catalog = { revision, names: { ...initial }, asked: [] };
  setCatalogNameSource(async (source, codes) => {
    catalog.asked.push(...codes);
    return { ok: true, revision: catalog.revision, items: codes.map((code) => ({ source, code, name: catalog.names[code] || "" })) };
  });
  return catalog;
}

// A code shown with no catalog name is asked once; the answer is cached at its revision and listeners redraw.
{
  _resetInstrumentNamesForTest();
  const catalog = fakeCatalog({ 6173: "信昌電" });
  const learned = [];
  onInstrumentNamesLearned((code) => learned.push(code));
  assert.equal(displayInstrumentName("shioaji", "6173", null), "6173");
  assert.equal(displayInstrumentName("shioaji", "6173", null), "6173");
  await tick();
  assert.deepEqual(catalog.asked, ["6173"], "asked once per code");
  assert.deepEqual(learned, ["6173"]);
  assert.equal(displayInstrumentName("shioaji", "6173", null), "信昌電");
}

// A Futu code is asked too (the catalog names US.SPCX SpaceX); until it answers, the caller's ticker is shown -- never
// the market-qualified code. The watch list's stored name is not a name source: a Futu row was "US.SPCX" because of it.
{
  _resetInstrumentNamesForTest();
  const catalog = fakeCatalog({ "US.SPCX": "SpaceX" });
  const learned = [];
  onInstrumentNamesLearned((code) => learned.push(code));
  assert.equal(displayInstrumentName("futu", "US.SPCX", "SPCX"), "SPCX", "the ticker until the catalog answers");
  await tick();
  assert.deepEqual(catalog.asked, ["US.SPCX"]);
  assert.deepEqual(learned, ["US.SPCX"]);
  assert.equal(displayInstrumentName("futu", "US.SPCX", "SPCX"), "SpaceX");
  assert.equal(resolveInstrumentDisplayName("shioaji", "US.SPCX", "x"), "x", "a Futu name is not a Shioaji one");
}

// The catalog's name wins over a caller's candidate (a page item or a live row), and a candidate never stops the
// lookup: a code a search or page named still gets the catalog's name.
{
  _resetInstrumentNamesForTest();
  const catalog = fakeCatalog({ 2330: "台積電" });
  assert.equal(displayInstrumentName("shioaji", "2330", "台積電舊名"), "台積電舊名", "the candidate until the catalog answers");
  await tick();
  assert.deepEqual(catalog.asked, ["2330"]);
  assert.equal(resolveInstrumentDisplayName("shioaji", "2330", "台積電舊名"), "台積電");
}

// The catalog renamed a product (a new master): the revision push is the one entry that updates the cache. Before, the
// remembered old name stayed for the life of the window and kept any later lookup from being made.
{
  _resetInstrumentNamesForTest();
  const catalog = fakeCatalog({ 2330: "台積電", 9999: "" });
  const learned = [];
  onInstrumentNamesLearned((code) => learned.push(code));
  requestInstrumentNames("shioaji", ["2330", "9999"]);
  await tick();
  assert.equal(resolveInstrumentDisplayName("shioaji", "2330"), "台積電");
  // A code the catalog does not name is not asked again at that revision.
  displayInstrumentName("shioaji", "9999");
  await tick();
  assert.deepEqual(catalog.asked, ["2330", "9999"], "no name at r1: not asked again at r1");
  catalog.revision = "r2";
  catalog.names = { 2330: "台積電新名", 9999: "新上市" };
  catalogRevisionChanged("r2");
  assert.equal(resolveInstrumentDisplayName("shioaji", "2330", "2330"), "2330", "a name of another revision is not shown");
  await tick();
  assert.deepEqual(catalog.asked, ["2330", "9999", "2330", "9999"], "the codes cached are asked again");
  assert.equal(resolveInstrumentDisplayName("shioaji", "2330"), "台積電新名");
  assert.equal(resolveInstrumentDisplayName("shioaji", "9999"), "新上市");
  assert.deepEqual(learned, ["2330", "2330", "9999"]);
  catalogRevisionChanged("r2");
  await tick();
  assert.equal(catalog.asked.length, 4, "the same revision again changes nothing");
}

// An answer of a revision already replaced never moves the cache back: only the window's first answer sets the
// revision (then Electron main's push moves it).
{
  _resetInstrumentNamesForTest();
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  setCatalogNameSource(async (source, codes) => {
    if (codes.includes("2317")) { await slow; return { ok: true, revision: "r1", items: [{ source, code: "2317", name: "鴻海舊名" }] }; }
    return { ok: true, revision: "r2", items: codes.map((code) => ({ source, code, name: `${code}名` })) };
  });
  requestInstrumentNames("shioaji", ["2317"]);
  await tick();
  requestInstrumentNames("shioaji", ["2454"]);
  await tick();
  assert.equal(resolveInstrumentDisplayName("shioaji", "2454"), "2454名", "the first answer sets the revision (r2)");
  release();
  await tick();
  await tick();
  assert.equal(resolveInstrumentDisplayName("shioaji", "2317", "2317"), "2317", "the late r1 answer is not shown at r2");
  assert.equal(resolveInstrumentDisplayName("shioaji", "2454"), "2454名", "nor does it move the revision back");
}

// The window's lookup and revision push are Electron main's catalog copy (preload.js).
{
  _resetInstrumentNamesForTest();
  const pushed = [];
  const asked = [];
  let revision = "r1";
  globalThis.window = { desktopAPI: {
    productCatalogNames: async (source, codes) => { asked.push(...codes); return { ok: true, revision, items: codes.map((code) => ({ source, code, name: `${code}@${revision}` })) }; },
    onProductCatalogChanged: (listener) => { pushed.push(listener); return () => {}; },
  } };
  try {
    requestInstrumentNames("shioaji", ["1101"]);
    await tick();
    assert.equal(resolveInstrumentDisplayName("shioaji", "1101"), "1101@r1");
    assert.equal(pushed.length, 1, "one subscription to the revision push");
    revision = "r2";
    pushed[0]({ revision: "r2" });
    await tick();
    assert.equal(resolveInstrumentDisplayName("shioaji", "1101"), "1101@r2");
    assert.deepEqual(asked, ["1101", "1101"]);
  } finally {
    delete globalThis.window;
  }
}

// A failed lookup is asked again only after a backoff (it was asked again on every render), then it works -- and the
// retries of that code are one recorded operation, finished by the lookup that answered.
{
  _resetInstrumentNamesForTest();
  const records = [];
  setInstrumentNameRetryRecorder((start) => {
    const record = { start, finished: null };
    records.push(record);
    return { finish: (outcome, extra) => { record.finished = { outcome, ...extra }; } };
  });
  let fail = true;
  const tries = [];
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    setCatalogNameSource(async (source, codes) => {
      tries.push(...codes);
      if (fail) throw new Error("offline");
      return { ok: true, revision: "r1", items: codes.map((code) => ({ source, code, name: "名稱" })) };
    });
    displayInstrumentName("shioaji", "8888", null);
    await tick();
    fail = false;
    displayInstrumentName("shioaji", "8888", null);
    await tick();
    assert.deepEqual(tries, ["8888"], "not asked again inside the backoff");
    clock += 61_000;
    displayInstrumentName("shioaji", "8888", null);
    await tick();
    assert.equal(displayInstrumentName("shioaji", "8888", null), "名稱");
    assert.deepEqual(tries, ["8888", "8888"]);
    assert.equal(records.length, 1, "one operation for the code's retries");
    assert.equal(records[0].start.mechanismId, "renderer.instrument_name_retry");
    assert.deepEqual([records[0].start.identity.source, records[0].start.identity.code], ["shioaji", "8888"]);
    assert.equal(records[0].start.detail.error, "offline");
    assert.deepEqual([records[0].finished.outcome, records[0].finished.attempt], ["succeeded", 1]);
  } finally {
    Date.now = realNow;
  }
}
console.log("instrument name lookup contract ok");
