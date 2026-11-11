"""Shared provider interfaces and status supervision."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Iterable, Mapping


class ProviderThinCallbackAdapter(ABC):
    """Common lifecycle contract for broker SDK callback adapters.

    Concrete adapters own only provider-specific callback registration/decoding.
    Heavy canonical conversion, storage, signals and WebSocket work must stay
    outside the provider callback stack.
    """

    def __init__(self, provider: str) -> None:
        normalized = str(provider or "").strip().lower()
        if not normalized:
            raise ValueError("provider is required")
        self.provider = normalized
        self._installed = False
        self._install_count = 0

    @property
    def installed(self) -> bool:
        return self._installed

    @property
    def install_count(self) -> int:
        return self._install_count

    def reset(self) -> None:
        self._installed = False

    def _mark_installed(self) -> None:
        self._installed = True
        self._install_count += 1

    def snapshot(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "class": type(self).__name__,
            "installed": self.installed,
            "install_count": self.install_count,
        }

    @abstractmethod
    def install(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError


class ProviderSubscriptionManager(ABC):
    """Common control-plane contract for provider subscription managers.

    A provider subscribes exactly Market Runtime's plan: ``replace_plan`` takes its instruments as
    Market Runtime names them and returns those this provider refused, with the reason. Provider rules remain
    concrete (Shioaji stream capacity vs Futu minimum subscription lifetime).
    """

    def __init__(self, provider: str) -> None:
        normalized = str(provider or "").strip().lower()
        if not normalized:
            raise ValueError("provider is required")
        self.provider = normalized

    @abstractmethod
    def replace_plan(self, items: Iterable[Mapping[str, Any]]) -> dict[tuple[str, str], str]:
        raise NotImplementedError

    @abstractmethod
    def snapshot(self) -> dict[str, Any]:
        raise NotImplementedError


@dataclass(frozen=True)
class ProviderMarketBackend:
    """Small composition root shared by both market-provider services."""

    provider: str
    thin_callback: ProviderThinCallbackAdapter
    subscription_manager: ProviderSubscriptionManager
    capabilities: Any | None = None

    def __post_init__(self) -> None:
        provider = str(self.provider or "").strip().lower()
        if not provider:
            raise ValueError("provider is required")
        if self.thin_callback.provider != provider:
            raise ValueError("thin callback provider does not match backend provider")
        if self.subscription_manager.provider != provider:
            raise ValueError("subscription manager provider does not match backend provider")
        if self.capabilities is not None and str(getattr(self.capabilities, "provider", "") or "").strip().lower() != provider:
            raise ValueError("capability provider does not match backend provider")
        object.__setattr__(self, "provider", provider)

    def install_callbacks(self, *args: Any, **kwargs: Any) -> Any:
        return self.thin_callback.install(*args, **kwargs)

    def reset_callbacks(self) -> None:
        self.thin_callback.reset()

    def snapshot(self) -> dict[str, Any]:
        payload = {
            "provider": self.provider,
            "thin_callback": self.thin_callback.snapshot(),
            "subscription_manager": self.subscription_manager.snapshot(),
        }
        if self.capabilities is not None and hasattr(self.capabilities, "snapshot"):
            payload["capabilities"] = self.capabilities.snapshot()
        return payload
