// The two product lists the realtime page mounts: Shioaji's (fed by the Taiwan product-list store) and Futu's (its
// watch pages, holdings pages and the Futu quote store). Both draw through the shared product list shell and table.
import { withProductRead } from "../../../../core/market_read_adapters.js";
import { numberOrNull } from "../../../../core/numbers.js";
import { refitColumnTitle } from "../../../../core/column_title.js";
import { mountShell } from "../../../../core/component_shell.js";
import { canonicalMoomooCode, formatMoomooDisplaySymbol } from "../../../../market_data/moomoo_symbol.js";
import { disposeProductPageTabs, enableSharedProductListScroll, productListShellMarkup, renderProductPageTabs } from "../../product_list.js";
import { mountProductListTools } from "../../product_list_tools.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";
import { subscribeTaiwanProductListView, subscribeTaiwanProductPages, taiwanProductListSnapshot } from "../../taiwan_product_list_store.js";
import { US_HOLDINGS_LEDGERS } from "../../ledger_holdings.js";
import { renderExternalRealtimeQuoteTable } from "../realtime_quote_table.js";
import { renderProductCards, watchProductListWidth } from "../product_cards.js";
import { setProductListOverviewOnly } from "../../product_pages.js";
import { product } from "./futu_product.js";
import { currentUsSession } from "./us_session_policy.js";

// The watch-page store gives every page its canonical source.
const watchPageSource=(page)=>page?.source==="futu"?"futu":"shioaji";

function statusText(status={}){
  const readiness=status?.readiness||{};
  if(readiness.state==="PROVIDER_STARTING")return"Futu 服務啟動中";
  if(!readiness.connected)return status.last_error||"OpenD 未連線；等待啟動並登入 OpenD";
  if(readiness.state==="STALE")return `OpenD 已連線（行情停滯） · ${status.last_poll_at||"同步中"}`;
  if(!readiness.market_data_ready)return `OpenD 已連線（行情準備中） · ${status.last_poll_at||"同步中"}`;
  return `OpenD 已連線 · ${status.last_poll_at||"同步中"}`;
}

let taiwanProductFragment=null;

// The list as cards (narrow) or as its table: the shell shows one or the other (components/product-list.css).
function showCardView(host,on){const shell=host?.querySelector?.(".product-list");if(shell)shell.dataset.listView=on?"cards":"table";}

export class UnifiedProductListComponent{
  constructor(){this.host=null;this.cleanup=[];this.productRowSnap=null;this.activePageId="overview";this.cardView=false;this.publishedPages=null;this.renderView=null;}
  mount({host,hydrate,actionsHost=null}){
    this.host=host;
    // The list destroy() parked (ComponentHost cleared the slot for another tab) comes back as the same bound nodes;
    // whatever the host holds is kept only when it is the product-list shell (core/component_shell.js).
    const parked=taiwanProductFragment;
    taiwanProductFragment=null;
    const restored=Boolean(parked?.childNodes?.length)&&!host.firstChild;
    if(restored)host.appendChild(parked);
    mountShell(host,productListShellMarkup({ariaLabel:"Shioaji 商品頁",provider:"shioaji"}),{hydrate:hydrate||restored});
    // ✎ and ⚙ are this list's: bound on every mount, so a list mounted after the page (its pane tab opened later) or
    // mounted again works like the first.
    this.cleanup.push(mountProductListTools(host,{activePageId:()=>this.activePageId,actionsHost}));
    showCardView(host,false);
    this.cleanup.push(watchProductListWidth(host,(narrow)=>this.setCardView(narrow)));
    const render=(view)=>{
      if(!this.host)return;
      const current=view||{};
      if(this.cardView){renderProductCards({root:this.host,rows:Array.isArray(current.rows)?current.rows:[],selectedCode:current.selectedCode,onSelect:current.onSelect,onPick:current.onPick,emptyText:current.emptyText||"尚無自選商品",changedCodes:current.changedCodes,topologyChanged:current.topologyChanged});return;}
      renderExternalRealtimeQuoteTable({
        rows:Array.isArray(current.rows)?current.rows:[],selectedCode:current.selectedCode,onSelect:current.onSelect,onPick:current.onPick,
        market:"tw",root:this.host,emptyText:current.emptyText||"尚無自選商品",changedCodes:current.changedCodes,topologyChanged:current.topologyChanged,trace:current.trace,
        holdings:current.holdings,
      });
      if(!this.productRowSnap)this.productRowSnap=enableSharedProductListScroll(this.host).rowSnap;
    };
    this.renderView=render;
    this.cleanup.push(subscribeTaiwanProductListView(render));
    render(taiwanProductListSnapshot());
    // The page tabs, drawn whenever the list is mounted (subscribing hands over the current ones).
    this.cleanup.push(subscribeTaiwanProductPages((pages)=>{
      this.publishedPages=pages;
      this.activePageId=pages.activePageId;
      const tabs=this.host?.querySelector?.('[data-role="product-list-pages"][data-provider="shioaji"]');
      if(tabs)renderProductPageTabs(tabs,pages);
      this.syncOverviewOnly();
    }));
  }
  // Narrow: the cards and 總覽. The page store answers by publishing the rows of the page it now shows.
  setCardView(on){if(on===this.cardView)return;this.cardView=on;showCardView(this.host,on);this.syncOverviewOnly();const snapshot=taiwanProductListSnapshot();if(snapshot&&this.publishedPages?.overviewOnly===on)this.renderView?.(snapshot);if(!on)this.resize();}
  syncOverviewOnly(){const pages=this.publishedPages;if(pages&&pages.overviewOnly!==this.cardView)pages.onOverviewOnly?.(this.cardView);}
  resize(){refitColumnTitle(this.host?.querySelector?.('[data-role="product-list-table"]'));}
  destroy(){if(this.cardView)setProductListOverviewOnly(false);this.cardView=false;this.publishedPages=null;this.cleanup.splice(0).forEach((fn)=>fn());this.productRowSnap?.destroy?.();this.productRowSnap=null;if(!this.host)return;taiwanProductFragment=document.createDocumentFragment();while(this.host.firstChild)taiwanProductFragment.appendChild(this.host.firstChild);this.host=null;}
}

export class MoomooProductListComponent{
  constructor(){this.host=null;this.cleanup=[];this.pages=[];this.holdingPages=new Map(US_HOLDINGS_LEDGERS.map((ledger)=>[ledger.pageIds.us,ledger.pages().us]));this.productRowSnap=null;this.activePageId=localStorage.getItem("moomooWatchPageActiveV1")||"overview";this.watchlistHash="";this.tabsSignature="";this.pageMembershipSignature="";this.cardView=false;}
  mount({host,actionsHost=null}){
    this.host=host;
    host.innerHTML=productListShellMarkup({ariaLabel:"富途 Futu 商品頁",provider:"futu"});
    this.cleanup.push(mountProductListTools(host,{activePageId:()=>this.activePageId,actionsHost}));
    showCardView(host,false);
    this.cleanup.push(watchProductListWidth(host,(narrow)=>this.setCardView(narrow)));
    this.cleanup.push(moomooQuoteStore.subscribe((state)=>this.render(state)));
    this.cleanup.push(window.desktopAPI?.onWatchPagesChanged?.(()=>this.loadPages())||(()=>{}));
    for(const ledger of US_HOLDINGS_LEDGERS)this.cleanup.push(ledger.subscribe((pages)=>{this.holdingPages.set(ledger.pageIds.us,pages.us);void this.syncProductUniverse();}));
    const columnsChanged=()=>this.render(moomooQuoteStore.snapshot());
    window.addEventListener("realtime-product-columns-changed",columnsChanged);
    this.cleanup.push(()=>window.removeEventListener("realtime-product-columns-changed",columnsChanged));
    this.loadPages();
  }
  async loadPages(){
    try{
      const payload=await window.desktopAPI?.loadWatchPagesLocal?.();
      this.pages=(Array.isArray(payload?.pages)?payload.pages:[]).filter((page)=>watchPageSource(page)==="futu");
    }catch(error){console.warn("[MOOMOO WATCH PAGES]",error);this.pages=[];}
    await Promise.all(US_HOLDINGS_LEDGERS.map(async(ledger)=>{try{this.holdingPages.set(ledger.pageIds.us,(await ledger.refresh()).us);}catch(error){console.warn(`[${ledger.ledger.toUpperCase()} HOLDINGS] Futu page load failed`,error);}}));
    if(this.activePageId!=="overview"&&!this.holdingPages.has(this.activePageId)&&!this.pages.some((page)=>String(page.id)===this.activePageId))this.activePageId="overview";
    await this.syncProductUniverse();
  }
  async syncProductUniverse(){
    const union=[...this.overviewPage().items,...[...this.holdingPages.values()].flatMap((page)=>this.normalizedItems(page))];
    const hash=union.map((item)=>`${item.code}:${item.name||""}`).join("|");
    // The hash is the list the store accepted: it moves only when the write succeeds (the store serializes the writes
    // and sends only the newest list, so an older answer cannot put an older list back).
    if(hash!==this.watchlistHash){
      try{
        await moomooQuoteStore.replaceWatchlist(union);
        this.watchlistHash=hash;
      }catch(error){
        // The store keeps the list pending and applies it on its next good status read: no timer here.
        console.warn("[MOOMOO WATCHLIST] product universe sync failed",error);
      }
    }
    this.render(moomooQuoteStore.snapshot());
  }
  normalizedItems(page){
    const byCode=new Map((Array.isArray(page?.items)?page.items:[]).map((item)=>[String(item?.code||"").toUpperCase(),item]));
    // A watch-page code is used as written (canonical shape only): it is the Market Runtime subscription key.
    return (Array.isArray(page?.codes)?page.codes:[]).map((raw)=>{
      const value=String(raw||"").trim().toUpperCase();
      const code=canonicalMoomooCode(value);
      const meta=byCode.get(value)||byCode.get(code)||{};
      return{...meta,code,name:String(meta.name||"")};
    }).filter((item)=>Boolean(item.code));
  }
  overviewPage(){
    const seen=new Set(),items=[];
    this.pages.forEach((page)=>this.normalizedItems(page).forEach((item)=>{if(!seen.has(item.code)){seen.add(item.code);items.push(item);}}));
    return{id:"overview",name:"總覽",items,codes:items.map((item)=>item.code),count:items.length,virtual:true};
  }
  setCardView(on){if(on===this.cardView)return;this.cardView=on;showCardView(this.host,on);this.render(moomooQuoteStore.snapshot());if(!on)this.resize();}
  activePage(){if(this.cardView||this.activePageId==="overview")return this.overviewPage();if(this.holdingPages.has(this.activePageId))return this.holdingPages.get(this.activePageId);return this.pages.find((page)=>String(page.id)===this.activePageId)||this.overviewPage();}
  // A row is the store's catalog row joined with its view's live fields (moomooQuoteStore owns the one view
  // subscription per code and says which codes moved).
  realtimeRow(row, live=true){
    const p=product(row);
    const available=live&&(numberOrNull(row?.regular_current)>0||numberOrNull(row?.last_price)>0||numberOrNull(row?.prev_close_price)>0);
    return withProductRead({...row,name:p.name,code:p.code,display_code:formatMoomooDisplaySymbol(p.code),day_high:available?p.high:null,day_low:available?p.low:null,open:available?p.open:null,prev_close:available?p.prev:null,reference_price:available?numberOrNull(row?.reference_price):null,current:available?p.current:null,volume_change_pct_vs_baseline:available?p.volumeChange:null,change_pct:available?p.changePct:null,chg_1m:available?p.chg1:null,chg_3m:available?p.chg3:null,chg_5m:available?p.chg5:null,k_1m:null,k_3m:null,k_5m:null,total_volume:available?p.volume:null,avg_price:available?p.avg:null,best_bid_price:null,best_ask_price:null},"futu");
  }
  // null means "every row is dirty" to renderProductListRows. Only narrow to a set when a caller
  // actually declared which codes moved: a tab switch, a column change or a watchlist sync arrives
  // with neither source populated and must still repaint the whole table.
  render(state){
    if(!this.host)return;
    const overview=this.overviewPage();
    const tabsSignature=JSON.stringify([this.activePageId,[...this.holdingPages.values()].map((page)=>[page.id,page.count]),overview.count,this.pages.map((page)=>[page.id,page.name,page.count??page.codes?.length])]);
    if(tabsSignature!==this.tabsSignature){
      this.tabsSignature=tabsSignature;
      renderProductPageTabs(this.host.querySelector('[data-role="product-list-pages"]'),{systemPages:[...this.holdingPages.values()],overview,pages:this.pages,activePageId:this.activePageId,onSelect:(key)=>{this.activePageId=key;this.tabsSignature="";localStorage.setItem("moomooWatchPageActiveV1",key);this.render(moomooQuoteStore.snapshot());}});
    }
    const activeItems=this.normalizedItems(this.activePage());
    const codes=new Set(activeItems.map((item)=>item.code));
    const membershipSignature=[...codes].join("|");
    const topologyChanged=membershipSignature!==this.pageMembershipSignature;
    this.pageMembershipSignature=membershipSignature;
    // Product rows are the last materialized market facts.  A transient proxy
    // timeout changes freshness, not those facts, so never replace them with
    // dashes. The focused store writes its newer selected-symbol trade into the
    // quote read model before emitting, keeping every product-list consumer
    // consistent without component-specific overlays.
    const productByCode=new Map((state.products||[]).map((row)=>[String(row.code||"").toUpperCase(),row]));
    // A row is rebuilt only when its product row (the store's joined row, the same object while unchanged), its page
    // item's name or the US session changed.
    this.rowCache??=new Map();
    const session=currentUsSession();
    const rows=activeItems.map((item)=>{
      const productRow=productByCode.get(item.code);
      const cached=this.rowCache.get(item.code);
      if(cached&&cached.product===productRow&&cached.name===item.name&&cached.session===session)return cached.row;
      const row=this.realtimeRow({...item,...(productRow||{})},true);
      this.rowCache.set(item.code,{product:productRow,name:item.name,session,row});
      return row;
    });
    if(this.rowCache.size>activeItems.length*4)for(const code of this.rowCache.keys())if(!codes.has(code))this.rowCache.delete(code);
    const disconnected=!state.status?.readiness?.connected;
    const changedCodes=Array.isArray(state?.changedCodes)?new Set(state.changedCodes):null;
    if(this.cardView){renderProductCards({root:this.host,rows,selectedCode:state.selectedCode,onSelect:(code)=>moomooQuoteStore.select(code),emptyText:codes.size?(disconnected?statusText(state.status):"等待 Futu 行情"):"此 Futu 商品頁尚未加入商品",changedCodes,topologyChanged});return;}
    renderExternalRealtimeQuoteTable({rows,selectedCode:state.selectedCode,onSelect:(code)=>moomooQuoteStore.select(code),market:"us",root:this.host,emptyText:codes.size?(disconnected?statusText(state.status):"等待 Futu 行情"):"此 Futu 商品頁尚未加入商品",changedCodes,topologyChanged,
      holdings:this.holdingPages.get(this.activePageId)?.items??null});
    if(!this.productRowSnap)this.productRowSnap=enableSharedProductListScroll(this.host).rowSnap;
  }
  resize(){refitColumnTitle(this.host?.querySelector?.('[data-role="product-list-table"]'));}
  destroy(){this.productRowSnap?.destroy?.();this.productRowSnap=null;disposeProductPageTabs(this.host?.querySelector('[data-role="product-list-pages"]'));this.cleanup.splice(0).forEach((fn)=>fn());this.host=null;}
}
