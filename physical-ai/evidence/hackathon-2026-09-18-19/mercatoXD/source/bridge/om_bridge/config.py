"""Bridge configuration. Everything comes from the environment; no secrets in code."""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(Exception):
    """A required setting is missing or malformed."""


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is required (export it or put it in .env.local)")
    return value


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc


@dataclass(frozen=True)
class BridgeConfig:
    om_base_url: str
    om_api_key: str
    cell_id: str
    panel_base_url: str
    policy_url: str | None
    poll_interval_s: float
    goal_timeout_s: float
    home_preset: str
    search_preset: str

    @staticmethod
    def from_env() -> "BridgeConfig":
        return BridgeConfig(
            om_base_url=_require("OM_BASE_URL").rstrip("/"),
            om_api_key=_require("OM_API_KEY"),
            cell_id=_require("OM_ROBOT_CELL_ID"),
            panel_base_url=os.environ.get("A1X_PANEL_URL", "http://10.42.0.1:8080").rstrip("/"),
            policy_url=(os.environ.get("A1X_POLICY_URL") or None),
            poll_interval_s=_float("OM_POLL_INTERVAL_S", 3.0),
            goal_timeout_s=_float("A1X_GOAL_TIMEOUT_S", 12.0),
            home_preset=os.environ.get("A1X_HOME_PRESET", "home"),
            search_preset=os.environ.get("A1X_SEARCH_PRESET", "table"),
        )

    @property
    def panel_ws_url(self) -> str:
        return self.panel_base_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
