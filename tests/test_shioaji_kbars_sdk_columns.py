"""The Shioaji SDK names its K bar fields Open / High / Low / Close / Volume / Amount."""
import pandas as pd

from service.market.shioaji.history_repository import ShioajiHistoricalRepository


def test_the_sdks_capitalized_kbar_columns_are_read():
    payload = pd.DataFrame({"ts": [1760000000000000000], "Open": [100.0], "High": [101.0], "Low": [99.0], "Close": [100.5],
                            "Volume": [12], "Amount": [1206.0]})
    frame = ShioajiHistoricalRepository._normalize_kbars(payload, code="2330", date_text="2025-10-09")
    row = frame.iloc[0]
    assert (row["open"], row["high"], row["low"], row["close"], row["volume"], row["amount"]) == (100.0, 101.0, 99.0, 100.5, 12, 1206.0)
