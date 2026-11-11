// Futu 買賣報價: the selected product's book, 內外盤 and depth totals through the shared order book component.
import { OrderBookComponent } from "../../../../core/components/orderbook_component.js";
import { withMarketRead } from "../../../../core/market_read_adapters.js";
import { FutuOrderBookAdapter } from "../../../../core/orderbook_adapters.js";
import { formatMoomooDisplaySymbol } from "../../../../market_data/moomoo_symbol.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";
import { MoomooFocusedComponent } from "./focused_view_base.js";

export class MoomooOrderBookComponent extends MoomooFocusedComponent{
  constructor(){super("orderbook");this.sharedBook=null;}
  renderShell(){
    this.sharedBook=new OrderBookComponent({
      manual:true,
      depth:5,
      minDepth:5,
      maxDepth:10,
      dynamicDepth:true,
      title:"Futu 買賣報價",
      showInsideOutside:true,
      showPriceVolume:false,
      showDepthTotals:true,
      showExtremeMarkers:false,
      search:"futu",
    });
    this.sharedBook.mount({host:this.host,context:{mode:"live",services:{}},hydrate:false});
  }
  renderData(payload,code){
    const p=this.focusedQuote(code);
    const normalizedBook=FutuOrderBookAdapter.build({
      code,
      book:payload?.book||{},
      tradeSideSummary:payload?.tradeSideSummary||{},
      quote:p||{},
      label:String(p?.name||formatMoomooDisplaySymbol(code)||"----"),
      secondaryLabel:formatMoomooDisplaySymbol(code),
      available:Boolean(payload?.available), readModel:payload.marketRead,
    });
    this.sharedBook?.update({...normalizedBook,inputCode:formatMoomooDisplaySymbol(code)});
  }
  renderEmpty(message){
    const code=moomooQuoteStore.selectedCode;
    const p=this.focusedQuote(code);
    this.sharedBook?.update(withMarketRead({availability:"UNAVAILABLE",message:String(message||"尚無買賣報價"),titlePrimary:String(p?.name||formatMoomooDisplaySymbol(code)||"----"),titleSecondary:formatMoomooDisplaySymbol(code),inputCode:formatMoomooDisplaySymbol(code),code,prevClose:p?.prev??null,priceReference:p?.prev??null,showDepthTotals:true},null,{source:"futu"}));
  }
  resize(){this.sharedBook?.resize?.();}
  destroy(){this.sharedBook?.destroy?.();this.sharedBook=null;super.destroy();}
}
