// The base of the Futu focused panels (個股走勢, 成交明細, 買賣報價): binds the selected product's live view, reads
// only the channels the panel draws, once per frame, and projects that part of the view for the panel.
import { futuReadModel, marketTimezone } from "../../../../core/market_read_adapters.js";
import { subscribeRealtimeView, selectRealtimeView } from "../../../../market_data/realtime.js";
import { futuCanonicalViewSpec } from "../../../../market_data/moomoo_symbol.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";
import { realtimeRenderScheduler } from "../../realtime_render_scheduler.js";
import { focusedProduct } from "./futu_product.js";
import { isCryptoCode } from "./us_session_policy.js";
import { usTrendWindow } from "../../futu_us_trend_window.js";
import { subscribeUsMarketSession, usMarketSession } from "../../futu_us_market_session.js";
import { lastCloseBefore } from "../../futu_us_session_stats.js";

let focusedComponentSequence=0;

// One formatter per market timezone, and one formatted string per trade. The focused panels
// re-projected snapshot.trades on EVERY update and called
// `new Date(ms).toLocaleString("sv-SE",{timeZone})` per trade -- re-formatting up to 100 rows that
// had not changed, measured at ~16% of main-thread self time. The timezone is chosen per market
// (US/HK/UTC), so it is part of the key; there are three of them, so the map is trivially bounded.
// Verified byte-identical to the toLocaleString call it replaces across 6000 samples per timezone.
const TRADE_TIME_FORMATTERS=new Map();
export function tradeTimeFormatter(timezone){
  const key=String(timezone||"UTC");
  let formatter=TRADE_TIME_FORMATTERS.get(key);
  if(formatter===undefined){
    formatter=new Intl.DateTimeFormat("sv-SE",{timeZone:key,hour12:false,
      year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
    TRADE_TIME_FORMATTERS.set(key,formatter);
  }
  return formatter;
}

// A Futu print as its lists draw it: the exchange time on the market's clock (formatter: tradeTimeFormatter).
export function futuTradeTime(row,formatter){
  const millis=Number(row.exchange_ts_ns)/1_000_000;
  return Number.isFinite(millis)&&millis>0?formatter.format(new Date(millis)):"";
}
export function futuTradeRow(row,datetime){return{...row,datetime,time:datetime,source:"futu"};}

// The view channels each focused component draws from: a delta of any other channel leaves it as it is.
const FOCUSED_CHANNELS=Object.freeze({
  trend:new Set(["trend","summary"]),
  trades:new Set(["trades","summary"]),
  orderbook:new Set(["orderbook","summary","price_volume"]),
});

export class MoomooFocusedComponent{
  // viewCode starts as null, not "": the first bind always runs, so a page opened with no Futu product selected draws
  // its empty state (axes, prompt) instead of nothing -- "" === "" returned early and the chart stayed blank.
  constructor(kind){this.kind=kind;this.host=null;this.cleanup=[];this.renderKey=`us-component:${kind}:${++focusedComponentSequence}`;this.lastRenderCode="";this.viewUnsubscribe=null;this.viewCode=null;this.tradeTimeCache=new Map();this.pendingChannels=null;this.lastPrevClose=undefined;}
  mount({host,actionsHost=null}){
    this.host=host;this.actionsHost=actionsHost;
    this.renderShell();
    this.cleanup.push(moomooQuoteStore.subscribe((state)=>this.bindRustView(state.selectedCode)));
    // Rust A pushes the US session again whenever it moves (the overnight session opening or ending, a new day).
    this.cleanup.push(subscribeUsMarketSession(()=>this.followUsSession()));
  }
  // The overnight session opened or ended: bind again with (or without) its opening partition.
  followUsSession(){
    const code=this.viewCode;
    if(!this.host||!code)return;
    if((this.overnightSpec(code)?.trading_date??null)!==(this.overnightViewSpec?.trading_date??null)){this.viewCode=null;this.bindRustView(code);}
  }
  // The channels a view notice changed: a snapshot, gap or error re-reads everything; a delta or batch names its own.
  static noticeChannels(event){
    if(event?.type==="delta")return event.delta?.channels?.length?event.delta.channels:[event.delta?.delta_type||"control"];
    if(event?.type==="batch"&&Array.isArray(event.changedChannels))return event.changedChannels;
    return null;
  }
  bindRustView(selected){
    const code=String(selected||"").trim().toUpperCase();
    if(code===this.viewCode)return;
    this.viewUnsubscribe?.();this.viewUnsubscribe=null;this.viewCode=code;this.tradeTimeCache=new Map();this.trendCopies=null;this.partitionRows=null;this.mergedPartitionRows=null;this.tradeCopies=null;this.pendingChannels=null;this.lastPrevClose=undefined;
    this.overnightViewSpec=this.overnightSpec(code);this.overnightReference=null;
    if(!code){this.renderEmpty("請先在 Futu 商品列表選擇商品");return;}
    const market=code.split(".",1)[0];
    const spec=futuCanonicalViewSpec(code);
    const relevant=FOCUSED_CHANNELS[this.kind];
    // The view callback fires once per delta; the read is deferred to one frame and covers every channel changed
    // since the last one. Only a notice touching this component's channels schedules it.
    const apply=(event)=>{
      if(!this.host||this.viewCode!==code)return;
      const channels=MoomooFocusedComponent.noticeChannels(event);
      if(channels===null)this.pendingChannels="all";
      else if(this.pendingChannels!=="all"){
        const mine=channels.filter((channel)=>relevant.has(channel));
        if(!mine.length)return;
        this.pendingChannels=new Set([...(this.pendingChannels||[]),...mine]);
      }
      realtimeRenderScheduler.scheduleFrame(`${this.renderKey}:read`,read);
    };
    const read=()=>{
      if(!this.host||this.viewCode!==code)return;
      const changed=this.pendingChannels;
      this.pendingChannels=null;
      // Only what this component draws is read out of the live view (no copy of the whole view per notice).
      const state=selectRealtimeView(spec,(view)=>this.projectView(view,code,market))||this.projectView({},code,market);
      this.readPartitions(state,code);
      this.readOvernightReference();
      // 成交明細 colours its prices against 昨收: a summary notice matters to it only when 昨收 moved.
      if(this.kind==="trades"){
        const prev=this.overnightReference??state.quote.prev??null;
        if(changed instanceof Set&&!changed.has("trades")&&prev===this.lastPrevClose)return;
        this.lastPrevClose=prev;
      }
      this.scheduleFocusedState(state);
    };
    // The cached view is read once, here; the subscription only reports later changes (replaying the
    // cache too would hydrate the same snapshot twice on a bind).
    const unsubscribe=[spec,...this.partitionViewSpecs(code),...(this.overnightViewSpec?[this.overnightViewSpec]:[])].map((each)=>subscribeRealtimeView(each,apply,{stateDelivery:"snapshot-only",replayCached:false}));
    this.viewUnsubscribe=()=>unsubscribe.forEach((fn)=>fn());
    read();
  }
  // Dated views read beside the product's current one (the trend's tabs span several partitions).
  partitionViewSpecs(_code){return[];}
  readPartitions(_state,_code){}
  // 成交明細 and 買賣報價 measure the overnight session (20:00-04:00 New York) against the 夜盤 tab's 昨收: the last
  // trade before that session's 20:00 open (decisions.md). The product's current partition is a New York date, so
  // until midnight its summary 昨收 is still the previous day's close; the 20:00 open lives in the partition the
  // session opened in, read here beside the current one. 個股走勢 works its tabs' references out itself.
  // Whether the overnight session is trading, and its window, are Rust A's (futu_us_market_session.js).
  usSession(){return usMarketSession();}
  overnightSpec(code){
    if(this.kind==="trend"||!code||isCryptoCode(code)||code.split(".",1)[0]!=="US")return null;
    const us=this.usSession(),window=usTrendWindow("overnight",us);
    if(us?.phase!=="overnight"||!window.parts.length)return null;
    return Object.freeze({...futuCanonicalViewSpec(code),trading_date:window.parts[0].trading_date,channels:["trend"]});
  }
  // A partition that cannot be read keeps the reference already found.
  readOvernightReference(){
    const spec=this.overnightViewSpec;
    if(!spec){this.overnightReference=null;return;}
    const read=selectRealtimeView(spec,(view)=>({reference:lastCloseBefore(Array.isArray(view?.trend)?view.trend:[],usTrendWindow("overnight",this.usSession()).parts[0].from)}));
    if(read?.reference!=null)this.overnightReference=read.reference;
  }
  // The selected product as 成交明細 and 買賣報價 measure it: in the overnight session against the 夜盤 昨收.
  focusedQuote(code){
    const p=focusedProduct(code),reference=this.overnightReference;
    if(!p||reference===null||this.kind==="trend")return p;
    const change=p.current===null?null:p.current-reference;
    return{...p,prev:reference,change,changePct:change===null?null:change/reference*100};
  }
  // This component's part of the live view state, copied out (a projector must not let store state escape).
  projectView(view,code,market){
    const summary=view?.summary||{};
    const timezone=marketTimezone(market)||"UTC";
    const rawTrades=Array.isArray(view?.trades)?view.trades:[];
    const state={code,trend:[],trades:[],book:{Bid:[],Ask:[]},
      quote:{current:summary.current,prev:summary.prev_close,volume:summary.total_volume},
      tradeSideSummary:null,available:false,bootstrapped:Boolean(view?.sequence),status:{},
      cursor:{session_date:view?.trading_date||""},sequence:view?.sequence||0,
      sessionKey:{trading_date:String(view?.session_key?.trading_date||view?.trading_date||"").slice(0,10),session:String(view?.session_key?.session||"")}};
    if(this.kind==="trend"&&isCryptoCode(code)){
      // Each view point's copy is kept (the view's points are immutable): an update copies only the points that are
      // new, and the chart sees the unchanged ones as the same points.
      const date=view?.trading_date||"";
      const copies=this.trendCopies??=new WeakMap();
      state.trend=(Array.isArray(view?.trend)?view.trend:[]).map((row)=>{
        const known=copies.get(row);
        if(known&&known.date===date)return known.copy;
        const copy={...row,time:`${date}T${row.time||"00:00"}:00`};
        copies.set(row,{date,copy});
        return copy;
      });
    }
    // The newest print's time is every read model's event time; 成交明細 takes the whole window.
    const tradeRows=this.kind==="trades"?rawTrades.slice().reverse():rawTrades.slice(-1);
    // A trade's display time is a pure function of its exchange timestamp and the market's timezone, and a trade
    // is immutable once it has arrived -- so a row still in the window keeps the string formatted for it. The cache
    // is rebuilt from the rows present on each read, so it is bounded by the trade window.
    const previousTimes=this.tradeTimeCache;
    const nextTimes=new Map();
    const formatter=tradeTimeFormatter(timezone);
    const tradeCopies=this.tradeCopies??=new WeakMap();
    state.trades=tradeRows.map((row)=>{
      const kept=tradeCopies.get(row);
      if(kept&&kept.timezone===timezone){nextTimes.set(kept.cacheKey,kept.copy.datetime);return kept.copy;}
      const cacheKey=`${timezone}|${row.exchange_ts_ns}`;
      let datetime=previousTimes.get(cacheKey);
      if(datetime===undefined)datetime=futuTradeTime(row,formatter);
      nextTimes.set(cacheKey,datetime);
      const copy=futuTradeRow(row,datetime);
      tradeCopies.set(row,{timezone,cacheKey,copy});
      return copy;
    });
    if(this.kind==="trades")this.tradeTimeCache=nextTimes;
    if(this.kind==="orderbook"){
      const book=view?.orderbook||{};
      const copy=(levels)=>(Array.isArray(levels)?levels:[]).map((level)=>({...level}));
      state.book={Bid:copy(book.bids),Ask:copy(book.asks)};
      state.available=Boolean(state.book.Bid.length||state.book.Ask.length);
      state.tradeSideSummary={outside_volume:view?.price_volume?.out_volume||0,inside_volume:view?.price_volume?.in_volume||0};
    }
    return state;
  }
  scheduleFocusedState(state){
    if(!this.host)return;
    const code=String(state?.code||moomooQuoteStore.selectedCode||"").toUpperCase();
    const force=Boolean(code&&this.lastRenderCode&&code!==this.lastRenderCode);
    realtimeRenderScheduler.scheduleFrame(this.renderKey,()=>{
      if(!this.host||this.viewCode!==code)return;
      const started=performance.now();
      this.lastRenderCode=code;
      this.consumeFocusedState(state);
      const detail={component:`moomoo:${this.kind}`,code,source:"shared_render_scheduler"};
      try{window.dispatchEvent(new CustomEvent("stock-monitor:moomoo-component-render",{detail:{...detail,render_ms:performance.now()-started}}));}catch (error) { console.warn("[Futu component: render timing event] failed", error); }
      window.requestAnimationFrame(()=>{
        try{window.dispatchEvent(new CustomEvent("stock-monitor:moomoo-component-paint",{detail:{...detail,paint_ms:performance.now()-started}}));}catch (error) { console.warn("[Futu component: paint timing event] failed", error); }
      });
    },{force});
  }
  consumeFocusedState(state){
    if(!this.host)return;
    const code=String(state?.code||moomooQuoteStore.selectedCode||"");
    if(!code)return this.renderEmpty("請先在 Futu 商品列表選擇商品");
    const marketRead=futuReadModel(state,{quote:this.focusedQuote(code)||{},code,include:[this.kind]});
    if(this.kind==="trend")this.renderData({items:state.trend,status:state.status,presentation:state.presentation,marketRead},code);
    else if(this.kind==="trades")this.renderData({items:state.trades,status:state.status,marketRead},code);
    else {
      // The focused view's book is { Bid, Ask } built from Market Runtime's orderbook (bids / asks).
      const book=state?.book||{};
      const hasLevels=(candidate)=>[candidate?.Bid,candidate?.Ask].some((levels)=>Array.isArray(levels)&&levels.length>0);
      this.renderData({book,available:Boolean(state?.available)||hasLevels(book),status:state.status,tradeSideSummary:state.tradeSideSummary,marketRead},code);
    }
  }
  renderEmpty(_message){}
  resize(){}
  destroy(){realtimeRenderScheduler.cancel(this.renderKey);this.viewUnsubscribe?.();this.viewUnsubscribe=null;this.cleanup.splice(0).forEach((fn)=>fn());this.host=null;}
}
