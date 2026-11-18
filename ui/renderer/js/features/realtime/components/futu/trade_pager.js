import { futuReadModel, marketTimezone, withMarketRead } from "../../../../core/market_read_adapters.js";
import { apiGet } from "../../../../core/api.js";
import { TickDetailsComponent } from "../../../../core/components/tick_details_component.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";
import { createLiveTradePager, TRADE_DETAIL_PAGE_SIZE } from "../../../../market_data/live_trade_pager.js";
import { MoomooFocusedComponent, futuTradeRow, futuTradeTime, tradeTimeFormatter } from "./focused_view_base.js";

// Futu 成交明細 pages like Shioaji's, with the same pager (market_data/live_trade_pager.js): page 1 is the live view
// (its newest 100 trades); the older pages and the page count are FastAPI's /api/trade-detail/page over Market
// Runtime's stored trades of the view's day and session. The pager is reset whenever the product or the session
// changes (a US product moves from 盤前 to 盤中 to 盤後), and its count grows with every new trade the view brings.
export class MoomooTradesComponent extends MoomooFocusedComponent{
  constructor(){
    super("trades");this.sharedTicks=null;this.lastCode="";this.lastItems=[];this.sessionKey=null;this.pagerKey="";
    this.pager=createLiveTradePager({
      apiGet,
      getQuery:()=>this.pagerQuery(),
      getEquityDate:()=>this.sessionKey?.trading_date||"",
      // A count read that lands raises the count by the live trades newer than its watermark (counted once each).
      invalidateDetails:()=>{if(this.host){this.countLive();this.draw();}},
      projectRow:(row,target)=>this.projectRow(row,target),
      requiresTradingDate:()=>true,
    });
  }
  renderShell(){
    this.pager.activate();
    this.sharedTicks=new TickDetailsComponent({manual:true,widthScope:"futu"});
    this.sharedTicks.mount({
      host:this.host,
      context:{mode:"live",services:{tickDetails:{onPageRequest:(request)=>this.requestPage(request)}}},
      hydrate:false,
      actionsHost:this.actionsHost,
    });
  }
  consumeFocusedState(state){
    this.sessionKey=state?.sessionKey||null;
    super.consumeFocusedState(state);
  }
  // What the pager reads: the product, its market, and the view's trading day and session.
  pagerQuery(){
    const target=this.pager?.state.target||"";
    const key=this.sessionKey||{};
    return{target,market:target.split(".",1)[0],session:key.session||"",tradingDate:key.trading_date||"",actualContract:"",requestIdentityKey:""};
  }
  renderData(payload,code){
    const target=String(code||"").toUpperCase();
    const key=`${target}|${this.sessionKey?.trading_date||""}|${this.sessionKey?.session||""}`;
    if(key!==this.pagerKey){this.pagerKey=key;this.pager.reset(target);}
    this.lastCode=target;this.lastItems=Array.isArray(payload?.items)?payload.items:[];this.lastMarketRead=payload?.marketRead||null;
    this.countLive();
    this.draw();
  }
  countLive(){
    for(const row of this.lastItems)this.pager.count(this.lastCode,row);
  }
  requestPage({page=1,latest=false}={}){
    return this.pager.load({page:latest?1:page,latest});
  }
  // A stored page's row drawn like the live ones: the exchange time on the market's clock.
  projectRow(row,target){
    const formatter=tradeTimeFormatter(marketTimezone(String(target).split(".",1)[0])||"UTC");
    return futuTradeRow(row,futuTradeTime(row,formatter));
  }
  // Market Runtime measures every print against the session's comparison price; the overnight session's 昨收 is the
  // reference this renderer owns (focused_view_base.js, decisions.md), and its prints show against that one.
  measured(rows){
    const reference=this.overnightReference;
    if(!(reference>0))return rows;
    return rows.map((row)=>{
      const price=Number(row?.price);
      if(!(price>0))return row;
      const change=price-reference;
      return{...row,change,change_pct:change/reference*100};
    });
  }
  draw(){
    const state=this.pager.state,code=state.target||this.lastCode;
    const p=this.focusedQuote(code);
    const older=state.page>1&&state.rows.length>0;
    const trades=older?state.rows:this.lastItems;
    const marketRead=!older&&this.lastMarketRead?this.lastMarketRead:futuReadModel({code,trades},{quote:p||{},code});
    const rows=this.measured((marketRead.channels.trades.data||[]).slice(0,TRADE_DETAIL_PAGE_SIZE));
    this.sharedTicks?.update(withMarketRead({
      page:older?state.page:1,pageSize:TRADE_DETAIL_PAGE_SIZE,totalPages:state.totalPages,totalCount:Math.max(state.totalCount,rows.length),
      loading:state.loading,rows,marketRead:{...marketRead,channels:{...marketRead.channels,trades:{...marketRead.channels.trades,data:rows}}},
      referencePrice:p?.prev??null,
      logicalCode:code,code,
      emptyText:"尚無成交明細",
    }));
  }
  renderEmpty(message){
    const code=moomooQuoteStore.selectedCode;
    this.sharedTicks?.update(withMarketRead({page:1,pageSize:TRADE_DETAIL_PAGE_SIZE,totalPages:1,totalCount:0,rows:[],referencePrice:this.focusedQuote(code)?.prev??null,logicalCode:code,code,emptyText:String(message||"尚無成交明細")},null,{source:"futu"}));
  }
  resize(){this.sharedTicks?.resize();}
  destroy(){this.pager.dispose();this.pagerKey="";this.sharedTicks?.destroy?.();this.sharedTicks=null;super.destroy();}
}
