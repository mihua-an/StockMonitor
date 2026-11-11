const { makeTempDir } = require("./support/temp_dirs.cjs");
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createTradeForm } = require('../ui/main/trade_form');
const { createWatchPageStore } = require('../ui/main/watch_page_store');
const payload = { prefill_url: 'https://docs.google.com/forms/d/e/fake/viewform',
  mapping: Object.fromEntries(['trade_date','market','action','code','trade_info','trade_time'].map((k,i)=>[k,`entry.${i}`])),
  trade: {trade_date:'2026-09-19',market:'台股',action:'買進',code:'2330',trade_info:'1@100',trade_time:''} };
const reply = (url, text) => ({ok:true,status:200,url,text:async()=>text});
(async () => {
  for (const [url, content, ok] of [
    ['https://accounts.google.com/login','login',false],
    ['https://docs.google.com/forms/d/e/fake/formResponse','validation error',false],
    ['https://docs.google.com/forms/d/e/fake/formResponse','<div class="freebirdFormviewerViewResponseConfirmationMessage">recorded</div>',true],
    // The current confirmation page: no message class, a "提交其他回應" link back to the form (11-10, two trades
    // were recorded while this was reported unconfirmed).
    ['https://docs.google.com/forms/d/e/fake/formResponse','<title>表單</title><div>已記錄您的回覆。</div><a href="https://docs.google.com/forms/d/e/fake/viewform?usp=form_confirm">提交其他回應</a>',true],
    ['https://docs.google.com/forms/d/e/fake/formResponse','<title>表單</title><a href="https://docs.google.com/forms/d/e/fake/viewform?usp=form_confirm&amp;edit2=x">提交其他回應</a>',true],
  ]) {
    const kept = makeTempDir('stockmonitor-form-page-');
    const form = createTradeForm({fetch:async()=>reply(url,content),notifyTradeChanged(){},unconfirmedPagePath:(name)=>path.join(kept,name)});
    const answer = await form.submitGoogleFormTrade(payload);
    assert.equal(answer.ok,ok,content);
    // A sent form whose answer is not the confirmation page says so -- never reported as a timeout -- and the page
    // is kept for reading.
    if (!ok) {
      assert.equal(answer.reason,'NOT_CONFIRMED'); assert.equal(answer.uncertain,true);
      const pages = fs.readdirSync(kept);
      assert.equal(pages.length,1); assert.match(pages[0],/^google-form-unconfirmed-\d+\.html$/);
      assert.equal(fs.readFileSync(path.join(kept,pages[0]),'utf8'),content);
    } else assert.deepEqual(fs.readdirSync(kept),[],'a confirmed answer keeps nothing');
  }
  const failing = createTradeForm({fetch:async()=>({ok:false,status:500,url:'',text:async()=>''}),notifyTradeChanged(){}});
  assert.equal((await failing.submitGoogleFormTrade(payload)).reason,'HTTP_STATUS');
  for (const bodyStall of [false,true]) {
    let signal;
    const form = createTradeForm({timeoutMs:10,notifyTradeChanged(){},fetch:async (_, options)=>{
      signal=options.signal;
      if (!bodyStall) return new Promise(()=>{});
      return {...reply('', ''),text:()=>new Promise(()=>{})};
    }});
    const result=await form.submitGoogleFormTrade(payload);
    assert.equal(result.uncertain,true); assert.equal(signal.aborted,true); assert.equal(result.reason,'TIMEOUT');
  }
  const root=makeTempDir('audit-storage-');
  const aliases=['STOCK_MONITOR_DATA_ROOT'];
  const old=Object.fromEntries(aliases.map(k=>[k,process.env[k]]));
  try {
    process.env.STOCK_MONITOR_DATA_ROOT=root;
    const catalog={withMetadata:(pages)=>({revision:null,pages})};
    const store=createWatchPageStore(root,{catalog});
    assert.equal(store.load().storage,path.join(root,'preferences','watch_pages.csv'));
    // settings_api is the watch pages' one writer (POST /api/subscriptions/ops); Electron main only reads them.
    assert.deepEqual(Object.keys(store),['load']);
    assert.equal(fs.existsSync(path.join(root,'preferences')),false,'reading must not create the file or its folder');
  } finally {
    aliases.forEach(k=>old[k]===undefined?delete process.env[k]:process.env[k]=old[k]);
    fs.rmSync(root,{recursive:true,force:true});
  }
  const messages=[];
  const source=fs.readFileSync(path.join(__dirname,'../ui/renderer/trade_window.js'),'utf8')
    .replace(/^import .*;\r?\n/gm,'')
    .replace(/^export \{[^}]*\};\r?\n?/m,'');
  const context=vm.createContext({console,AbortController,setTimeout,clearTimeout,window:{addEventListener(){},desktopAPI:{
    submitGoogleFormTrade:async()=>({ok:true})}},
    // The ledger sync answers a business failure: {ok:false}, not a rejection.
    apiPost:async()=>({ok:false}),accountSyncDeadlineMs:async()=>400000,
    document:{getElementById:()=>({})},requestAnimationFrame(){},cancelAnimationFrame(){},
    userFacingMessage:(_error,fallback)=>fallback});
  vm.runInContext(source,context);
  vm.runInContext('getGoogleFormConfig=async()=>({}); editor={reset(){},focusFirst(){}};',context);
  context.record=(message)=>messages.push(message);
  vm.runInContext('setMessage=record',context);
  await vm.runInContext('submitAddTrade({})',context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(messages.at(-1),/背景同步失敗/);
  console.log('PASS audit storage: form confirmation, header/body deadlines, data aliases, read-only watch pages, renderer sync business failure');
})().catch(error=>{console.error(error);process.exitCode=1;});
