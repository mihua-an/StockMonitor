// How the panel writes a number: counts, ages, durations, latencies, sizes, rates, and the tile shape T().
// bytesText / gbText are the whole App's size format (decisions.md 位元組單位: 1024 進位), not the panel's alone:
// settings, 資料中心 and 模型中心 import them too. They return null for a missing value; each page says its own blank.

import { numberOrNull } from "./numbers.js";

export const num = numberOrNull;

export const fmtInt = (v) => (num(v) === null ? null : Math.round(num(v)).toLocaleString("en-US"));

export const amount = (v, unit = "筆") => (num(v) === null ? null : `${fmtInt(v)} ${unit}`);

export function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value > 1e14 ? value / 1e6 : value;   // epoch ns or ms
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function ageText(ms) {
  if (ms === null || !Number.isFinite(ms)) return null;
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 時前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function durationText(ms) {
  if (ms === null || !Number.isFinite(ms)) return null;
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1000))} 秒`;
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 時 ${m % 60} 分` : `${Math.floor(h / 24)} 天 ${h % 24} 時`;
}

export const latencyText = (us) => (num(us) === null ? null : us >= 1000 ? `${(us / 1000).toFixed(us >= 100000 ? 0 : 1)} ms` : `${Math.round(us)} µs`);

export const msText = (ms) => (num(ms) === null ? null : `${Number(ms).toFixed(ms >= 100 ? 0 : 1)} ms`);

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

// A size: whole bytes under 1 KB, then 1 decimal in the largest unit that fits (1 KB = 1024 B). Missing or negative is null.
export function bytesText(bytes) {
  let value = num(bytes);
  if (value === null || value < 0) return null;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1; }
  return unit ? `${value.toFixed(1)} ${BYTE_UNITS[unit]}` : `${Math.round(value)} B`;
}

export const T = (k, v, o = {}) => ({ k, v, ...o });

// Events per second, as a tile says it (the tile names 每秒).
export const rateText = (v) => (num(v) === null ? null : `${v >= 100 ? fmtInt(v) : v.toFixed(1)} 筆`);

// A latency as one long tile that names what it measures, 一般 · P95 · P99 in one line (as the map's 延遲總覽 does).
export const LAT = (label, p50, p95, p99) => [label, [T(`${label} 一般 · P95 · P99`,
  [p50, p95, p99].every((v) => v === null || v === undefined) ? null : [p50, p95, p99].map((v) => v ?? "—").join(" · "), { wide: true })]];

export const GB = 1024 ** 3;

export const gbText = (bytes) => (num(bytes) === null ? null : `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`);

// A latency in µs as a reader compares it: seconds from 1 s, then ms, then µs.
export const durationUs = (us) => (num(us) === null ? null : us >= 1e6 ? `${(us / 1e6).toFixed(2)} s` : latencyText(us));

export const PENDING_TEXT = "等待資料";

export const percentText = (v) => `${v.toFixed(1)}%`;

export function clockText(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
