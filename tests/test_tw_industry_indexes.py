"""config/tw_industry_indexes.json: every 台股產業代碼 names its sector index per market, each pair says how it was
checked (data / name / proxy), and the stocks of the local security master all have a row."""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DOC = json.loads((ROOT / "config" / "tw_industry_indexes.json").read_text(encoding="utf-8"))


def test_the_table_is_well_formed():
    assert DOC["schema"] == "tw-industry-indexes-v1"
    codes = [row["code"] for row in DOC["industries"]]
    assert len(codes) == len(set(codes)) and all(re.fullmatch(r"\d{2}", c) for c in codes) and "00" not in codes
    for row in DOC["industries"]:
        assert row["name"]
        for market in ("tse", "otc"):
            pair = row[market]
            if pair is None:
                continue
            assert re.fullmatch(r"IX\d{4}", pair["index"]) and pair["index_name"].endswith("指數"), row
            check = pair["check"]
            assert check["how"] in {"data", "name", "proxy"} and check["note"], row
            if check["how"] == "data":
                assert check["corr"] >= 0.5, f"{row['code']} {market}: a data match is a clear one"


def test_known_pairs():
    by = {row["code"]: row for row in DOC["industries"]}
    assert (by["24"]["tse"]["index"], by["24"]["otc"]["index"]) == ("IX0028", "IX0053"), "半導體"
    assert by["17"]["tse"]["index"] == "IX0039" and by["17"]["otc"]["check"]["how"] == "proxy", "上櫃金融用上市金融保險類指數"
    assert by["15"]["tse"]["check"]["how"] == "data"


def test_every_stock_of_the_security_master_has_a_row():
    master = ROOT / "var" / "data" / "reference" / "shioaji" / "security_master.csv"
    if not master.exists():
        pytest.skip("no local security master (written by the Shioaji provider)")
    known = {row["code"] for row in DOC["industries"]}
    codes = {r["industry_code"].strip() for r in csv.DictReader(master.open(encoding="utf-8-sig")) if r["type"] == "stock"}
    assert codes - {"", "00"} <= known, sorted(codes - {"", "00"} - known)


def _doc(**side):
    entry = {"index": "IX0028", "index_name": "半導體類指數", "check": {"how": "data"}}
    entry.update(side)
    return {"schema": "tw-industry-indexes-v1", "industries": [{"code": "24", "tse": entry, "otc": None}]}


@pytest.mark.parametrize("doc, where", [
    ([], "document"),
    ({**_doc(), "schema": "tw-industry-indexes-v2"}, "schema"),
    ({**_doc(), "industries": []}, "industries"),
    ({**_doc(), "industries": [{"code": "00", "tse": None}]}, "industries[0].code"),
    ({**_doc(), "industries": [_doc()["industries"][0]] * 2}, "industry 24: is listed twice"),
    (_doc(index="28"), "industry 24.tse.index"),
    (_doc(check={"how": "guess"}), "industry 24.tse.check.how"),
    (_doc(check="data"), "industry 24.tse.check.how"),
    (_doc(index_name=5), "industry 24.tse.index_name"),
])
def test_a_bad_table_names_the_file_and_the_entry(doc, where):
    from config import tw_industry_indexes

    with pytest.raises(tw_industry_indexes.IndustryIndexTableError) as err:
        tw_industry_indexes.parse(doc, source="bad.json")
    assert str(err.value).startswith(f"bad.json: {where}")


def test_a_proxy_side_names_the_other_markets_index():
    from config import tw_industry_indexes

    doc = _doc()
    doc["industries"][0]["otc"] = {"index": "IX0028", "check": {"how": "proxy"}}
    table = tw_industry_indexes.parse(doc)
    assert table.index_for("24", "otc") == "IX0028" and table.indexes[0].market == "tse"
    assert table.index_for("99", "tse") is None


def test_an_unreadable_table_fails_at_the_first_use_not_at_import(monkeypatch, tmp_path):
    from config import tw_industry_indexes
    from service.market.shared.provider_contract import ProviderCapabilities, _shioaji_rules

    bad = tmp_path / "tw_industry_indexes.json"
    bad.write_text("{", encoding="utf-8")
    monkeypatch.setattr(tw_industry_indexes, "PATH", bad)
    tw_industry_indexes.table.cache_clear()
    try:
        capabilities = ProviderCapabilities("shioaji", _shioaji_rules)   # what the module does at import: no read
        with pytest.raises(tw_industry_indexes.IndustryIndexTableError, match="unreadable"):
            capabilities.plan_for("STK", "2330")
    finally:
        tw_industry_indexes.table.cache_clear()
