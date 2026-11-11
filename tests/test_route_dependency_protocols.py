"""Route dependencies are typed by the smallest Protocol their routes call (api/routes/dependencies.py), and the
real classes wired into them have every method of it -- a missing one fails here, not on the first request."""
from __future__ import annotations

import dataclasses
import importlib
import typing

import pytest

from api.routes import dependencies as deps
from api.routes.history_routes import DataCenterRouteDependencies, HistoryRouteDependencies
from api.routes.market_routes import MarketRouteDependencies
from api.source_diagnostics import SourceDiagnostics

WIRED = (
    ("service.market.shioaji.daemon_client.MarketDaemonClient", deps.ProviderRuntime),
    ("service.market.futu.daemon_client.MoomooDaemonClient", deps.FutuDaemonClient),
    ("service.market.shared.disabled_source.DisabledSourceClient", deps.ProviderRuntime),
    ("api.provider_http_client.ProviderHttpClient", deps.ProviderApp),
    ("service.market.projection.analysis_event_archive.AnalysisEventArchive", deps.EventArchive),
    ("service.market.history.history_replay_service.HistoryReplayService", deps.ReplayService),
    ("service.account.actual_account_service.ActualAccountService", deps.DayTradeLedger),
    ("service.market.query.data_center_service.DataCenterService", deps.DataCatalog),
)


@pytest.mark.parametrize(("path", "protocol"), WIRED)
def test_the_wired_class_has_every_method_its_routes_call(path, protocol):
    module, _, name = path.rpartition(".")
    cls = getattr(importlib.import_module(module), name)
    methods = [attr for attr in protocol.__protocol_attrs__ if attr != "app"]
    assert [attr for attr in methods if not callable(getattr(cls, attr, None))] == [], f"{name} lacks part of {protocol.__name__}"


@pytest.mark.parametrize("dependencies", (MarketRouteDependencies, HistoryRouteDependencies, DataCenterRouteDependencies,
                                          SourceDiagnostics))
def test_no_dependency_field_is_any(dependencies):
    hints = typing.get_type_hints(dependencies, globalns=vars(importlib.import_module(dependencies.__module__)))
    for field in dataclasses.fields(dependencies):
        assert hints[field.name] is not typing.Any, f"{dependencies.__name__}.{field.name} is Any"
