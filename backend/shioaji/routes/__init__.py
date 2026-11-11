"""Route families of the Shioaji daemon. Each is built over the daemon's DaemonContext (or callables bound to it)
by the composition root, backend/shioaji/server.py; none creates a second lifecycle manager, websocket hub or
provider runtime."""

from .client_routes import ClientRouteDependencies, create_client_router
from .health_routes import create_health_router
from .history_routes import HistoryRouteDependencies, create_history_router
from .maintenance_routes import MaintenanceRouteDependencies, create_maintenance_router
from .market_data_routes import MarketDataRouteDependencies, create_market_data_router

__all__ = [
    "ClientRouteDependencies",
    "create_client_router",
    "create_health_router",
    "HistoryRouteDependencies",
    "create_history_router",
    "MaintenanceRouteDependencies",
    "create_maintenance_router",
    "MarketDataRouteDependencies",
    "create_market_data_router",
]
