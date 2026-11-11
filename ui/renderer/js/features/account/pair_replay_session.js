// 帳務 配對回放's session: the pair open under its row, replayed by Market Runtime as 歷史回放 replays a day
// (features/history/engine_replay.js: each print at its own time, 1/2/5/10x, a seek sends only what changed), and the
// day's 加權 and 產業指數 minute levels its 走勢資訊 overlays. It opens at the pair's entry and draws as soon as Market
// Runtime has opened it; how a frame is drawn is pair_replay_view.js's (installPairReplayPresenter).
import { apiGet } from "../../core/api.js";
import { createDashboardContext } from "../../core/dashboard_context.js";
import { EngineReplay, isPermanentReplayOpenError, nsToTaipeiClock } from "../history/engine_replay.js";
import { readRuntimeIndexDay } from "../history/market_session.js";
import { normalizeHistoryClockText } from "../history/history_values.js";
import { endOfSecondNs, taipeiSecondOfDay } from "../history/timeline.js";
import { account, actualAccountReplayState } from "./account_state.js";
import { pairReplayAvailableIn, replayEntryRef } from "./pair_replay_model.js";
import { displayQuote } from "../../core/auction_price.js";

function notInstalled(what, installer) {
  return () => { throw new Error(`pair replay ${what} is not installed (${installer})`); };
}

// The page's views own where an open replay is drawn: pages/account.js installs its view router.
export const replayHooks = {
  renderOrigin: notInstalled("origin renderer", "installPairReplayOrigin"),
};

/** pages/account.js: the function that redraws the view an open replay belongs to. */
export function installPairReplayOrigin(renderOrigin) {
  if (typeof renderOrigin !== "function") throw new TypeError("installPairReplayOrigin needs a function");
  replayHooks.renderOrigin = renderOrigin;
}

// How the replay is drawn: pair_replay_view.js installs it when it loads. renderFrame draws the cards at the replay
// time; renderStatus the play bar from Market Runtime's status (null: none open).
const presenter = {
  renderFrame: notInstalled("frame renderer", "installPairReplayPresenter"),
  renderStatus: notInstalled("status renderer", "installPairReplayPresenter"),
};

export function installPairReplayPresenter({ renderFrame, renderStatus }) {
  for (const [name, fn] of Object.entries({ renderFrame, renderStatus })) {
    if (typeof fn !== "function") throw new TypeError(`installPairReplayPresenter needs ${name}`);
  }
  Object.assign(presenter, { renderFrame, renderStatus });
}

// What Market Runtime's refusal of the pair's replay means to the user (歷史回放 says the same).
const UNAVAILABLE_TEXT = Object.freeze({
  NOT_AVAILABLE: "這一天沒有這檔商品的回放資料",
  OLD_FORMAT: "這一天的回放資料是舊格式，無法回放",
  CORRUPT: "這一天的回放資料損毀，無法回放",
  TOO_LARGE: "這一天的回放資料太大，無法回放",
  NOT_CONFIGURED: "Market Runtime 沒有設定歷史資料目錄",
  INVALID_IDENTITY: "商品或日期不正確",
  REPLAY_BUSY: "另一個視窗正在回放，關掉那邊的回放後再開",
});

const state = actualAccountReplayState;

/** The 配對回放's dashboard context: 價量 is 即時報價's own component (PriceFlowComponent), mounted in its card
 * (pair_replay_view.js) and reading the replay's price ladder from here. */
export const pairReplayContext = createDashboardContext({
  id: "replay:pair",
  mode: "replay",
  capabilities: ["historical_tick", "tradeflow", "replay"],
});

// The cards the replay draws itself, and 價量's component.
function redraw() {
  presenter.renderFrame();
  pairReplayContext.dataSource.invalidate("priceFlow");
}

const engine = new EngineReplay({
  onChange: () => redraw(),
  onStatus: (status) => {
    if (!status) return;
    state.playing = Boolean(status.playing);
    state.clock = nsToTaipeiClock(status.position_ns) || state.clock;
    presenter.renderStatus(status);
    // The position under the book and the cursor read the replay time.
    presenter.renderFrame();
  },
  onEnded: (reason) => {
    state.playing = false;
    // Market Runtime ends a replay with the connection that opened it: the next 播放 or move of the bar opens it again
    // where it stood.
    if (reason === "DISCONNECTED") console.warn("[pair replay] the replay ended with its Market Runtime connection; the next move reopens it");
    presenter.renderStatus(null);
    redraw();
  },
});

pairReplayContext.dataSource.setResolver("priceFlow", () => (engine.active && state.loadState === "ready" ? engine.priceFlowViewModel()
  : { availability: "UNAVAILABLE", message: state.loadState === "error" ? state.loadError : "回放載入中", code: String(state.pair?.code || ""),
    identity: "replay|none", priceVolume: {} }));

/** Market Runtime's replay view of the pair's stock ({} while none is open). */
export function pairReplayView() {
  return engine.active ? engine.state() : {};
}

/** The pair can be replayed on the ledger the page shows. */
export function pairReplayAvailable(pair) {
  return pairReplayAvailableIn(account.market, pair);
}

/** Market Runtime's status of the open replay (null: none). */
export function pairReplayStatus() {
  return engine.active ? engine.status : null;
}

// An index's levels from Market Runtime's view of the day (a day not stored yet): its trend's minute closes.
function indexFromRuntime(day) {
  const points = (Array.isArray(day?.trend) ? day.trend : []).map((point) => ({ time: point?.time, price: point?.price ?? point?.close }));
  return { points, prevClose: displayQuote(day?.summary || {}).reference };
}

/**
 * The day's 加權 and the stock's 產業指數 for 走勢資訊: the stored day (/api/history/pair-indexes); an index the store
 * has no levels of is read from Market Runtime's view of the day, which holds it until the next pre-open. An index with
 * neither says why in `note`.
 */
async function loadIndexes(pair) {
  const date = String(pair.realized_date).slice(0, 10);
  let stored = null;
  try {
    stored = await apiGet(`/api/history/pair-indexes?date=${encodeURIComponent(date)}&code=${encodeURIComponent(pair.code)}`);
  } catch (error) {
    console.warn("[pair replay: reading the day's 加權 and 產業指數] failed", error);
  }
  const one = async (part, missingNote) => {
    if (!part?.code) return { name: part?.name || "", points: [], prevClose: null, note: part ? "這檔股票沒有對應的產業指數" : missingNote };
    let found = { points: Array.isArray(part.points) ? part.points : [], prevClose: part.prev_close ?? null };
    if (!found.points.length) found = indexFromRuntime(await readRuntimeIndexDay(date, part.code));
    return { name: part.name, ...found, note: found.points.length ? "" : `這天沒有存到${part.name}的報價` };
  };
  const [market, industry] = await Promise.all([
    one(stored?.market, "加權的報價讀取失敗"),
    one(stored?.industry, "產業指數的報價讀取失敗"),
  ]);
  if (state.pair !== pair) return;
  state.indexes = { market, industry };
  redraw();
}

async function open(pair, clock) {
  const token = ++state.requestToken;
  state.loadState = "loading";
  state.loadError = "";
  redraw();
  const opened = await engine.open({ code: pair.code, tradingDate: String(pair.realized_date).slice(0, 10), clock, speed: state.speed });
  if (token !== state.requestToken) return false;
  if (!opened.ok) {
    if (opened.error === "SUPERSEDED") return false;
    state.loadState = "error";
    state.loadError = UNAVAILABLE_TEXT[opened.error] || `回放開啟失敗（${opened.error}），關閉後重新開啟可再試一次`;
    if (!isPermanentReplayOpenError(opened.error)) console.warn("[pair replay] not opened", { code: pair.code, error: opened.error, detail: opened.detail });
    presenter.renderStatus(null);
    redraw();
    return false;
  }
  state.loadState = "ready";
  presenter.renderStatus(engine.status);
  redraw();
  return true;
}

export function stopPairReplay() {
  if (engine.active && engine.playing) void engine.pause();
}

/** 播放: from where the replay stands (opened again where it stood when Market Runtime had ended it). */
export async function playPairReplay() {
  const pair = state.pair;
  if (!pair) return;
  if (!engine.active && !(await open(pair, state.clock))) return;
  await engine.play();
}

export function setPairReplaySpeed(speed) {
  state.speed = speed;
  if (engine.active) void engine.setSpeed(speed);
}

/** Move the replay to second `second` of the day (the bar, ‹ ›, 回到進場). */
export function seekPairReplay(second) {
  engine.requestSeek(second, movePairReplay);
}

async function movePairReplay(second) {
  const pair = state.pair;
  if (!pair) return;
  const atNs = endOfSecondNs(String(pair.realized_date).slice(0, 10), second);
  if (!atNs) return;
  if (engine.active) await engine.seek(atNs);
  else await open(pair, nsToTaipeiClock(atNs));
}

/** The second of the day the pair's entry is at (回到進場), or null. */
export function pairEntrySecond(pair = state.pair) {
  const clock = normalizeHistoryClockText(replayEntryRef(pair));
  if (!clock) return null;
  const [h, m, s] = clock.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

/** The second of the day the replay stands on, or null. */
export function pairReplaySecond() {
  return engine.active ? taipeiSecondOfDay(engine.status?.position_ns) : null;
}

export function closePairReplay() {
  state.requestToken += 1;
  state.pairId = null;
  state.pair = null;
  state.loadState = "idle";
  state.loadError = "";
  state.playing = false;
  state.clock = "";
  state.indexes = null;
  state.kbarHover = null;
  // close() drops a seek still waiting, settles with Market Runtime's reply and records a failure itself (EngineReplay.command).
  void engine.close();
}

/** Opens `pair`'s replay (from `origin`) at its entry; the same pair from the same origin again closes it. */
export function openPairReplay(pair, origin = "pairs") {
  if (!pairReplayAvailable(pair)) return;
  const pairId = String(pair.id);
  if (state.pairId === pairId && state.origin === origin) {
    closePairReplay();
    replayHooks.renderOrigin();
    // 同一筆再次點擊代表「關閉」。不要再做任何捲動，否則舊 DOM Row 已被重建，
    // 會造成反覆開/關時畫面一次比一次往下漂。
    return false;
  }
  closePairReplay();
  state.pairId = pairId;
  state.pair = pair;
  state.origin = origin;
  state.clock = normalizeHistoryClockText(replayEntryRef(pair));
  replayHooks.renderOrigin();
  void open(pair, state.clock);
  void loadIndexes(pair);
  return true;
}
