import { registerProductQuoteSearchProvider } from "../../../../core/components/product_quote_search.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";

// The Futu headers' code box: the Futu catalog is what can be shown, so it is searched and selected from there.
registerProductQuoteSearchProvider("futu",{
  async suggest(text){
    const q=String(text||"").trim().toUpperCase();
    return moomooQuoteStore.products
      .map((row)=>({code:String(row?.code||"").toUpperCase(),name:String(row?.name||"")}))
      .filter((row)=>row.code&&(row.code.includes(q)||row.code.split(".").pop().startsWith(q)||row.name.toUpperCase().includes(q)))
      .slice(0,12);
  },
  async submit(item){
    const q=String(item?.code||"").trim().toUpperCase();
    const codes=moomooQuoteStore.products.map((row)=>String(row?.code||"").toUpperCase());
    const code=codes.find((value)=>value===q)||codes.find((value)=>value.split(".").pop()===q);
    if(!code)return{ok:false,message:"不在 Futu 商品列表；請先加入商品列表"};
    await moomooQuoteStore.select(code);
    return{ok:true};
  },
});
