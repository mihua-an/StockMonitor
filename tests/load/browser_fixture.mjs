// Production page/component graph in an isolated Chromium document. All API,
// Electron IPC and WebSocket inputs below are local deterministic test doubles.
const realTimeout=window.setTimeout.bind(window);
const delay=ms=>new Promise(resolve=>realTimeout(resolve,ms));
const errors=[],requests=[],ipc=new Set();
const observerCounts={resize:0,mutation:0};
function trackObserver(NativeObserver,key){
  return class {
    constructor(callback){this.inner=new NativeObserver(callback);this.active=false;}
    observe(...args){if(!this.active){this.active=true;observerCounts[key]++;}return this.inner.observe(...args);}
    unobserve(...args){return this.inner.unobserve?.(...args);}
    takeRecords(){return this.inner.takeRecords?.()||[];}
    disconnect(){if(this.active){this.active=false;observerCounts[key]--;}return this.inner.disconnect();}
  };
}
window.ResizeObserver=trackObserver(window.ResizeObserver,'resize');
window.MutationObserver=trackObserver(window.MutationObserver,'mutation');
const baseline=new URL(location.href).searchParams.get('baseline')==='1';
window.addEventListener('error',event=>errors.push(String(event.error||event.message)));
window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
window.desktopAPI={sourceSettings:{enabled_sources:['shioaji'],sources:{shioaji:{api_prefixes:[]},futu:{api_prefixes:['/api/futu']}},startup_steps:{}},
  onWatchPagesChanged(fn){ipc.add(fn);return()=>ipc.delete(fn);}};
window.WebSocket=class {constructor(){throw new Error('Fixture must not connect');}};
window.fetch=async (url,options={})=>{
  requests.push(String(url));
  const target=new URL(url,location.href),pathname=target.pathname;
  let payload={ok:true,items:[],pages:[],signals:[],events:[],points:[],rows:[],total_rows:0,total_pages:1,snapshot_watermark:0};
  if(pathname==='/api/status')payload={ok:true,broker_status:{authority:'persistent_market_daemon',daemon_reachable:true,shioaji_connected:true}};
  if(pathname.includes('watch-pages'))payload={ok:true,pages:[{id:'test',name:'Test',codes:['2330','2344']}]};
  if(pathname.includes('context'))payload={ok:true,code:pathname.split('/').at(-1),trade_flow:{sample_count:0}};
  return {ok:true,status:200,json:async()=>payload};
};
const check=(value,message)=>{if(!value)throw new Error(message);};
window.acceptance=(async()=>{
  const page=await import('../../ui/renderer/js/pages/realtime.js');
  const realtimePage=await import('../../ui/renderer/js/features/realtime/realtime_presentation.js');
  const {appState}=await import('../../ui/renderer/js/core/state.js');
  await import('../../ui/renderer/js/dashboard_components.js');
  const {getDashboardDiagnostics}=await import('../../ui/renderer/js/core/dashboard_runtime.js');
  const {realtimeRenderScheduler}=await import('../../ui/renderer/js/features/realtime/realtime_render_scheduler.js');
  appState.currentPage='realtime';appState.realtimeCodes=['2330','2344'];
  const {realtimeContext}=await import('../../ui/renderer/js/core/dashboard_context.js');
  const passes=[];
  const beforeAfter=[];
  await page.initRealtimePage();await delay(80);
  const selectionHandlerSamples=[];
  for(let index=0;index<20;index++){
    const started=performance.now();
    await realtimePage.selectRealtimeCodeImmediately(index%2?'2330':'2344');
    selectionHandlerSamples.push(performance.now()-started);
    await delay(0);
  }
  const sortedSelectionHandlerSamples=[...selectionHandlerSamples].sort((a,b)=>a-b);
  const selectionPercentile=q=>sortedSelectionHandlerSamples[Math.max(0,Math.ceil(sortedSelectionHandlerSamples.length*q)-1)]??null;
  const selectionHandler={samples:selectionHandlerSamples.length,p50:selectionPercentile(.5),p95:selectionPercentile(.95),p99:selectionPercentile(.99),max:sortedSelectionHandlerSamples.at(-1)};
  const first=getDashboardDiagnostics('realtime');check(first.length===1,'page not mounted');
  // A mounted page must not retain every discarded column-editor row until
  // navigation. Observe the page's cleanup handles and actual UI submissions.
  const columns=await import('../../ui/renderer/js/features/market/quote_presentation.js');
  const originalColumns=columns.getRealtimeQuoteColumnSettings();
  let columnChanges=0;
  const countColumnChanges=()=>columnChanges++;
  window.addEventListener('realtime-product-columns-changed',countColumnChanges);
  const openColumns=()=>window.dispatchEvent(new CustomEvent('open-column-settings',{detail:{profile:'products'}}));
  openColumns();
  const columnHost=document.getElementById('quoteColumnSettingsList');
  const beforeColumnReorders=page.getLiveMarketDataDiagnostics().pageResources?.disposables;
  const editorBefore=page.getLiveMarketDataDiagnostics().columnEditor?.disposables;
  const staleToggle=columnHost.querySelector('[data-column-toggle]');
  const staleKey=staleToggle.dataset.columnToggle;
  for(let i=0;i<20;i++){const rs=[...columnHost.querySelectorAll('[data-column-key]')],dt=new DataTransfer(),last=rs.at(-1);rs[0].querySelector('[data-column-drag]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));last.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));last.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:last.getBoundingClientRect().bottom-1}));}
  const afterColumnReorders=page.getLiveMarketDataDiagnostics().pageResources?.disposables;
  const editorAfter=page.getLiveMarketDataDiagnostics().columnEditor?.disposables;
  check(JSON.stringify(columns.getRealtimeQuoteColumnSettings())===JSON.stringify(originalColumns),'reorder persisted before Done');
  staleToggle.checked=!staleToggle.checked;
  staleToggle.dispatchEvent(new Event('change',{bubbles:true}));
  document.getElementById('quoteColumnDoneBtn').click();
  const staleRowIgnored=columns.getRealtimeQuoteColumnSettings().visible[staleKey]===originalColumns.visible[staleKey];
  check(columnChanges===1,'Done must publish exactly once');
  const savedColumns=columns.getRealtimeQuoteColumnSettings();
  openColumns();
  const toggle=columnHost.querySelector('[data-column-toggle]');toggle.click();
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
  check(JSON.stringify(columns.getRealtimeQuoteColumnSettings())===JSON.stringify(savedColumns),'Escape saved a draft');
  openColumns();
  // Exercise real drag/drop targeting and above/below insertion geometry.
  const rows=[...columnHost.querySelectorAll('[data-column-key]')];
  const dragged=rows[0].dataset.columnKey,target=rows[2],transfer=new DataTransfer();
  rows[0].querySelector('[data-column-drag]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
  target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  const rect=target.getBoundingClientRect();
  target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:rect.bottom+1}));
  const order=[...columnHost.querySelectorAll('[data-column-key]')].map(row=>row.dataset.columnKey);
  check(order.indexOf(dragged)===2,'drag/drop changed insertion order');
  document.getElementById('quoteColumnCancelBtn').click();
  check(columnChanges===1,'cancel or drag published a draft');
  window.removeEventListener('realtime-product-columns-changed',countColumnChanges);
  columns.setRealtimeQuoteColumnSettings(originalColumns);
  const columnEditor={reorders:20,beforeColumnReorders,afterColumnReorders,editorBefore,editorAfter,staleRowIgnored,
    bounded:beforeColumnReorders===afterColumnReorders&&editorBefore===editorAfter};
  for(let cycle=0;cycle<5;cycle++){
    const selectedBefore=page.getLiveMarketDataDiagnostics().selectionIntent.state;
    window.dispatchEvent(new CustomEvent('open-column-settings',{detail:{profile:'products'}}));
    const overlay=document.getElementById('quoteColumnSettingsOverlay');
    check(overlay&&!overlay.hidden,'column settings listener missing after remount');
    overlay.querySelector('#quoteColumnCancelBtn').click();
    check(overlay.hidden,'column settings cancel failed after remount');
    window.dispatchEvent(new CustomEvent('open-column-settings',{detail:{profile:'products'}}));
    page.setRealtimePageVisible(false);
    const disposed=page.getLiveMarketDataDiagnostics();
    beforeAfter.push({cycle,hiddenHosts:getDashboardDiagnostics('realtime').length,hiddenIPC:ipc.size,hiddenDataListeners:realtimeContext.dataSource.listenerCount()});
    // Baseline mode records the old retention policy, then closes its dialog so
    // the next test interaction begins from the same visible state.
    if(baseline)overlay.querySelector('#quoteColumnCancelBtn').click();
    if(!baseline){
    check(overlay.hidden,'page left an open column dialog');
    check(disposed.pageResources.disposables===0,'page listener leak');
    if(disposed.columnEditor)check(disposed.columnEditor.disposables===0,'column editor listener leak');
    check(disposed.pageResources.frames===0&&disposed.pageResources.timers===0,'page scheduled work leak');
    check(disposed.tradePager.requests===0&&disposed.tradePager.timers===0,'pager leak');
    check(!disposed.sessionLifecycle.listener&&!disposed.sessionLifecycle.timer,'status lifecycle leak');
    check(ipc.size===0,'IPC watch listener leak');
    check(getDashboardDiagnostics('realtime').length===0,'component host leak');
    }
    page.resumeRealtimePage();await delay(50);
    const selectedAfter=page.getLiveMarketDataDiagnostics().selectionIntent.state;
    check(selectedBefore.trendCode===selectedAfter.trendCode&&selectedBefore.selectedSymbol===selectedAfter.selectedSymbol,'remount changed selection');
    const mounted=getDashboardDiagnostics('realtime');
    check(mounted[0].slots.length===first[0].slots.length,'changed component layout');
    check(document.querySelector('[data-component-slot="productList"] [data-role="product-list-body"]')?.isConnected,'Shioaji product table lost after remount');
    check(document.querySelectorAll('.dashboard-slot-content .dashboard-slot-content').length===0,'nested tab shells after remount');
    passes.push({cycle,slots:mounted[0].slots.length,ipcListeners:ipc.size});
  }
  page.disposeRealtimePage();await delay(200);
  if(!baseline){
    // The application may finish reporting a startup step after navigation.
    let resumeReport;const reportWait=new Promise(resolve=>resumeReport=resolve);
    const lateInit=page.initRealtimePage({startupFastPath:true,reportStartupUnit:()=>reportWait});
    page.setRealtimePageVisible(false);resumeReport();
    const result=await lateInit;await delay(30);
    check(result.cancelled===true,'late init did not report cancellation');
    check(getDashboardDiagnostics('realtime').length===0,'late init remounted components');
  }
  check(!errors.length,errors.join('\n'));
  if(!baseline){check(realtimeContext.dataSource.listenerCount()===0,'data listener leak');check(realtimeRenderScheduler.pendingCount()===0,'pending scheduler work');}
  // Exercise the real DOM/observer owners, not a reimplemented mock.
  // Each component is repeatedly mounted and destroyed; active observer
  // counts must return to the pre-mount baseline after every cycle.
  const {TickDetailsComponent}=await import('../../ui/renderer/js/core/components/tick_details_component.js');
  const {TradeDetailsComponent}=await import('../../ui/renderer/js/core/components/trade_details_component.js');
  const {EventFeedComponent}=await import('../../ui/renderer/js/core/components/event_feed_component.js');
  const {createDashboardContext}=await import('../../ui/renderer/js/core/dashboard_context.js');
  const observerBaseline={...observerCounts};
  for(const [name,Component,options] of [
    ['TickDetailsComponent',TickDetailsComponent,{manual:true}],
    ['TradeDetailsComponent',TradeDetailsComponent,{}],
    ['EventFeedComponent',EventFeedComponent,{}],
  ]){
    for(let cycle=0;cycle<8;cycle++){
      const host=document.createElement('div');document.body.appendChild(host);
      const context=createDashboardContext({id:`observer:${name}:${cycle}`,mode:'live',capabilities:['tick','bidask','trend']});
      const component=new Component(options);
      component.mount({host,hostType:'detached',context,hydrate:false});
      await delay(20);
      component.destroy();context.destroy();host.remove();await delay(20);
      check(observerCounts.resize===observerBaseline.resize,`${name} leaked ResizeObserver on cycle ${cycle}`);
      check(observerCounts.mutation===observerBaseline.mutation,`${name} leaked MutationObserver on cycle ${cycle}`);
    }
  }
  return {ok:baseline||(columnEditor.bounded&&columnEditor.staleRowIgnored),baseline,columnEditor,selectionHandler,passes,beforeAfter,errors,requests:requests.length,finalIPC:ipc.size,finalDataListeners:realtimeContext.dataSource.listenerCount(),final:page.getLiveMarketDataDiagnostics(),
    observerBaseline,observerFinal:{...observerCounts},observerCycles:24,
    releaseAcceptance:beforeAfter.every(row=>row.hiddenHosts===0&&row.hiddenIPC===0&&row.hiddenDataListeners===0)&&ipc.size===0,
    scope:'Production monitor HTML and dashboard component graph; fake API/IPC, no network/SDK; Chromium offscreen, not foreground GPU'};
})().catch(error=>({ok:false,error:String(error.stack||error),errors,requests}));
