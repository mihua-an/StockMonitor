from service.market.reference.watch_page_service import WatchPageService
import pytest


def test_reader_initialization_does_not_write_watch_pages(tmp_path, monkeypatch):
    path = tmp_path / "watch_pages.csv"
    def forbidden(*args, **kwargs):
        raise AssertionError("read-only service initialization must not write")
    monkeypatch.setattr(WatchPageService, "_write_csv", forbidden)
    service = WatchPageService(path)
    assert service.list_pages() == []
    assert not path.exists()


def test_provider_codes_projects_only_requested_provider_and_deduplicates(tmp_path):
    service = WatchPageService(tmp_path / "watch_pages.csv")
    service.save_pages([
        {
            "id": "tw",
            "name": "台股",
            "source": "shioaji",
            "items": [{"code": "2330", "name": "台積電"}],
        },
        {
            "id": "us-a",
            "name": "美股 A",
            "source": "futu",
            "items": [
                {"code": "us.tsm", "name": "台積電 ADR"},
                {"code": "US.MU", "name": "美光"},
            ],
        },
        {
            "id": "us-b",
            "name": "美股 B",
            "source": "futu",
            "items": [{"code": "US.TSM", "name": "重複名稱不覆蓋"}],
        },
    ])

    assert service.provider_codes("futu") == frozenset({"US.TSM", "US.MU"})
    assert service.provider_codes("shioaji") == frozenset({"2330"})
    assert service.all_codes() == {"2330"}


def test_repeated_hot_path_load_uses_unchanged_csv_cache(tmp_path, monkeypatch):
    service = WatchPageService(tmp_path / "watch_pages.csv")
    service.save_pages([{
        "id": "tw", "name": "台股", "source": "shioaji",
        "items": [{"code": "2330", "name": "台積電"}],
    }])
    calls = 0
    original = service._read_csv

    def counted_read():
        nonlocal calls
        calls += 1
        return original()

    monkeypatch.setattr(service, "_read_csv", counted_read)
    assert service.list_pages()[0]["codes"] == ["2330"]
    assert service.list_pages()[0]["codes"] == ["2330"]
    assert service.all_codes() == {"2330"}
    assert calls == 0


def test_corrupted_alert_threshold_is_reported_instead_of_silently_disabled(tmp_path):
    path = tmp_path / "watch_pages.csv"
    service = WatchPageService(path)
    path.write_text(
        "page_id,page_name,page_source,page_order,code,code_order,code_name,industry_name,market,security_type,source,lower_alert,upper_alert\n"
        "tw,台股,shioaji,0,2330,0,台積電,,tw,stock,shioaji,not-a-number,\n",
        encoding="utf-8-sig",
    )
    with pytest.raises(ValueError, match="2330.*低價提醒.*not-a-number"):
        service.list_pages()


def test_file_replacement_during_read_is_not_cached_as_new_version(tmp_path, monkeypatch):
    service = WatchPageService(tmp_path / "watch_pages.csv")
    signatures = iter([(1, 1), (2, 2)])
    monkeypatch.setattr(service, "_file_signature", lambda: next(signatures))
    reads = iter([[{"id": "old"}], [{"id": "new"}]])
    monkeypatch.setattr(service, "_read_csv", lambda: next(reads))
    assert service._cached_pages() == [{"id": "old"}]
    assert service._cached_pages() == [{"id": "new"}]


def test_a_non_numeric_alert_is_refused_on_save_as_on_read(tmp_path):
    """R13-27: one parser for both; empty is no alert, anything else must be a number (it was cleared on save)."""
    import pytest

    from service.market.reference.watch_page_service import WatchPageService

    service = WatchPageService(tmp_path / "watch_pages.csv")
    with pytest.raises(ValueError, match="2330"):
        service.save_pages([{"source": "shioaji", "items": [{"code": "2330", "lower_alert": "abc"}]}])
    with pytest.raises(ValueError, match="2330"):
        service.save_pages([{"source": "shioaji", "items": [{"code": "2330", "upper_alert": "inf"}]}])
    saved = service.save_pages([{"source": "shioaji", "items": [{"code": "2330", "lower_alert": "", "upper_alert": "612.5"}]}])
    assert saved[0]["items"][0]["lower_alert"] is None and saved[0]["items"][0]["upper_alert"] == 612.5


def test_the_watch_page_writer_is_the_shared_durable_atomic_writer(tmp_path, monkeypatch):
    """R13-28: a failed write leaves no temporary file behind and the old file whole."""
    import pytest

    from service.market.reference.watch_page_service import WatchPageService
    from service.platform import atomic_files

    service = WatchPageService(tmp_path / "watch_pages.csv")
    service.save_pages([{"source": "shioaji", "items": [{"code": "2330"}]}])
    before = (tmp_path / "watch_pages.csv").read_bytes()

    def refuse(_source, _destination):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(atomic_files, "replace_file", refuse)
    with pytest.raises(OSError):
        service.save_pages([{"source": "shioaji", "items": [{"code": "2317"}]}])
    assert (tmp_path / "watch_pages.csv").read_bytes() == before
    assert [p.name for p in tmp_path.iterdir()] == ["watch_pages.csv"], "no temporary file left"
