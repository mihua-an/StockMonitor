// 新版提示 in the bottom dock (user 11-11): when the installed App has learned of a newer release on GitHub (Electron
// main's app_update.js), a 「新版本 vX.Y.Z」 button appears left of 新增交易; pressing it opens that release's page in
// the browser, where the user downloads the new installer. Nothing shows in the App run from source, before the
// first check or when the App is up to date. The button is added here, not in index.html, so it exists only while
// there is something to say.

const BUTTON_ID = "appUpdateNoticeBtn";

function render(dock, state) {
  let button = dock.querySelector(`#${BUTTON_ID}`);
  if (!state?.available || !state.latest) { button?.remove(); return; }
  if (!button) {
    button = dock.ownerDocument.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "dock-update-btn";
    button.addEventListener("click", () => {
      window.desktopAPI.openAppUpdate().then((result) => {
        if (!result?.ok) console.warn(`[APP UPDATE] the release page was not opened: ${result?.error || "no answer"}`);
      }, (error) => console.warn("[APP UPDATE] opening the release page failed", error));
    });
    dock.insertBefore(button, dock.querySelector("#globalAddTradeBtn") || dock.firstChild);
  }
  const text = `新版本 v${state.latest}`;
  if (button.textContent !== text) button.textContent = text;
  button.setAttribute("aria-label", `有新版本 v${state.latest}（目前 v${state.current}），開啟下載頁`);
}

/** Shows the dock's new-version button while main says a newer release exists; returns the unsubscribe. */
export function initUpdateNotice(doc = document) {
  const api = window.desktopAPI;
  const dock = doc.querySelector(".dock-right");
  if (!dock || typeof api?.getAppUpdate !== "function") return () => {};
  const stop = api.onAppUpdateChanged?.((state) => render(dock, state)) || (() => {});
  api.getAppUpdate().then((state) => render(dock, state),
    (error) => console.warn("[APP UPDATE] reading the update state failed", error));
  return stop;
}
