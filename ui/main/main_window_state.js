"use strict";

const fs = require("fs");
const { clamp } = require("./numbers");
const { writeJsonAtomic } = require("../../service/platform/js/atomic_files");

// The main window's geometry: its sizes, the adaptive UI scale, where it opens and its saved state.

const DEFAULT_WINDOW_BOUNDS = {
  width: 1300,
  height: 850,
};

const NORMAL_MIN_WINDOW_SIZE = {
  width: 1100,
  height: 700,
};

const REALTIME_MIN_WINDOW_SIZE = {
  // 監控報價的最小寬度由三個下排區塊的真正可讀寬度決定：
  // 個股走勢 450 + 五檔 390 + 即時盤中資訊 430 + gaps / page padding。
  // 高 DPI 筆電仍會再乘上自動 UI scale，所以不會把實體視窗硬撐過大。
  width: 1300,
  height: 700,
};

const HISTORY_MIN_WINDOW_SIZE = {
  // 歷史資料上排雙走勢 + 下排三區 + 右側商品清單的最小完整可讀寬度。
  width: 1280,
  height: 700,
};

// UI 以 1600×900 的「可用邏輯畫面」為 100% 基準。
// Electron screen.workArea 已經是 DIP（會把 Windows 125% / 150% DPI 縮放算進去），
// 因此 1920×1200、150% 的筆電實際約只有 1280×800 DIP，會自動得到約 80% UI。
const UI_SCALE_REFERENCE_WORKAREA = {
  width: 1600,
  height: 900,
};

const UI_SCALE_LIMITS = {
  min: 0.72,
  max: 1.00,
};

function roundUiScale(value) {
  // 固定到 5% 階梯，避免移動視窗 / taskbar 尺寸變化時產生 0.813... 這種不穩定比例。
  return Math.round(value * 20) / 20;
}

function calculateUiScaleForDisplay(display) {
  const workArea = display?.workAreaSize || display?.workArea || {};
  const width = Number(workArea.width) || UI_SCALE_REFERENCE_WORKAREA.width;
  const height = Number(workArea.height) || UI_SCALE_REFERENCE_WORKAREA.height;

  const widthScale = width / UI_SCALE_REFERENCE_WORKAREA.width;
  const heightScale = height / UI_SCALE_REFERENCE_WORKAREA.height;
  const rawScale = Math.min(widthScale, heightScale, UI_SCALE_LIMITS.max);

  return clamp(
    roundUiScale(rawScale),
    UI_SCALE_LIMITS.min,
    UI_SCALE_LIMITS.max
  );
}

function scaledWindowSize(size, scale) {
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

function minimumSizeFor(mode) {
  if (mode === "realtime") return REALTIME_MIN_WINDOW_SIZE;
  if (mode === "history") return HISTORY_MIN_WINDOW_SIZE;
  return NORMAL_MIN_WINDOW_SIZE;
}

function readWindowState(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return {};
    return value;
  } catch (error) {
    // absent is not an error: no window state saved yet
    if (error?.code !== "ENOENT") console.warn("[WINDOW STATE] reading the saved window state failed", error);
    return {};
  }
}

// `window`: the window whose bounds are saved.
function writeWindowState(file, window) {
  if (!window || window.isDestroyed()) return;
  try {
    const normalBounds = window.isMaximized()
      ? window.getNormalBounds()
      : window.getBounds();
    const state = {
      ...normalBounds,
      isMaximized: window.isMaximized(),
      adaptiveUiScaleVersion: 1,
    };
    // Temp file + rename: a crash mid-write left a truncated file, which then read as "no state".
    writeJsonAtomic(file, state);
  } catch (error) {
    console.error(`[WINDOW STATE] save failed: ${error.message}`);
  }
}

function isBoundsVisible(screen, bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const right = bounds.x + Math.max(100, bounds.width || 0);
    const bottom = bounds.y + Math.max(100, bounds.height || 0);
    return right > area.x + 80 && bounds.x < area.x + area.width - 80
      && bottom > area.y + 80 && bounds.y < area.y + area.height - 80;
  });
}

function resolveInitialWindowState(screen, stored) {
  // Only a state saved by the adaptive-UI-scale window logic (adaptiveUiScaleVersion 1) is read; an older file
  // is refused with a warning and the window opens at the scaled default size.
  const current = stored && Number(stored.adaptiveUiScaleVersion) === 1;
  if (stored && Object.keys(stored).length && !current) {
    console.warn(`[WINDOW STATE] saved state without adaptiveUiScaleVersion 1 refused; using the default size`);
  }
  const saved = current ? stored : {};
  const rawSavedBounds = {
    x: Number(saved.x),
    y: Number(saved.y),
    width: Number(saved.width),
    height: Number(saved.height),
  };

  const hasSavedSize = Number.isFinite(rawSavedBounds.width) && rawSavedBounds.width > 0
    && Number.isFinite(rawSavedBounds.height) && rawSavedBounds.height > 0;
  const hasSavedPosition = Number.isFinite(rawSavedBounds.x) && Number.isFinite(rawSavedBounds.y);

  const candidateBounds = {
    x: hasSavedPosition ? rawSavedBounds.x : 0,
    y: hasSavedPosition ? rawSavedBounds.y : 0,
    width: hasSavedSize ? rawSavedBounds.width : DEFAULT_WINDOW_BOUNDS.width,
    height: hasSavedSize ? rawSavedBounds.height : DEFAULT_WINDOW_BOUNDS.height,
  };

  const useSavedPosition = hasSavedPosition && isBoundsVisible(screen, candidateBounds);
  const display = useSavedPosition
    ? screen.getDisplayMatching(candidateBounds)
    : screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const scale = calculateUiScaleForDisplay(display);
  const minimum = scaledWindowSize(NORMAL_MIN_WINDOW_SIZE, scale);
  const scaledDefault = scaledWindowSize(DEFAULT_WINDOW_BOUNDS, scale);

  // 沒有保存尺寸時（第一次啟動），連視窗本身也跟 UI 比例一起縮小。
  const requestedWidth = hasSavedSize ? rawSavedBounds.width : scaledDefault.width;
  const requestedHeight = hasSavedSize ? rawSavedBounds.height : scaledDefault.height;
  const width = clamp(Math.round(requestedWidth), Math.min(minimum.width, workArea.width), workArea.width);
  const height = clamp(Math.round(requestedHeight), Math.min(minimum.height, workArea.height), workArea.height);

  let x;
  let y;
  if (useSavedPosition) {
    x = clamp(Math.round(rawSavedBounds.x), workArea.x, workArea.x + Math.max(0, workArea.width - width));
    y = clamp(Math.round(rawSavedBounds.y), workArea.y, workArea.y + Math.max(0, workArea.height - height));
  } else {
    x = Math.round(workArea.x + (workArea.width - width) / 2);
    y = Math.round(workArea.y + (workArea.height - height) / 2);
  }

  return { bounds: { x, y, width, height }, display, scale, minimum };
}

module.exports = {
  calculateUiScaleForDisplay, scaledWindowSize, minimumSizeFor, readWindowState, writeWindowState,
  resolveInitialWindowState,
};
