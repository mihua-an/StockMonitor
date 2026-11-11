// 交易明細表單: the raw trades. The Google Form appends rows; the desktop reads them all and creates / edits /
// deletes rows. A revision number in Script Properties tells the desktop that something changed (the bridge).

const RAW_SHEET = '交易明細表單';
const BRIDGE_TIMEZONE = 'Asia/Taipei';
const BRIDGE_KEYS = Object.freeze({
  RAW_REVISION: 'GAS_BRIDGE_RAW_REVISION',
  RAW_CHANGED_AT: 'GAS_BRIDGE_RAW_CHANGED_AT',
  RAW_CHANGE_REASON: 'GAS_BRIDGE_RAW_CHANGE_REASON',
  DESKTOP_REVISION: 'GAS_BRIDGE_DESKTOP_REVISION',
  DESKTOP_ACK_AT: 'GAS_BRIDGE_DESKTOP_ACK_AT',
  DESKTOP_LAST_SEEN_AT: 'GAS_BRIDGE_DESKTOP_LAST_SEEN_AT',
  DESKTOP_INSTANCE_ID: 'GAS_BRIDGE_DESKTOP_INSTANCE_ID'
});

// ----------------------------------------------------------------------------------------------- raw rows

function rawSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RAW_SHEET);
  if (!sheet) throw new Error(`找不到「${RAW_SHEET}」`);
  return sheet;
}

function rawColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) throw new Error(`${RAW_SHEET}沒有欄位`);
  const map = {};
  sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].forEach((header, index) => {
    map[String(header || '').trim().replace(/\s+/g, '')] = index + 1;
  });
  // The sheet's current headers, one name each.
  const need = name => {
    if (!map[name]) throw new Error(`找不到欄位：${name}`);
    return map[name];
  };
  return {
    date: need('交易日期'),
    market: need('市場'),
    action: need('交易類型'),
    code: need('股號'),
    info: need('交易資訊'),
    time: need('交易時間'),
    tradeId: need('trade_id'),
    timestamp: map['時間戳記'] || 0
  };
}

// One page of the raw rows: data rows [offset, offset + limit) of only the seven columns the desktop reads, with the
// raw revision. The page is read under the script lock every desktop write and revision change takes, so its rows and
// revision are one state; a hand edit, a row insert / delete and a form submit raise the revision (the triggers), and
// the desktop reads every page, and the status after them, at one revision. Reading every column of every row
// in one request ran ~30 s for 1,153 rows, and Google then sent the answer back to /exec as a GET -- doGet's
// 「請改用 POST」 -- so the desktop never got it (R14-25).
const RAW_PAGE_MAX = 500;

function actualRawTrades_(body) {
  const offset = bridgeInteger_(body && body.offset, -1);
  const limit = bridgeInteger_(body && body.limit, -1);
  if (offset < 0 || limit < 1 || limit > RAW_PAGE_MAX) throw new Error(`需要 offset（0 以上）與 limit（1～${RAW_PAGE_MAX}）`);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return rawTradesPage_(offset, limit);
  } finally {
    lock.releaseLock();
  }
}

function rawTradesPage_(offset, limit) {
  const revision = gasBridgeReadStatus_().raw_revision;
  const sheet = rawSheet_();
  const dataRows = Math.max(0, sheet.getLastRow() - 1);
  const count = Math.max(0, Math.min(limit, dataRows - offset));
  const items = [];
  if (count > 0) {
    const cols = rawColumns_(sheet);
    const column = col => sheet.getRange(offset + 2, col, count, 1).getDisplayValues().map(row => String(row[0] || '').trim());
    const tradeId = column(cols.tradeId), tradeDate = column(cols.date), tradeInfo = column(cols.info);
    const market = column(cols.market), action = column(cols.action), code = column(cols.code), time = column(cols.time);
    for (let index = 0; index < count; index += 1) {
      if (!tradeDate[index] && !tradeInfo[index] && !tradeId[index]) continue;
      items.push({
        trade_id: tradeId[index],
        trade_date: tradeDate[index],
        market: market[index],
        action: action[index],
        code: code[index],
        trade_info: tradeInfo[index],
        trade_time: time[index],
        source_order: offset + index + 2
      });
    }
  }
  return {
    ok: true, offset, limit, total_rows: dataRows, next_offset: offset + count < dataRows ? offset + count : null,
    raw_revision: revision, count: items.length, items, updateTime: new Date().toISOString()
  };
}

function requireTradeFields_(body) {
  ['trade_date', 'market', 'action', 'code', 'trade_info'].forEach(key => {
    if (!String(body[key] || '').trim()) throw new Error(`缺少 ${key}`);
  });
}

function rowOfTrade_(sheet, cols, tradeId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const ids = sheet.getRange(2, cols.tradeId, lastRow - 1, 1).getDisplayValues().flat();
  const index = ids.findIndex(value => String(value || '').trim() === tradeId);
  return index >= 0 ? index + 2 : 0;
}

// The trade's fields over a row's current values: one array, written with one setValues.
function tradeRowValues_(cols, current, body) {
  const values = current.slice();
  values[cols.date - 1] = body.trade_date;
  values[cols.market - 1] = body.market;
  values[cols.action - 1] = body.action;
  values[cols.code - 1] = body.code;
  values[cols.info - 1] = body.trade_info;
  values[cols.time - 1] = body.trade_time || '';
  return values;
}

// A desktop write is one command: the row change and the revision increment happen inside one ScriptLock critical
// section, the row is written with a single setValues, and the answer -- with the new raw_revision -- comes only
// after both. Two writes can no longer pick the same row, and a change can no longer leave the revision behind.
function actualTradeWrite_(kind, body) {
  if (kind !== 'delete') requireTradeFields_(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = rawSheet_();
    const cols = rawColumns_(sheet);
    const width = sheet.getLastColumn();
    let result;
    if (kind === 'create') {
      const row = sheet.getLastRow() + 1;
      const tradeId = 'TRD-' + Utilities.getUuid();
      const values = tradeRowValues_(cols, new Array(width).fill(''), body);
      values[cols.tradeId - 1] = tradeId;
      if (cols.timestamp) values[cols.timestamp - 1] = new Date();
      sheet.getRange(row, 1, 1, width).setValues([values]);
      result = { ok: true, action: 'create', row, trade_id: tradeId };
    } else {
      const tradeId = String(body.trade_id || '').trim();
      if (!tradeId) throw new Error('缺少 trade_id');
      const row = rowOfTrade_(sheet, cols, tradeId);
      if (!row) throw new Error(`找不到 trade_id：${tradeId}`);
      if (kind === 'update') {
        const range = sheet.getRange(row, 1, 1, width);
        range.setValues([tradeRowValues_(cols, range.getValues()[0], body)]);
        result = { ok: true, action: 'update', row, trade_id: tradeId };
      } else {
        sheet.deleteRow(row);
        result = { ok: true, action: 'delete', trade_id: tradeId };
      }
    }
    SpreadsheetApp.flush();
    const bridge = gasBridgeBumpRevisionLocked_(`desktop_trade_${kind}`);
    result.raw_revision = bridge.raw_revision;
    result.changed_at = bridge.changed_at;
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------------------------- triggers

// 提交表單時: give the new row a trade_id and tell the desktop.
function gasBridgeHandleFormSubmit(e) {
  const sheet = e && e.range && e.range.getSheet();
  if (!sheet || sheet.getName() !== RAW_SHEET) return;
  const cols = rawColumns_(sheet);
  const cell = sheet.getRange(e.range.getRow(), cols.tradeId);
  if (!String(cell.getDisplayValue() || '').trim()) cell.setValue('TRD-' + Utilities.getUuid());
  gasBridgeIncrementRevision_('form_submit');
}

// 編輯時: a hand edit of the raw sheet is a change the desktop must read.
function gasBridgeHandleSheetEdit(e) {
  const sheet = e && e.range && e.range.getSheet();
  if (!sheet || sheet.getName() !== RAW_SHEET) return;
  gasBridgeIncrementRevision_('sheet_edit');
}

// 變更時: inserting or deleting rows / columns (or a sheet) moves rows without an edit event, and the desktop reads
// the raw rows by position. An edit (onEdit has it) and a format change move nothing. The event names no sheet, so
// any structural change of the spreadsheet counts.
function gasBridgeHandleStructureChange(e) {
  const type = String((e && e.changeType) || '');
  if (type === 'EDIT' || type === 'FORMAT') return;
  gasBridgeIncrementRevision_('sheet_structure_' + (type || 'unknown').toLowerCase());
}

// Run once from the editor after each deployment: this project's triggers become exactly one form trigger, one edit
// trigger and one change trigger, all on this spreadsheet; any other trigger of the project (a handler that no longer
// exists) goes.
function installTriggers() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('gasBridgeHandleSheetEdit').forSpreadsheet(spreadsheet).onEdit().create();
  ScriptApp.newTrigger('gasBridgeHandleFormSubmit').forSpreadsheet(spreadsheet).onFormSubmit().create();
  ScriptApp.newTrigger('gasBridgeHandleStructureChange').forSpreadsheet(spreadsheet).onChange().create();
  return { ok: true, installed: 3 };
}

// ----------------------------------------------------------------------------------------------- bridge revision

function bridgeNow_() {
  return Utilities.formatDate(new Date(), BRIDGE_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function bridgeInteger_(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function gasBridgeReadStatus_() {
  const p = PropertiesService.getScriptProperties();
  const rawRevision = bridgeInteger_(p.getProperty(BRIDGE_KEYS.RAW_REVISION), 0);
  const desktopRevision = bridgeInteger_(p.getProperty(BRIDGE_KEYS.DESKTOP_REVISION), 0);
  return {
    ok: true,
    raw_revision: rawRevision,
    desktop_revision: desktopRevision,
    pending: rawRevision !== desktopRevision,
    raw_changed_at: p.getProperty(BRIDGE_KEYS.RAW_CHANGED_AT) || '',
    raw_change_reason: p.getProperty(BRIDGE_KEYS.RAW_CHANGE_REASON) || '',
    desktop_ack_at: p.getProperty(BRIDGE_KEYS.DESKTOP_ACK_AT) || '',
    desktop_last_seen_at: p.getProperty(BRIDGE_KEYS.DESKTOP_LAST_SEEN_AT) || '',
    desktop_instance_id: p.getProperty(BRIDGE_KEYS.DESKTOP_INSTANCE_ID) || '',
    server_time: bridgeNow_()
  };
}

// The caller holds the ScriptLock.
function gasBridgeBumpRevisionLocked_(reason) {
  const p = PropertiesService.getScriptProperties();
  const revision = bridgeInteger_(p.getProperty(BRIDGE_KEYS.RAW_REVISION), 0) + 1;
  const now = bridgeNow_();
  p.setProperties({
    [BRIDGE_KEYS.RAW_REVISION]: String(revision),
    [BRIDGE_KEYS.RAW_CHANGED_AT]: now,
    [BRIDGE_KEYS.RAW_CHANGE_REASON]: String(reason || 'raw_changed')
  }, false);
  return { ok: true, raw_revision: revision, changed_at: now, reason: String(reason || 'raw_changed') };
}

// A trigger's change (form submit, hand edit): the revision alone, under the same lock as the desktop's writes.
function gasBridgeIncrementRevision_(reason) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return gasBridgeBumpRevisionLocked_(reason);
  } finally {
    lock.releaseLock();
  }
}

function gasBridgeMarkDesktopSeen_(instanceId) {
  const values = { [BRIDGE_KEYS.DESKTOP_LAST_SEEN_AT]: bridgeNow_() };
  const clean = String(instanceId || '').trim();
  if (clean) values[BRIDGE_KEYS.DESKTOP_INSTANCE_ID] = clean;
  PropertiesService.getScriptProperties().setProperties(values, false);
}

function gasBridgeAcknowledge_(revision, instanceId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = PropertiesService.getScriptProperties();
    const rawRevision = bridgeInteger_(p.getProperty(BRIDGE_KEYS.RAW_REVISION), 0);
    const requested = bridgeInteger_(revision, -1);
    if (requested < 0) return { ok: false, error: 'revision 無效' };
    const accepted = Math.min(requested, rawRevision);
    const now = bridgeNow_();
    const values = {
      [BRIDGE_KEYS.DESKTOP_REVISION]: String(accepted),
      [BRIDGE_KEYS.DESKTOP_ACK_AT]: now,
      [BRIDGE_KEYS.DESKTOP_LAST_SEEN_AT]: now
    };
    const clean = String(instanceId || '').trim();
    if (clean) values[BRIDGE_KEYS.DESKTOP_INSTANCE_ID] = clean;
    p.setProperties(values, false);
    const status = gasBridgeReadStatus_();
    status.acknowledged_revision = accepted;
    return status;
  } finally {
    lock.releaseLock();
  }
}
