// 帳務 當沖分析's replay placement: where an open pair replay is drawn (right under the row it was opened from, or the
// ranking's shared host), which source row is marked as the open one, and the row / button actions that open one.
// This module is the only owner of those: the view's rows carry their replay id and whether they can be replayed,
// nothing about which replay is open; the origin of a row is told by the one table below.
import { $ } from "../../core/utility.js";
import { actualAccountReplayState, actualAccountScrollController } from "./account_state.js";
import { bindPairReplayControls, openPairReplay, pairReplayAvailable, replayPanelHtml } from "./pair_replay.js";

// The 當沖 replay origins and the part of the page a row of each sits in, in the order a row is matched.
const ORIGIN_CONTAINERS = [
  ["daytradeWeekday", ".account-daytrade-weekday-detail"],
  ["daytradeBucket", ".account-daytrade-bucket-detail"],
  ["daytradeRanking", ".account-ranking-grid"],
  ["daytrade", ".account-direction-report-card"],
];
const CONTAINER = new Map(ORIGIN_CONTAINERS);

/** Whether `origin` is one of 當沖分析's replay origins (pages/account.js redraws this host for them). */
export function isDaytradeReplayOrigin(origin) {
  return CONTAINER.has(origin);
}

/** The origin of a replayable row: the part of the page it sits in, or null outside all of them. */
function rowOrigin(row) {
  return ORIGIN_CONTAINERS.find(([, selector]) => row.closest(selector))?.[0] ?? null;
}

/** The open replay's source row: the row of its pair in the part of the page it was opened from, or null. */
function sourceRow(pairId, origin) {
  if (!isDaytradeReplayOrigin(origin) || !pairId) return null;
  return [...document.querySelectorAll(`[data-daytrade-replay-id="${CSS.escape(pairId)}"]`)]
    .find((row) => rowOrigin(row) === origin) || null;
}

/** Where the page scrolls to once a replay opens: the ranking's shared host, or the row the replay sits under. */
function scrollTarget(pairId, origin) {
  if (origin === "daytradeRanking") return "#actualDaytradeReplayHost";
  return `${CONTAINER.get(origin)} tr[data-daytrade-replay-id="${CSS.escape(String(pairId ?? ""))}"]`;
}

export function renderDaytradeReplayHost() {
  const mainHost = $("actualDaytradeReplayHost");
  if (!mainHost) return;

  const origin = actualAccountReplayState.origin;
  const pairId = isDaytradeReplayOrigin(origin) ? String(actualAccountReplayState.pairId ?? "") : "";
  const source = sourceRow(pairId, origin);
  document.querySelectorAll("[data-daytrade-replay-id]").forEach((row) => {
    row.classList.toggle("account-active-source-row", row === source);
  });

  mainHost.innerHTML = "";
  document.querySelectorAll("[data-daytrade-bucket-replay-host]").forEach((host) => {
    host.innerHTML = "";
  });
  document.querySelectorAll("[data-daytrade-row-replay-row]").forEach((row) => row.remove());

  if (!pairId || !actualAccountReplayState.pair) return;

  // The 排名 Top 10 share the host under the ranking; every other origin draws right under its source row.
  let targetHost = mainHost;
  if (source && origin !== "daytradeRanking") {
    const replayRow = document.createElement("tr");
    replayRow.className = "account-daytrade-row-replay-row";
    replayRow.dataset.daytradeRowReplayRow = pairId;

    const cell = document.createElement("td");
    cell.colSpan = Math.max(1, source.children.length);

    const host = document.createElement("div");
    host.dataset.daytradeRowReplayHost = pairId;
    cell.appendChild(host);
    replayRow.appendChild(cell);
    source.insertAdjacentElement("afterend", replayRow);
    targetHost = host;
  }

  targetHost.innerHTML = replayPanelHtml(actualAccountReplayState.pair);
  bindPairReplayControls();
}

export function bindDaytradeReplayActions(slice) {
  const rows = Array.isArray(slice?.pairs) ? slice.pairs : [];
  const byId = new Map(rows.map((item) => [String(item.id ?? ""), item]));

  const trigger = (row) => {
    const item = byId.get(String(row?.dataset.daytradeReplayId || ""));
    const origin = row && rowOrigin(row);
    if (!item || !origin || !pairReplayAvailable(item)) return;
    const opened = openPairReplay(item, origin);
    if (!opened) return;
    actualAccountScrollController.openReplay(scrollTarget(item.id, origin));
  };

  document.querySelectorAll("[data-daytrade-replay-id] [data-daytrade-replay-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      trigger(button.closest("[data-daytrade-replay-id]"));
    });
  });

  document.querySelectorAll("tr[data-daytrade-replay-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      trigger(row);
    });
  });
}
