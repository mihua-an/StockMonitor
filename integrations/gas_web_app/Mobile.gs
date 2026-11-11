// The phone's data: published whole by the desktop (mobilePublish), served as stored (mobileRead_).
//
// Two answers depend on the day the phone asks, so the desktop publishes them per date / per weekday and this
// file only picks the key: historyTrade (the N-th recent weekday) and dayTradeEntryTime (which weekdays to show).

const MOBILE_SHEET = '手機資料';
const MOBILE_META_KEY = '__meta__';
const MOBILE_CHUNK = 40000;   // a cell holds at most 50,000 characters
const MOBILE_TIMEZONE = 'Asia/Taipei';
const MOBILE_WEEKDAY_LABELS = { 1: '週一', 2: '週二', 3: '週三', 4: '週四', 5: '週五' };
// The committed generation of the phone's data (Script Property): readers read only that one.
const MOBILE_GENERATION_KEY = 'MOBILE_GENERATION';
// historyTrade looks back at most this many weekdays (about a year).
const MOBILE_MAX_HISTORY_DAYS = 260;

// A publish never touches the committed data. Under the ScriptLock it appends the new generation's rows
// [generation, key, part, text] below the existing ones, reads them back and checks every entry's parts are all
// there, and only then moves the generation pointer -- the one commit. A failure before that leaves the previous
// generation committed and readable. After the commit, every row older than the previous generation is removed: a
// reader that read the pointer just before this commit still finds its generation.
function mobilePublish_(body) {
  const entries = body && body.entries;
  if (!entries || typeof entries !== 'object') throw new Error('mobilePublish 缺少 entries');
  const keys = Object.keys(entries).sort();
  const texts = [];
  const parts = {};
  keys.forEach(key => {
    const text = JSON.stringify(entries[key]);
    parts[key] = Math.max(1, Math.ceil(text.length / MOBILE_CHUNK));
    for (let part = 0; part < parts[key]; part++) texts.push([key, part, text.slice(part * MOBILE_CHUNK, (part + 1) * MOBILE_CHUNK)]);
  });
  const meta = JSON.stringify({ publishedAt: String(body.published_at || ''), count: keys.length, parts });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const committed = mobileCommittedGeneration_(properties);
    const generation = String(committed + 1);
    const rows = [[generation, MOBILE_META_KEY, 0, meta]].concat(texts.map(([key, part, text]) => [generation, key, part, text]));
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(MOBILE_SHEET) || ss.insertSheet(MOBILE_SHEET);
    const first = sheet.getLastRow() + 1;
    sheet.getRange(first, 1, rows.length, 4).setNumberFormat('@').setValues(rows);
    SpreadsheetApp.flush();
    // Read back before the commit: what readers will assemble must be complete.
    mobileAssemble_(sheet.getRange(first, 1, rows.length, 4).getValues(), generation);
    properties.setProperty(MOBILE_GENERATION_KEY, generation);
    mobileDropOlderThan_(sheet, committed);
    return { ok: true, action: 'mobilePublish', generation: Number(generation), entries: keys.length, rows: rows.length };
  } finally {
    lock.releaseLock();
  }
}

function mobileCommittedGeneration_(properties) {
  const text = String(properties.getProperty(MOBILE_GENERATION_KEY) || '0');
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) throw new Error(MOBILE_GENERATION_KEY + ' 不是有效的版本號：' + text);
  return value;
}

// Rows are appended in generation order, so every row above the first one of generation `keepFrom` (or a newer one)
// is older and goes -- rows of the earlier three-column layout included.
function mobileDropOlderThan_(sheet, keepFrom) {
  const last = sheet.getLastRow();
  if (last < 1) return;
  const generations = sheet.getRange(1, 1, last, 1).getValues().map(([g]) => Number(g));
  const firstKept = generations.findIndex(g => Number.isInteger(g) && g >= keepFrom && g > 0);
  if (firstKept > 0) sheet.deleteRows(1, firstKept);
}

// One generation's entries from its rows. Every entry must have each of the parts the meta row lists: a missing or
// extra part is a damaged publish and an error, never a silently shortened JSON text.
function mobileAssemble_(values, generation) {
  const parts = {};
  values.forEach(([g, key, part, text]) => {
    if (String(g) !== generation) return;
    (parts[key] = parts[key] || {})[String(part)] = String(text);
  });
  if (!parts[MOBILE_META_KEY]) throw new Error('手機資料第 ' + generation + ' 版缺少 ' + MOBILE_META_KEY);
  const meta = JSON.parse(parts[MOBILE_META_KEY]['0']);
  const entries = { [MOBILE_META_KEY]: meta };
  Object.keys(meta.parts || {}).forEach(key => {
    const expected = Number(meta.parts[key]);
    const got = parts[key] || {};
    const pieces = [];
    for (let part = 0; part < expected; part++) {
      if (!(String(part) in got)) throw new Error('手機資料第 ' + generation + ' 版 ' + key + ' 缺少第 ' + part + ' 段（共 ' + expected + ' 段）');
      pieces.push(got[String(part)]);
    }
    if (Object.keys(got).length !== expected) throw new Error('手機資料第 ' + generation + ' 版 ' + key + ' 段數不符（應為 ' + expected + ' 段）');
    entries[key] = pieces.join('');
  });
  return entries;
}

// The committed generation's entries; {} before the first publish.
function mobileEntries_() {
  const generation = mobileCommittedGeneration_(PropertiesService.getScriptProperties());
  if (generation === 0) return {};
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MOBILE_SHEET);
  if (!sheet || sheet.getLastRow() < 1) throw new Error('手機資料第 ' + generation + ' 版已提交，但工作表沒有資料');
  return mobileAssemble_(sheet.getRange(1, 1, sheet.getLastRow(), 4).getValues(), String(generation));
}

function mobileRead_(action, body) {
  const entries = mobileEntries_();
  const meta = entries[MOBILE_META_KEY] || {};
  const stamp = { updateTime: meta.publishedAt || '', publishedAt: meta.publishedAt || '' };
  const stored = key => (key !== MOBILE_META_KEY && entries[key] ? JSON.parse(entries[key]) : null);

  if (action === 'rank') {
    const type = String(body.type || 'spot');
    const side = String(body.side || 'profit');
    if (side !== 'profit' && side !== 'loss') return { error: 'side 只能是 profit 或 loss' };
    return Object.assign(stored(`rank:${type}:${side}`) || { type, side, count: 0, data: [] }, stamp);
  }
  if (action === 'realizedReport') {
    const period = ['week', 'month'].includes(String(body.period || '').toLowerCase()) ? String(body.period).toLowerCase() : 'day';
    return Object.assign(stored(`realizedReport:${period}`) || { period, items: [] }, stamp);
  }
  if (action === 'historyTrade') {
    const offset = mobileHistoryDay_(body.day);
    const date = mobileRecentWeekday_(offset);
    return Object.assign(stored(`historyTrade:${date}`) || mobileEmptyHistory_(date), { day: offset }, stamp);
  }
  if (action === 'dayTradeEntryTime') {
    const mode = String(body.mode || 'week');
    if (mode === 'first' || mode === 'second') {
      const weekday = mobileTargetWeekdays_()[mode === 'first' ? 0 : 1];
      return Object.assign({ mode }, stored(`dayTradeEntryTime:${weekday}`) || {
        weekday, weekdayLabel: MOBILE_WEEKDAY_LABELS[weekday], summary: { longWinRate: '-', shortWinRate: '-' }, items: []
      }, stamp);
    }
    return Object.assign({ mode: 'week' }, stored('dayTradeEntryTime:week') || {
      weekday: '', weekdayLabel: '整週', summary: { longWinRate: '-', shortWinRate: '-' }, items: []
    }, stamp);
  }
  const value = stored(action);
  return value ? Object.assign(value, stamp) : { error: `尚無 ${action} 資料（電腦尚未發布）`, updateTime: stamp.updateTime };
}

// Today's ISO weekday (1 = Monday ... 7 = Sunday) and date, in Taiwan time.
function mobileToday_() {
  const now = new Date();
  return { weekday: Number(Utilities.formatDate(now, MOBILE_TIMEZONE, 'u')), date: now };
}

// historyTrade's `day`: absent is today (0); otherwise a whole number of weekdays back, 0..MOBILE_MAX_HISTORY_DAYS.
function mobileHistoryDay_(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MOBILE_MAX_HISTORY_DAYS) {
    throw new Error('day 必須是 0 到 ' + MOBILE_MAX_HISTORY_DAYS + ' 的整數：' + raw);
  }
  return value;
}

// The N-th most recent weekday, today included, as yyyy/MM/dd.
function mobileRecentWeekday_(offset) {
  const day = new Date(mobileToday_().date.getTime());
  let found = -1;
  // Every 7 calendar days hold 5 weekdays; the bound is reached only by a wrong offset.
  for (let guard = 0; guard <= Math.ceil((offset + 1) * 7 / 5) + 7; guard++) {
    const weekday = Number(Utilities.formatDate(day, MOBILE_TIMEZONE, 'u'));
    if (weekday <= 5) found++;
    if (found === offset) return Utilities.formatDate(day, MOBILE_TIMEZONE, 'yyyy/MM/dd');
    day.setTime(day.getTime() - 24 * 3600 * 1000);
  }
  throw new Error('找不到往前第 ' + offset + ' 個平日');
}

// Which two weekdays the day-trade entry-time widgets show today: the weekend and Monday look at Monday and
// Tuesday, Friday at Friday and Monday, any other day at itself and the next day.
function mobileTargetWeekdays_() {
  const weekday = mobileToday_().weekday;
  if (weekday === 6 || weekday === 7 || weekday === 1) return [1, 2];
  if (weekday === 5) return [5, 1];
  return [weekday, weekday + 1];
}

function mobileEmptyHistory_(date) {
  return {
    date,
    totalSettlement: 0,
    dayTrade: { profit: 0, items: [] },
    normalTrade: { profit: 0, settlement: 0, items: [] },
    usTrade: { profit: 0, settlement: 0, items: [] },
    settlement: { tw: 0, us: 0, dayTrade: 0 }
  };
}
