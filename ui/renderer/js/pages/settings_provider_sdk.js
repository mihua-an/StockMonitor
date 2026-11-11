// 設定 → 券商帳號 → 券商 SDK: whether Shioaji / moomoo-api is installed, and in an installed App a
// button that installs it from PyPI (ui/main/provider_sdk.js), with the installer's own lines shown as it runs. While
// it installs (and when it fails) the note under the group says so; a finished install floats its result.

import { setNote, setStatus, showToast } from "../core/settings_ui.js";

const $ = (id) => document.getElementById(id);
const ROWS = { shioaji: ["providerSdkShioajiState", "providerSdkShioajiInstall"], futu: ["providerSdkFutuState", "providerSdkFutuInstall"] };
let generation = 0;
let unsubscribeProgress = null;

function setMessage(text, isError = false) {
  setNote($("providerSdkMessage"), text, isError);
}

function render(status) {
  for (const [provider, [stateId, buttonId]] of Object.entries(ROWS)) {
    const installed = status?.providers?.[provider]?.installed;
    const state = $(stateId), button = $(buttonId);
    if (state) setStatus(state, installed === true ? "已安裝" : installed === false ? "未安裝" : (status?.probeError || "無法檢查"), installed === true ? "ok" : installed === false ? "" : "warn");
    if (button) {
      button.hidden = !status?.canInstall || installed !== false;
      button.disabled = Boolean(status?.installing);
    }
  }
  if (!status?.canInstall) setMessage(status?.reason || "");
}

async function refresh(gen) {
  const status = await window.desktopAPI?.getProviderSdkStatus?.();
  if (gen === generation) render(status);
  return status;
}

function appendLog(line) {
  const log = $("providerSdkLog");
  if (!log) return;
  log.hidden = false;
  log.textContent = `${log.textContent}${line}\n`.split("\n").slice(-200).join("\n");
  log.scrollTop = log.scrollHeight;
}

export function initProviderSdkSettings() {
  const gen = ++generation;
  unsubscribeProgress?.();
  unsubscribeProgress = window.desktopAPI?.onProviderSdkProgress?.((payload) => { if (gen === generation) appendLog(payload?.line || ""); }) || null;
  for (const [, buttonId] of Object.values(ROWS)) {
    $(buttonId)?.addEventListener("click", (event) => {
      const provider = event.currentTarget.dataset.provider;
      for (const [, id] of Object.values(ROWS)) { const b = $(id); if (b) b.disabled = true; }
      const log = $("providerSdkLog");
      if (log) log.textContent = "";
      setMessage(`正在安裝 ${provider} SDK，需要網路，可能要幾分鐘 ...`);
      void window.desktopAPI.installProviderSdk(provider).then((result) => {
        if (gen !== generation) return;
        if (result?.ok && !result.error) {
          setMessage("");
          showToast("安裝完成，行情來源已重新啟動");
        } else {
          setMessage(result?.error || "安裝失敗", true);
        }
      }).catch((error) => {
        console.warn("[settings: installing a provider SDK] failed", error);
        setMessage(`安裝失敗：${error?.message || error}`, true);
      }).finally(() => { void refresh(gen).catch((error) => console.warn("[settings: reading provider SDK status] failed", error)); });
    });
  }
  void refresh(gen).catch((error) => {
    console.warn("[settings: reading provider SDK status] failed", error);
    setMessage(`讀取失敗：${error?.message || error}`, true);
  });
}

export function disposeProviderSdkSettings() {
  generation += 1;
  unsubscribeProgress?.();
  unsubscribeProgress = null;
}
