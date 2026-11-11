"""產業指數 on the background list (user 10-19): the product pages and the two holdings bring the sector index of each
Shioaji stock's industry; nothing else does, and the index leaves with the last stock that brought it."""
from service.market.reference import background_demand as bd
from service.market.reference import sector_indexes as si
from service.market.shared.provider_contract import SHIOAJI_CAPABILITIES

MASTER = {"2330": ("24", "tse"), "2454": ("24", "tse"), "3105": ("24", "otc"), "1101": ("01", "otc"), "0050": ("00", "tse")}


def stock(code, *owners):
    return {"source": "shioaji", "market": "STK", "code": code, "kinds": bd.FULL_KINDS, "owners": list(owners)}


def test_followed_owners_bring_their_industry_index_otc_falls_back_to_tse():
    items = [stock("2330", "watchlist"), stock("3105", "holdings"), stock("1101", "paper_holdings"), stock("0050", "watchlist"),
             stock("2454", "paper_orders"), {"source": "futu", "market": "US", "code": "US.AAPL", "owners": ["watchlist"]}]
    codes = [i["code"] for i in si.sector_index_items(items, MASTER)]
    # 2330 -> 半導體 IX0028, 3105 (OTC) -> 櫃買半導體 IX0053, 1101 (OTC cement, no OTC index) -> 水泥 IX0010;
    # an ETF has no industry index; a paper order alone brings nothing.
    assert codes == ["IX0010", "IX0028", "IX0053"]
    assert all(i["market"] == "IDX" and i["kinds"] == ["quote"] for i in si.sector_index_items(items, MASTER))


def test_the_index_follows_the_list_through_merge(monkeypatch):
    monkeypatch.setattr(si, "_master", lambda: MASTER)
    items = bd.merge([], "watchlist", [stock("2330")])
    items = bd.merge(items, "sector_index", si.sector_index_items(items))
    assert [(i["market"], i["code"], i["owners"]) for i in items if i["market"] == "IDX"] == [("IDX", "IX0028", ["sector_index"])]
    items = bd.merge(items, "watchlist", [])
    items = bd.merge(items, "sector_index", si.sector_index_items(items))
    assert items == [], "the index leaves with the last stock that brought it"


def test_the_provider_carries_exactly_the_listed_indexes():
    assert SHIOAJI_CAPABILITIES.resolve("IDX", "IX0028").lanes == ("Quote",)
    assert SHIOAJI_CAPABILITIES.resolve("IDX", "TAIEX").logical_code == "IX0001"
    assert SHIOAJI_CAPABILITIES.resolve("IDX", "OTC") is None, "an index code is never guessed"
