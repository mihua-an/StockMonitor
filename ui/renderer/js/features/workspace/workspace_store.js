// Multi-symbol realtime workspace membership: an ordered, deduplicated,
// max-6 list of pinned symbols. This store owns ONLY "which symbols does the
// workspace want displayed" -- it is not a subscription authority, not a
// realtime data store, and not tied to the main page's single selected
// symbol. Subscription ownership (broker-level) is a separate concern driven
// from this store's changes (workspace_view.js).
//
// One workspace mixes Shioaji (Taiwan stock, plain code like "2330") and Futu
// (US/HK/crypto, always market-prefixed like "US.AAPL") symbols; workspace_view.js
// dispatches each to its provider's column runtime (workspace_column_runtime.js
// or workspace_futu_column.js). A Taiwan futures month ("CDF202611") is a Shioaji code too.
import { canonicalMoomooCode } from "../../market_data/moomoo_symbol.js";
import { isFuturesMonthSymbol } from "../../market_data/futures_symbol.js";

// The one place this limit lives: no service enforces or reads it.
export const WORKSPACE_MAX_SYMBOLS = 6;

// A dot is the same provider discriminator used throughout this codebase
// (moomoo_symbol.js, FutuStreamIdentity, etc.): Shioaji codes never contain
// one, Futu codes always do. A bare code the user types without a market
// prefix is treated as Shioaji, not auto-prefixed to a Futu guess -- typing
// "2330" must keep meaning the TWSE stock, matching this workspace's
// pre-existing (v1) behavior.
export function isFutuWorkspaceCode(code) {
  return String(code || "").trim().toUpperCase().includes(".");
}

// Futu codes route through the same canonicalMoomooCode() the rest of the app uses for Futu identifiers, so a
// workspace column and the main Futu product page always agree on one code for the same instrument.
function normalizeCode(code) {
  const trimmed = String(code || "").trim().toUpperCase();
  if (!trimmed) return "";
  return isFutuWorkspaceCode(trimmed) ? canonicalMoomooCode(trimmed) : trimmed;
}

export function isSupportedWorkspaceCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  if (!isFutuWorkspaceCode(normalized)) return /^[0-9]{4,6}[A-Z]?$/.test(normalized) || isFuturesMonthSymbol(normalized);
  return /^[A-Z]{1,4}\.[A-Z0-9]{1,20}$/.test(normalized);
}

export class WorkspaceStore {
  constructor({ maxSymbols = WORKSPACE_MAX_SYMBOLS, initial = [] } = {}) {
    this.maxSymbols = Math.max(1, Number(maxSymbols) || WORKSPACE_MAX_SYMBOLS);
    this.symbols = [];
    this.listeners = new Set();
    for (const code of initial) this._pushUnique(normalizeCode(code));
  }

  _pushUnique(code) {
    if (!isSupportedWorkspaceCode(code) || this.symbols.includes(code)) return false;
    if (this.symbols.length >= this.maxSymbols) return false;
    this.symbols.push(code);
    return true;
  }

  _emit(reason, detail = {}) {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try { listener(snapshot, { reason, ...detail }); }
      catch (error) { console.error("[WorkspaceStore] listener failed", error); }
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list() {
    return this.symbols.slice();
  }

  has(code) {
    return this.symbols.includes(normalizeCode(code));
  }

  isFull() {
    return this.symbols.length >= this.maxSymbols;
  }

  // Returns { ok, code, error } -- never throws, so callers can render a
  // message instead of catching.
  add(codeInput) {
    const code = normalizeCode(codeInput);
    if (!code) return { ok: false, code, error: "請輸入商品代碼" };
    if (!isSupportedWorkspaceCode(code)) return { ok: false, code, error: "商品代碼格式錯誤" };
    if (this.symbols.includes(code)) return { ok: false, code, error: `${code} 已在 Workspace 中` };
    if (this.isFull()) return { ok: false, code, error: `Workspace 最多同時顯示 ${this.maxSymbols} 檔` };
    this.symbols.push(code);
    this._emit("add", { code });
    return { ok: true, code };
  }

  remove(codeInput) {
    const code = normalizeCode(codeInput);
    const index = this.symbols.indexOf(code);
    if (index < 0) return { ok: false, code, error: `${code} 不在 Workspace 中` };
    this.symbols.splice(index, 1);
    this._emit("remove", { code });
    return { ok: true, code };
  }

  replace(indexInput, codeInput) {
    const index = Number(indexInput);
    const code = normalizeCode(codeInput);
    if (!Number.isInteger(index) || index < 0 || index >= this.symbols.length) {
      return { ok: false, code, error: "欄位不存在" };
    }
    if (!code) return { ok: false, code, error: "請輸入商品代碼" };
    if (!isSupportedWorkspaceCode(code)) return { ok: false, code, error: "商品代碼格式錯誤" };
    const previous = this.symbols[index];
    if (code === previous) return { ok: true, code, previous };
    if (this.symbols.includes(code)) return { ok: false, code, error: `${code} 已在 Workspace 中` };
    this.symbols[index] = code;
    this._emit("replace", { code, previous, index });
    return { ok: true, code, previous };
  }

  reorder(fromIndexInput, toIndexInput) {
    const fromIndex = Number(fromIndexInput);
    const toIndex = Number(toIndexInput);
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
      || fromIndex < 0 || fromIndex >= this.symbols.length
      || toIndex < 0 || toIndex >= this.symbols.length) {
      return { ok: false, error: "欄位不存在" };
    }
    if (fromIndex === toIndex) return { ok: true };
    const [moved] = this.symbols.splice(fromIndex, 1);
    this.symbols.splice(toIndex, 0, moved);
    this._emit("reorder", { fromIndex, toIndex });
    return { ok: true };
  }

  setAll(codesInput = []) {
    const next = [];
    for (const raw of codesInput) {
      const code = normalizeCode(raw);
      if (!code || next.includes(code) || !isSupportedWorkspaceCode(code)) continue;
      if (next.length >= this.maxSymbols) break;
      next.push(code);
    }
    this.symbols = next;
    this._emit("set_all", {});
    return this.list();
  }
}
