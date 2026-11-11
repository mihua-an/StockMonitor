// Futu 個股走勢: the selected product's trend over its US session tabs (日盤 / 夜盤 / 全日) or crypto's 24H.
import { futuReadModel, futuTrendPoints, withMarketRead } from "../../../../core/market_read_adapters.js";
import { numberOrNull } from "../../../../core/numbers.js";
import { formatQuantity, syncClass, syncText } from "../../../../core/utility.js";
import { renderTrendSessionControl } from "../../../../core/trend_session_control.js";
import { TrendChartComponent } from "../../../../core/components/trend_chart_component.js";
import { ensureProductQuoteSearch } from "../../../../core/components/product_quote_header.js";
import { MarketPriceColorPolicy } from "../../../../core/market_color_policy.js";
import { productQuoteReadView } from "../../../../core/market_read_model.js";
import { selectRealtimeView } from "../../../../market_data/realtime.js";
import { formatMoomooDisplaySymbol, futuCanonicalViewSpec } from "../../../../market_data/moomoo_symbol.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";
import { rowsInUsTrendWindow, usTrendPartitionDates, usTrendWindow } from "../../futu_us_trend_window.js";
import { usShownOpen, usWindowFigures, usWindowMoves, usWindowReference, withWindowAverage } from "../../futu_us_session_stats.js";
import { MoomooFocusedComponent } from "./focused_view_base.js";
import { focusedProduct } from "./futu_product.js";
import { CRYPTO_TIME_AXIS, US_TIME_AXES, currentUsSession, isCryptoCode, usDayNote, usTrendTab } from "./us_session_policy.js";

const price=(value)=>numberOrNull(value)===null?"--":numberOrNull(value).toFixed(2);
const hasPricedRows=(rows)=>Array.isArray(rows)&&rows.some((row)=>Number(row?.price??row?.close)>0);
// How bad a partition's view state is: the trend shows the worst of its partitions. An empty partition (a date with
// no prints yet) is as good as a ready one.
const STATE_RANK={ready:0,empty:0,loading:1,stale:2,resyncing:3,error:4};
const rankOf=(state)=>STATE_RANK[state]??STATE_RANK.loading;

// The trend's view state from its partitions' states: the worst of them, except that a failed partition among others
// that still draw is a partial chart (stale) -- the other dates and the failed date's last rows stay on screen --
// and only every partition failing with nothing to draw is an error.
export function partitionTrendPresentation(partitions){
  if(!partitions.length)return{presentation_state:"ready",view_error:null};
  const failed=partitions.filter((part)=>part.presentation_state==="error");
  if(failed.length&&failed.length===partitions.length&&!partitions.some((part)=>part.rows.length)){
    return{presentation_state:"error",view_error:failed[0].view_error||"走勢分割區讀取失敗"};
  }
  const worst=partitions.reduce((state,part)=>{
    const own=part.presentation_state==="error"?"stale":part.presentation_state;
    return rankOf(own)>rankOf(state)?own:state;
  },"ready");
  return{presentation_state:worst==="empty"?"ready":worst,view_error:null};
}

export class MoomooTrendComponent extends MoomooFocusedComponent{
  constructor(){
    super("trend");
    this.lastRows=[];
    this.lastCode="";
    this.sharedTrend=null;
    // The saved tab keeps its storage name; a stored 盤前 / 盤中 / 盤後 tab reads as 日盤 (usTrendTab).
    this.activeSession=usTrendTab(localStorage.getItem("moomooTrendSessionV1")||"full");
    // True from a product switch until its first priced frame has picked the opening tab, or the user picks one.
    // Only that bootstrap may move the tab on its own; a tab the user chose is never changed by a data frame.
    this.sessionBootstrapPending=true;
  }
  renderShell(){
    // The Futu 個股走勢 surface is the trend component's own "us-stock" shell: header with the Futu code box, the
    // chart and the two lines of four; the session buttons go to the slot's tab bar, and stay in their
    // own row above the chart only where there is no tab bar.
    this.sharedTrend=new TrendChartComponent({manual:true,variant:"us-stock"});
    this.sharedTrend.mount({
      host:this.host,
      context:{mode:"live",services:{}},
      hydrate:false,
      slotId:"analysisPrimaryA",
    });
    ensureProductQuoteSearch(this.host.querySelector(".product-quote-header"),"futu");
    const row=this.host.querySelector('[data-role="trend-control-row"]');
    if(row){
      row.dataset.placement=this.actionsHost?"tabs":"row";
      if(this.actionsHost)this.actionsHost.replaceChildren(row);
    }
    this.controlRow=row;
    this.renderSessionControl();
  }

  renderSessionControl(){
    const code=this.lastCode||moomooQuoteStore.selectedCode;
    const crypto=isCryptoCode(code);
    const control=this.controlRow?.querySelector?.('[data-role="session-control"]');
    // The part of 日盤 trading now is written small on the 日盤 button: 盤前 / 盤中 / 盤後, 休市, 收盤 (usDayNote).
    renderTrendSessionControl(control,{
      sessions:crypto?[{key:"full",label:"24H"}]:[{key:"day",label:"日盤",note:usDayNote(this.usSession())},{key:"overnight",label:"夜盤"},{key:"full",label:"全日"}],
      activeKey:crypto?"full":this.activeSession,
      dataAttribute:crypto?"cc-session":"us-session",
      onSelect:(key)=>{
        if(crypto||!key||key===this.activeSession||!US_TIME_AXES[key])return;
        this.activeSession=key;
        this.sessionBootstrapPending=false;
        localStorage.setItem("moomooTrendSessionV1",key);
        this.renderSessionControl();
        this.updateSummary(this.lastCode||moomooQuoteStore.selectedCode);
        this.draw(this.filteredRows(),this.lastCode||moomooQuoteStore.selectedCode);
      },
    });
    // A product with one session (crypto's 24H) has nothing to choose: its controls take no space.
    if(this.controlRow&&control)this.controlRow.hidden=Boolean(control.hidden);
  }
  // A US tab is a trading window over New York date partitions, as Rust A sends them (futu_us_market_session.js, futu_us_trend_window.js): the
  // product's current view is one date, so the trend reads every partition a tab can span and each tab takes its
  // window's minutes.
  partitionViewSpecs(code){
    this.partitionSpecs=isCryptoCode(code)?[]:usTrendPartitionDates(this.usSession()).map((date)=>Object.freeze({...futuCanonicalViewSpec(code),trading_date:date,channels:["trend"]}));
    return this.partitionSpecs;
  }
  // Each partition keeps its rows and its view state. A partition's rows are copied again only when its view's trend
  // changed (the store replaces a view's trend array on a trend delta; a summary notice leaves it, so nothing is
  // rebuilt), and the merged rows are rebuilt only when a partition's rows were. A partition that fails or cannot be read keeps its last rows.
  readPartitions(state,code){
    if(isCryptoCode(code)){
      state.presentation={presentation_state:state.presentation_state??"ready",view_error:state.view_error??null};
      return;
    }
    const copies=this.trendCopies??=new WeakMap();
    const kept=this.partitionRows??=new Map();
    const dates=(this.partitionSpecs||[]).map((spec)=>spec.trading_date).join();
    let changed=this.mergedPartitionRows?.dates!==dates;
    const partitions=(this.partitionSpecs||[]).map((spec)=>{
      const date=spec.trading_date;
      const last=kept.get(date);
      // select() adds the view's status fields to what the projector returns, so the rows travel in an object.
      const read=selectRealtimeView(spec,(view)=>{
        if(last&&view?.trend===last.source)return{rows:last.rows,source:last.source};
        return{source:view?.trend,rows:(Array.isArray(view?.trend)?view.trend:[]).map((row)=>{
          const known=copies.get(row);
          if(known&&known.date===date)return known.copy;
          const copy={...row,trading_date:date,time:`${date}T${row.time||"00:00"}:00`};
          copies.set(row,{date,copy});
          return copy;
        })};
      });
      const failed=!read||read.presentation_state==="error";
      const rows=failed&&last?last.rows:(read?.rows||[]);
      if(!failed&&last?.rows!==rows){kept.set(date,{source:read.source,rows});changed=true;}
      return{date,rows,presentation_state:read?.presentation_state??"loading",view_error:read?.view_error??null};
    });
    for(const date of [...kept.keys()])if(!partitions.some((part)=>part.date===date))kept.delete(date);
    if(changed)this.mergedPartitionRows={dates,rows:partitions.flatMap((part)=>part.rows)};
    state.trend=this.mergedPartitionRows.rows;
    state.presentation=partitionTrendPresentation(partitions);
  }
  // A sends the US session again when it moves (日盤 at 04:00, 夜盤 and 全日 at 20:00, a holiday, a half day's 13:00)
  // also when no print arrives: the 日盤 note is rewritten, a new set of partitions subscribed, a moved window redrawn.
  followUsSession(){
    this.renderSessionControl();
    const code=this.viewCode;
    if(!this.host||!code||isCryptoCode(code))return;
    const us=this.usSession();
    if(usTrendPartitionDates(us).join()!==(this.partitionSpecs||[]).map((spec)=>spec.trading_date).join()){
      this.viewCode=null;
      this.bindRustView(code);
      return;
    }
    // 開盤 and 昨收 go by the phase, which moves at 09:30, 16:00 and 20:00 even when no print arrives.
    const phaseMoved=us?.phase!==this.followedPhase;
    this.followedPhase=us?.phase;
    if(phaseMoved||usTrendWindow(this.activeSession,us).key!==this.windowKey){
      this.updateSummary(this.lastCode||code);
      this.draw(this.filteredRows(),this.lastCode||code);
    }
  }
  // The rows of the active tab's window, worked out once per rows and window (a render asks more than once).
  filteredRows(){
    if(isCryptoCode(this.lastCode||moomooQuoteStore.selectedCode))return this.lastRows;
    const span=usTrendWindow(this.activeSession,this.usSession());
    this.windowKey=span.key;
    const memo=this.filteredMemo;
    if(memo&&memo.rows===this.lastRows&&memo.key===span.key&&memo.session===this.activeSession)return memo.filtered;
    const filtered=rowsInUsTrendWindow(this.lastRows,span);
    this.filteredMemo={rows:this.lastRows,key:span.key,session:this.activeSession,filtered};
    return filtered;
  }
  // The active tab's own figures and what it measures against; null for crypto, which has no tabs (decisions.md).
  windowFigures(prevClose){
    if(isCryptoCode(this.lastCode||moomooQuoteStore.selectedCode))return null;
    const figures=usWindowFigures(this.filteredRows());
    const us=this.usSession();
    const reference=usWindowReference(this.activeSession,this.lastRows,usTrendWindow(this.activeSession,us),prevClose,us);
    return {figures,reference,...usWindowMoves(figures,reference)};
  }
  renderData(payload,code){
    this.lastMarketRead=payload?.marketRead||null;
    this.presentation=payload?.presentation||null;
    const nextCode=String(code||"").toUpperCase();
    // A newly selected US product starts on the live New York session.  A
    // manual tab choice remains intact while the same product is displayed.
    // This avoids restoring "全日" or yesterday's tab when switching symbols.
    if(nextCode!==this.lastCode && !isCryptoCode(nextCode)){
      this.activeSession=usTrendTab(currentUsSession(this.usSession()));
      this.sessionBootstrapPending=true;
      localStorage.setItem("moomooTrendSessionV1",this.activeSession);
    }
    // Readiness describes freshness/connectivity, not whether the last valid
    // materialized projection exists.  Preserve that projection through a
    // transient timeout so the chart cannot flash empty between retries.
    this.lastRows=Array.isArray(payload?.items)?payload.items:[];
    this.lastCode=nextCode;
    // Opening tab only: the live session picked on a product switch may have no prints yet (e.g. 盤前 before
    // the first pre-market trade), so the first priced frame falls back to 全日 rather than an empty chart.
    // "Priced" because a session's minutes exist as empty rows before its first print.
    // After that bootstrap the tab is the user's: a later frame in which the chosen session has no priced row
    // (盤後 before 16:00, 夜盤 before 20:00, a frame whose rows are momentarily partial) used to snap it back
    // to 全日 on every push; such a tab now draws its own empty overlay instead.
    if(!isCryptoCode(nextCode) && this.sessionBootstrapPending && hasPricedRows(this.lastRows)){
      this.sessionBootstrapPending=false;
      if(!hasPricedRows(this.filteredRows())){
        this.activeSession="full";
        localStorage.setItem("moomooTrendSessionV1",this.activeSession);
      }
    }
    this.renderSessionControl();
    this.updateSummary(code);
    this.draw(this.filteredRows(),code);
  }
  updateSummary(code){
    const p=focusedProduct(code);
    const root=this.host?.querySelector(".trend-chart");
    if(!root)return;
    const displayCode=formatMoomooDisplaySymbol(code);
    // One read model for the info row: the lane's own, or one built from the focused quote row; the read view
    // owns every fallback, so nothing below reads the flat row for a quote value. The name / code / 現價 / 漲跌 header
    // is TrendHeaderPresenter's alone, from the view model draw() hands the shared component (D07-04).
    const header=productQuoteReadView(withMarketRead({displayCode},this.lastMarketRead||futuReadModel({code},{quote:p||{},code,include:[]})));
    const window=this.windowFigures(header?.prevClose??null);
    const current=window?.figures.last??header?.currentPrice??null,prev=window?window.reference:header?.prevClose??null;
    const pct=window?window.changePct:p?.changePct??null;
    // RT_DATA volume belongs to each minute bar; the quote snapshot volume is
    // the cumulative session total shared with the Futu order-book header.
    const totalVolume=window?window.figures.volume:header?.stockInfo?.totalVolume;
    const high=window?window.figures.high:header?.stockInfo?.high,low=window?window.figures.low:header?.stockInfo?.low;
    const open=window?usShownOpen(this.usSession(),header?.stockInfo?.open):header?.stockInfo?.open,avg=window?window.figures.average:p?.avg,amplitude=window?window.amplitude:p?.amplitude;
    const metricValues={
      prev:price(prev),open:price(open),high:price(high),low:price(low),avg:price(avg),
      "change-pct":pct===null?"--":`${Math.abs(pct).toFixed(2)}%`,
      amplitude:numberOrNull(amplitude)===null?"--":`${Math.abs(numberOrNull(amplitude)).toFixed(2)}%`,volume:formatQuantity(totalVolume),
    };
    // Coloured like the Taiwan tape: prices against 昨收, 漲幅 by its sign. A cell is written only when its text or
    // colour changed: this runs on every frame.
    const colourOf={open,high,low,avg,"change-pct":current};
    for(const [key,value] of Object.entries(metricValues)){
      const node=root.querySelector(`[data-metric="${key}"]`);
      if(!node)continue;
      syncText(node,value);
      if(key==="prev")syncClass(node,"price-flat");
      else if(key in colourOf)syncClass(node,MarketPriceColorPolicy.cssClass(colourOf[key],prev));
    }
  }
  draw(rows,code){
    const p=focusedProduct(code);
    const crypto=isCryptoCode(code);
    // A tab's 均價 is one running line over its window; crypto trades 24 hours and is one line all day.
    const points=futuTrendPoints(crypto?rows:withWindowAverage(rows));
    const session=crypto?"full":this.activeSession;
    const window=this.windowFigures(p?.prev??null);
    const fallbackRead=futuReadModel({code,trend:rows},{quote:p||{},overrides:{trend:points}});
    const marketRead=this.lastMarketRead?{...this.lastMarketRead,
      session:{...(this.lastMarketRead.session||{}),name:session},
      channels:{...(this.lastMarketRead.channels||{}),trend:{...(this.lastMarketRead.channels?.trend||{}),data:points}}}:fallbackRead;
    this.sharedTrend?.update(withMarketRead({
      // The partitions' view state: a partial or failed partition reads as such, not as a complete chart.
      presentation_state:this.presentation?.presentation_state??null,
      view_error:this.presentation?.view_error??null,
      points,
      marketRead,
      displayCode:formatMoomooDisplaySymbol(code),
      displayName:p?.name||formatMoomooDisplaySymbol(code),
      // The header's 漲跌 / 漲幅: Market Runtime's (futu_product.js).
      metrics:window?{change:window.change,changePct:window.changePct}:{change:p?.change??null,changePct:p?.changePct??null},
      session,
      prevClose:window?.reference??p?.prev??points[0]?.price??null,
      emptyOverlayText:crypto?"尚無 Crypto 24H 走勢資料":"尚無 Futu 美股走勢資料",
      options:{
        adapterType:"equity",
        timeAxisPolicy:crypto?CRYPTO_TIME_AXIS:(US_TIME_AXES[session]||US_TIME_AXES.full),
        referenceSource:"moomoo_prev_close",
      },
    }));
  }
  renderEmpty(message){
    this.lastRows=[];
    this.presentation=null;
    this.updateSummary(moomooQuoteStore.selectedCode);
    const code=moomooQuoteStore.selectedCode;
    const crypto=isCryptoCode(code);
    const session=crypto?"full":this.activeSession;
    this.renderSessionControl();
    this.sharedTrend?.update(withMarketRead({
      points:[],
      session,
      prevClose:focusedProduct(code)?.prev??null,
      emptyOverlayText:String(message||(crypto?"尚無 Crypto 24H 走勢資料":"尚無 Futu 走勢資料")),
      options:{adapterType:"equity",timeAxisPolicy:crypto?CRYPTO_TIME_AXIS:(US_TIME_AXES[session]||US_TIME_AXES.full),referenceSource:"moomoo_prev_close"},
    },null,{source:"futu"}));
  }
  resize(){this.sharedTrend?.resize();}
  destroy(){this.controlRow=null;this.sharedTrend?.destroy?.();this.sharedTrend=null;super.destroy();}
}
