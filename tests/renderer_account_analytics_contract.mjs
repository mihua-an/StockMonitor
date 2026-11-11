import assert from 'node:assert/strict';
import * as current from '../ui/renderer/js/features/account/analytics.js';
import * as original from './fixtures/account_analytics_phase3_reference.mjs';
const rows=[{date:'2026-09-04',normal_profit:100,daytrade_profit:-20},{date:'2026-09-03',normal_profit:-80,daytrade_profit:5},
  {date:'',normal_profit:7,daytrade_profit:7},{date:'2026-09-01',normal_profit:null,daytrade_profit:'x'}];
const encode=value=>JSON.stringify(value instanceof Map?[...value]:value);
let cases=0;
// Deliberate difference from the reference (10-19): no hold time is "-", never "0m".
function corrected(name,args,value){
  if(name==='daytradeFormatHoldMinutes'&&(args[0]===null||args[0]===''))return '-';
  return value;
}
function compare(name,...args){assert.equal(encode(current[name](...args)),encode(corrected(name,args,original[name](...args))),name);cases++;}
for(const list of [[],rows,rows.slice(0,1),[...rows,...rows]])compare('buildCumulativeRealizedByDate',list);
for(const value of [null,undefined,'',0,-1,1,1.2,100000,NaN])compare('daytradeFormatHoldMinutes',value);
// The 當沖 statistics are the ledger's (`<ledger>/daytrade-analysis`): the page module computes none of them.
for(const name of ['summarizeDaytradeRows','buildDaytradeMiniReport','buildDaytradePeriodMetrics','buildDaytradeWeekdayMetrics',
  'buildDaytradeBucketMetrics','daytradeHoldMinute','daytradeEntryMinute','actualWeekdayNumber','parseActualTradeDate'])
  assert.equal(current[name],undefined,`analytics.js exports ${name}`);
console.log(`account analytics: ${cases} original/current calculations match; no 當沖 statistic is computed in the renderer`);
