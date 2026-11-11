// 設定: one category at a time, each owned by its own module with init / dispose (and refresh where it reads the
// backend). This page only switches the categories and runs their lifecycles.

import { readPreference, writePreference } from "../core/preferences.js";
import { disposeSystemSettings, initSystemSettings } from "./settings_system.js";
import { disposeStorageSettings, initStorageSettings } from "./settings_storage.js";
import { disposeCapitalSettings, initCapitalSettings } from "./settings_capital.js";
import { disposeProviderSdkSettings, initProviderSdkSettings } from "./settings_provider_sdk.js";
import { disposeBrokerConnectionSettings, initBrokerConnectionSettings } from "./settings_broker_connections.js";
import { disposeShioajiCredentialSettings, initShioajiCredentialSettings, refreshShioajiCredentialSettings } from "./settings_shioaji_credentials.js";
import { disposeActualAccountSettings, initActualAccountSettings, refreshActualAccountSettings } from "./settings_actual_account.js";
import { disposeDisplaySettings, initDisplaySettings } from "./settings_display.js";
import { disposeSubscriptionSettings, initSubscriptionSettings } from "./settings_subscriptions.js";

let settingsInitialized = false;

// ---- section navigation: one category at a time; the last one is remembered per viewer.
const SETTINGS_SECTION_KEY = "settingsSection";
const SETTINGS_SECTIONS = ["display", "broker", "subscription", "account", "capital", "storage", "system"];

function rememberedSection() {
  const value = readPreference(SETTINGS_SECTION_KEY, { context: "settings section" });
  return SETTINGS_SECTIONS.includes(value) ? value : "display";
}

function showSettingsSection(section) {
  const target = SETTINGS_SECTIONS.includes(section) ? section : "display";
  document.querySelectorAll("[data-settings-section]").forEach((item) => {
    const active = item.dataset.settingsSection === target;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== target;
  });
  writePreference(SETTINGS_SECTION_KEY, target, { context: "settings section" });
}

export function initSettingsPage() {
  settingsInitialized = true;
  document.querySelectorAll("[data-settings-section]").forEach((item) => {
    item.addEventListener("click", () => showSettingsSection(item.dataset.settingsSection));
  });
  showSettingsSection(rememberedSection());
  initDisplaySettings();
  initShioajiCredentialSettings();
  initActualAccountSettings();
  initSystemSettings();
  initStorageSettings();
  initCapitalSettings();
  initProviderSdkSettings();
  initBrokerConnectionSettings();
  initSubscriptionSettings();
}

// Each category reports its own read failure where it is shown.
export async function refreshSettingsPage() {
  if (!settingsInitialized) return;
  await Promise.all([refreshShioajiCredentialSettings(), refreshActualAccountSettings()]);
}

export function disposeSettingsPage() {
  disposeSystemSettings();
  disposeStorageSettings();
  disposeCapitalSettings();
  disposeProviderSdkSettings();
  disposeBrokerConnectionSettings();
  disposeShioajiCredentialSettings();
  disposeActualAccountSettings();
  disposeDisplaySettings();
  disposeSubscriptionSettings();
  settingsInitialized = false;
}
