import { futuReadModel, marketTimezone, withMarketRead } from "../../../../core/market_read_adapters.js";
import { apiGet } from "../../../../core/api.js";
import { TickDetailsComponent } from "../../../../core/components/tick_details_component.js";
import { createPageCountReader } from "../../trade_detail/page_count_reader.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";
import { createOptimisticCountTracker } from "../../../../market_data/trade_detail/optimistic_count.js";
import { TRADE_DETAIL_PAGE_SIZE, tradePageQuery } from "../../../../market_data/trade_detail/page_query.js";
import { MoomooFocusedComponent, futuTradeRow, futuTradeTime, tradeTimeFormatter } from "./focused_view_base.js";

// Futu 成交明細 pages like Shioaji's: page 1 is the live view (its newest 100 trades); the older pages and the page
// count are FastAPI's /api/trade-detail/page over Market Runtime's stored trades of the view's day and session. The
// count is read once per product and session, then grows with every new trade the view brings.
export class MoomooTradesComponent extends MoomooFocusedComponent{
  constructor(){
    super("trades");this.sharedTicks=null;this.paging=MoomooTradesComponent.freshPaging("");this.lastCode="";this.lastItems=[];this.sessionKey=null;
    this.tradeCount=createOptimisticCountTracker({pageSize:TRADE_DETAIL_PAGE_SIZE});
    this.pageCount=createPageCountReader({apiGet,label:"Futu 成交明細",onCount:(result)=>this.applyCount(result)});
  }
  static freshPaging(target){return{target,page:1,rows:null,totalCount:0,totalPages:1,snapshotWatermark:0,bootstrapReady:false,requestId:0,loading:false};}
  renderShell(){
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
  renderData(payload,code){
    const target=String(code||"").toUpperCase();
    if(target!==this.paging.target){this.paging=MoomooTradesComponent.freshPaging(target);this.pageCount.reset();this.tradeCount.clear();}
    this.lastCode=target;this.lastItems=Array.isArray(payload?.items)?payload.items:[];this.lastMarketRead=payload?.marketRead||null;
    this.countNewTrades(this.lastItems);
    this.readCount(target);
    this.draw();
  }
  // Trades newer than the counted ones raise the count (each once; the rule is the tracker's).
  countNewTrades(items){
    for(const row of items)this.tradeCount.apply(this.paging.target,row,this.paging);
  }
  pageParams(code,page,options={}){
    const key=this.sessionKey||{};
    if(!key.trading_date)return null;
    return tradePageQuery({market:code.split(".",1)[0],code,session:key.session,tradingDate:key.trading_date,page,...options});
  }
  // The product's page count, read once per product and session; a read that could not reach FastAPI is asked again
  // with the view's next frame, a refusal only for another product or session.
  readCount(code){
    const params=this.pageParams(code,1,{metadataOnly:true});
    if(!params)return;
    this.pageCount.request(`${code}|${params.get("trading_date")}|${params.get("session")||""}`,`/api/trade-detail/page?${params.toString()}`);
  }
  applyCount(result){
    if(!this.host)return;
    const paging=this.paging;
    paging.snapshotWatermark=Math.max(0,Number(result.snapshot_watermark)||0);
    this.tradeCount.rebase(paging,{totalRows:result.total_rows,totalPages:result.total_pages,watermark:paging.snapshotWatermark});
    paging.bootstrapReady=true;
    this.countNewTrades(this.lastItems);
    this.draw();
  }
  requestPage({page=1,latest=false}={}){
    const paging=this.paging,code=paging.target;
    const next=latest?1:Math.max(1,Number(page)||1);
    const requestId=++paging.requestId;
    if(next===1||!code){paging.page=1;paging.rows=null;paging.loading=false;this.draw();return Promise.resolve(null);}
    const params=this.pageParams(code,next,{watermark:paging.snapshotWatermark});
    if(!params)return Promise.resolve(null);
    paging.loading=true;this.draw();
    return apiGet(`/api/trade-detail/page?${params.toString()}`).then((result)=>{
      if(this.paging!==paging||paging.requestId!==requestId||!this.host)return result;
      paging.loading=false;
      if(!result?.ok){console.warn("[Futu 成交明細: page] refused",result?.error||result);this.draw();return result;}
      paging.page=Math.max(1,Number(result.page)||next);
      paging.rows=this.projectRows(Array.isArray(result.rows)?result.rows:[],code);
      paging.totalPages=Math.max(paging.totalPages,Number(result.total_pages)||1);
      paging.totalCount=Math.max(paging.totalCount,Number(result.total_rows)||0);
      this.draw();
      return result;
    }).catch((error)=>{
      if(this.paging===paging&&paging.requestId===requestId){paging.loading=false;this.draw();}
      console.warn("[Futu 成交明細: page] failed",error);
      return null;
    });
  }
  // A stored page's rows drawn like the live ones: the exchange time on the market's clock.
  projectRows(rows,code){
    const formatter=tradeTimeFormatter(marketTimezone(code.split(".",1)[0])||"UTC");
    return rows.map((row)=>futuTradeRow(row,futuTradeTime(row,formatter)));
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
    const paging=this.paging,code=paging.target||this.lastCode;
    const p=this.focusedQuote(code);
    const older=paging.page>1&&paging.rows;
    const trades=older?paging.rows:this.lastItems;
    const marketRead=!older&&this.lastMarketRead?this.lastMarketRead:futuReadModel({code,trades},{quote:p||{},code});
    const rows=this.measured((marketRead.channels.trades.data||[]).slice(0,100));
    this.sharedTicks?.update(withMarketRead({
      page:older?paging.page:1,pageSize:100,totalPages:paging.totalPages,totalCount:Math.max(paging.totalCount,rows.length),
      loading:paging.loading,rows,marketRead:{...marketRead,channels:{...marketRead.channels,trades:{...marketRead.channels.trades,data:rows}}},
      referencePrice:p?.prev??null,
      logicalCode:code,code,
      emptyText:"尚無成交明細",
    }));
  }
  renderEmpty(message){
    const code=moomooQuoteStore.selectedCode;
    this.sharedTicks?.update(withMarketRead({page:1,pageSize:100,totalPages:1,totalCount:0,rows:[],referencePrice:this.focusedQuote(code)?.prev??null,logicalCode:code,code,emptyText:String(message||"尚無成交明細")},null,{source:"futu"}));
  }
  resize(){this.sharedTicks?.resize();}
  destroy(){this.pageCount.reset();this.sharedTicks?.destroy?.();this.sharedTicks=null;super.destroy();}
}
