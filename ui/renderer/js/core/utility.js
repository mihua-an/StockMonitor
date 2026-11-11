import { MarketPriceColorPolicy } from "./market_color_policy.js";

// 共用 DOM、格式化與顯示工具

export function $(id) {
  return document.getElementById(id);
}

export function bindClick(id, handler) {
  const element = $(id);

  if (!element) {
    return;
  }

  element.addEventListener("click", handler);
}

/** 量變 as text and the class of the span it is shown in (the product row writes both, never markup). */
export function volumeChangePctParts(value) {
  const numberValue = value === null || value === undefined || value === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(numberValue)) return { text: "--", className: "volume-change neutral" };
  if (numberValue > 0) return { text: `+${numberValue.toFixed(1)}%`, className: "volume-change up" };
  if (numberValue < 0) return { text: `${numberValue.toFixed(1)}%`, className: "volume-change down" };
  return { text: "0.0%", className: "volume-change neutral" };
}

export function priceMoveClass(current, reference) {
  return MarketPriceColorPolicy.cssClass(current, reference);
}

export function formatMarketAmountMillion(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "--";
  const absolute = Math.abs(numberValue);
  if (absolute >= 1_000_000) return `${(numberValue / 1_000_000).toFixed(2)}兆`;
  if (absolute >= 100) return `${(numberValue / 100).toFixed(2)}億`;
  if (absolute >= 1) return `${numberValue.toFixed(0)}百萬`;
  return `${numberValue.toFixed(2)}百萬`;
}

export function safeText(value) {
  if (value === null || value === undefined || value === "") {
    return "--";
  }

  return escapeHtml(String(value));
}

export function formatChartPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "--";
  }
  return num.toFixed(2);
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "--";
  }

  const numberValue = Number(value);

  // Numeric UI must never leak NaN / Infinity. A missing realtime quote is an
  // unavailable value, not a printable string.
  if (!Number.isFinite(numberValue)) {
    return "--";
  }

  return numberValue.toFixed(2).replace(/\.00$/, "");
}

// One Intl.NumberFormat per (minimum, maximum) pair instead of one per call.
// Constructing a formatter and formatting once measured 19.8us on this machine
// against 0.38us for .format() on a cached one -- 52x. formatQuantity runs once
// per quantity cell, so the 成交量 column alone cost +1.95ms per 74-row product
// list render, ~13x the next most expensive column. The locale and useGrouping
// are fixed, and minimum/maximum are both clamped to 0..12 below, so this map
// holds at most a few dozen entries and never grows with data.
const QUANTITY_FORMATTERS = new Map();

function quantityFormatter(minimum, maximum) {
  const key = `${minimum}:${maximum}`;
  let formatter = QUANTITY_FORMATTERS.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat("en-US", {
      useGrouping: true,
      minimumFractionDigits: minimum,
      maximumFractionDigits: maximum,
    });
    QUANTITY_FORMATTERS.set(key, formatter);
  }
  return formatter;
}

// Quantity/volume formatting is deliberately separate from price/general-number
// formatting. Futu crypto quantities are fixed-point up to 1e-8 in Canonical
// Rust v5; rounding them through formatNumber(...toFixed(2)) turns legitimate
// quantities such as 0.001 BTC into a misleading zero. Integer quantities stay
// compact; fractional ones (US fractional shares, 0.25 股) show their significant
// decimals only (0.1, not 0.10), up to the provider/native precision. Volumes are
// decimal quantities end to end (service/market/shared/volume.py, market_runtime volume.rs).
export function formatQuantity(value, { quantityScale = null, maxFractionDigits = null } = {}) {
  if (value === null || value === undefined || value === "") return "--";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "--";

  const scale = Number(quantityScale);
  let scaleDigits = null;
  if (Number.isFinite(scale) && scale >= 1) {
    const power = Math.log10(scale);
    if (Number.isInteger(power)) scaleDigits = Math.max(0, Math.min(12, power));
  }
  const requestedDigits = maxFractionDigits === null || maxFractionDigits === undefined || maxFractionDigits === ""
    ? Number.NaN
    : Number(maxFractionDigits);
  // A volume shows whole units, the fraction cut (user 11-09); below one unit the fraction is all there is, so it stays.
  if (!Number.isFinite(requestedDigits) && scaleDigits === null && Math.abs(numberValue) >= 1) {
    return quantityFormatter(0, 0).format(Math.trunc(numberValue));
  }
  const maximum = Number.isFinite(requestedDigits)
    ? Math.max(0, Math.min(12, Math.trunc(requestedDigits)))
    : (scaleDigits ?? 8);
  return quantityFormatter(0, maximum).format(numberValue);
}

const VOLUME_UNIT_LABELS = { lot: "張", contract: "口", share: "股", coin: "顆", index_lot: "張" };
const MARKET_VOLUME_UNITS = { STK: "lot", FUT: "contract", IDX: "index_lot", US: "share", HK: "share", SH: "share", SZ: "share", CC: "coin" };

/** 張 / 口 / 股 / 顆 for a volume unit ("lot", "share", ...) or, when the payload names none, its market ("STK", "US"). */
export function volumeUnitLabel(unitOrMarket, fallback = "") {
  const key = String(unitOrMarket ?? "").trim();
  const unit = VOLUME_UNIT_LABELS[key] ? key : MARKET_VOLUME_UNITS[key.toUpperCase()];
  return VOLUME_UNIT_LABELS[unit] ?? fallback;
}

export function formatPrice(value) {
  if (value === null || value === undefined || value === "") {
    return "--";
  }

  const text = String(value).trim();

  if (text === "-" || text === "--") {
    return "--";
  }

  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return "--";
  }

  if (numberValue === 0) {
    return "市價";
  }

  return numberValue.toFixed(2);
}

// 成交明細專用：保留真實成交精度，最低 2 位、最高 4 位；只影響顯示，不修改原始資料。
export function formatTradePrice(value) {
  if (value === null || value === undefined || value === "") return "--";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "--";
  const [integerPart, fractionPart = ""] = numberValue.toFixed(4).split(".");
  const trimmed = fractionPart.replace(/0+$/, "");
  return `${integerPart}.${trimmed.padEnd(2, "0")}`;
}

export function formatPercent(value) {
  if (value === null || value === undefined || value === "") {
    return "--";
  }

  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return "--";
  }

  return `${(numberValue * 100).toFixed(1)}%`;
}

/** The element a component marks with data-role="<name>" inside `root`, or null. */
export function byRole(root, name) {
  return root?.querySelector?.(`[data-role="${name}"]`) || null;
}

/**
 * Write a node's text / class / title only when it differs. Assigning textContent replaces the text node even when
 * the text is the same (a DOM mutation, so style, layout and paint work for that node); a component updated on every
 * tick writes through these.
 */
// Number.prototype.toLocaleString(locale) as one cached formatter per locale (toLocaleString builds one each call).
const localeNumberFormats = new Map();
export function localeNumber(value, locale = "zh-TW") {
  let format = localeNumberFormats.get(locale);
  if (!format) { format = new Intl.NumberFormat(locale); localeNumberFormats.set(locale, format); }
  return format.format(value);
}

export function syncText(node, text) {
  if (!node) return false;
  const value = String(text ?? "");
  if (node.textContent === value) return false;
  node.textContent = value;
  return true;
}
export function syncClass(node, className) {
  if (!node || node.className === className) return false;
  node.className = className;
  return true;
}

export function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// The one clamp for the renderer. When the bounds cross (min > max) the lower bound wins, as every copy
// but this one already did.
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
