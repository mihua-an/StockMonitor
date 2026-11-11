// StockMonitor GAS Web App -- the one entry point (2026-10-07 rebuild).
//
// This script computes nothing. It keeps the phone's input (the Google Form writes 交易明細表單), lets the desktop
// app read and edit those raw rows, and stores and serves the phone's data, which the desktop computes and
// publishes whole (docs/planning/gas_mobile_redesign_2026-10-07.md in the StockMonitor repository).
//
// Every request is a POST with a JSON body {action, token, ...}; nothing is accepted from the URL.
// Two Script Properties hold the passwords:
//   DESKTOP_TOKEN  the desktop app: raw rows, bridge, publishing the phone's data
//   MOBILE_TOKEN   the phone: reading the phone's data, nothing else
// Run setupTokens() once from the editor to create them.

const MOBILE_READ_ACTIONS = new Set([
  'summary', 'holdings', 'historyTrade', 'rank', 'realizedReport',
  'dayTradeEntryTime', 'dayTradeWeekSummary', 'dayTradePriceSummary'
]);

function doGet() {
  return json_({ ok: false, error: '請改用 POST' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (error) {
    return failure_('', error, 'POST body 必須是 JSON');
  }
  const action = String(body.action || '').trim();
  try {
    if (MOBILE_READ_ACTIONS.has(action)) {
      requireToken_('MOBILE_TOKEN', body.token);
      return json_(mobileRead_(action, body));
    }
    requireToken_('DESKTOP_TOKEN', body.token);
    switch (action) {
      case 'mobilePublish': return json_(mobilePublish_(body));
      case 'actualRawTrades': return json_(actualRawTrades_(body));
      // The trade's fields travel as body.trade: its own `action` (買進／賣出) is not the request's action.
      case 'actualTradeCreate': return json_(actualTradeWrite_('create', body.trade || {}));
      case 'actualTradeUpdate': return json_(actualTradeWrite_('update', body.trade || {}));
      case 'actualTradeDelete': return json_(actualTradeWrite_('delete', { trade_id: body.trade_id }));
      case 'actualBridgeStatus':
        if (String(body.client || '').trim() === 'desktop') gasBridgeMarkDesktopSeen_(body.instance_id || '');
        return json_(gasBridgeReadStatus_());
      case 'actualBridgeAck': return json_(gasBridgeAcknowledge_(body.revision, body.instance_id || ''));
      default: return json_({ ok: false, error: `不支援的 action：${action}` });
    }
  } catch (error) {
    return failure_(action, error, String((error && error.message) || error));
  }
}

// Every failed request leaves a record: a caught exception never reaches the Executions log by itself. The record
// (console.error: Executions / Cloud Logging) carries the action, an error id and the stack, never the request body
// (it holds the token); the answer carries the same error id.
function failure_(action, error, message) {
  const errorId = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  console.error(`[doPost ${action || '?'}] failed (error_id=${errorId}): ${(error && error.stack) || error}`);
  return json_({ ok: false, error: message, error_id: errorId });
}

function requireToken_(property, token) {
  const expected = String(PropertiesService.getScriptProperties().getProperty(property) || '').trim();
  // Fail closed: a missing password is a setup error, never an open door.
  if (!expected) throw new Error(`尚未設定 ${property}（請在編輯器執行 setupTokens）`);
  if (String(token || '').trim() !== expected) throw new Error('token 驗證失敗');
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// One-time setup, run from the editor: DESKTOP_TOKEN and MOBILE_TOKEN, each random when absent. Values are never
// logged: read them in 專案設定 → 指令碼屬性.
function setupTokens() {
  const properties = PropertiesService.getScriptProperties();
  const report = [];
  if (!properties.getProperty('DESKTOP_TOKEN')) {
    properties.setProperty('DESKTOP_TOKEN', Utilities.getUuid().replace(/-/g, ''));
    report.push('DESKTOP_TOKEN：新產生，請貼到 App 設定的「GAS Token」');
  } else {
    report.push('DESKTOP_TOKEN：已存在，未變更');
  }
  if (!properties.getProperty('MOBILE_TOKEN')) {
    properties.setProperty('MOBILE_TOKEN', Utilities.getUuid().replace(/-/g, ''));
    report.push('MOBILE_TOKEN：新產生，請貼到 Scriptable 的 StockAPI_config.js');
  } else {
    report.push('MOBILE_TOKEN：已存在，未變更');
  }
  Logger.log(report.join('\n'));
  return report;
}
