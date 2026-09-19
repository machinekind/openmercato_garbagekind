import pytest

from om_bridge.config import BridgeConfig, ConfigError

REQUIRED = {
    "OM_BASE_URL": "https://erp.example/",
    "OM_API_KEY": "secret",
    "OM_ROBOT_CELL_ID": "cell-1",
}


def set_env(monkeypatch, **extra):
    for key in list(REQUIRED) + [
        "A1X_PANEL_URL",
        "A1X_POLICY_URL",
        "OM_POLL_INTERVAL_S",
        "A1X_GOAL_TIMEOUT_S",
        "A1X_HOME_PRESET",
        "A1X_SEARCH_PRESET",
    ]:
        monkeypatch.delenv(key, raising=False)
    for key, value in {**REQUIRED, **extra}.items():
        monkeypatch.setenv(key, value)


def test_defaults_point_at_the_cable_side_panel(monkeypatch):
    set_env(monkeypatch)
    cfg = BridgeConfig.from_env()

    assert cfg.om_base_url == "https://erp.example"  # trailing slash trimmed
    assert cfg.panel_base_url == "http://10.42.0.1:8080"
    assert cfg.policy_url is None
    assert cfg.poll_interval_s == pytest.approx(3.0)
    assert (cfg.home_preset, cfg.search_preset) == ("home", "table")


def test_ws_url_is_derived_from_the_panel_url(monkeypatch):
    set_env(monkeypatch, A1X_PANEL_URL="http://192.168.1.5:8080/")
    assert BridgeConfig.from_env().panel_ws_url == "ws://192.168.1.5:8080/ws"


def test_https_panel_gets_a_wss_socket(monkeypatch):
    set_env(monkeypatch, A1X_PANEL_URL="https://panel.example")
    assert BridgeConfig.from_env().panel_ws_url == "wss://panel.example/ws"


@pytest.mark.parametrize("missing", sorted(REQUIRED))
def test_missing_required_setting_is_named(monkeypatch, missing):
    set_env(monkeypatch)
    monkeypatch.delenv(missing)

    with pytest.raises(ConfigError, match=missing):
        BridgeConfig.from_env()


def test_non_numeric_interval_is_rejected(monkeypatch):
    set_env(monkeypatch, OM_POLL_INTERVAL_S="soon")

    with pytest.raises(ConfigError, match="must be a number"):
        BridgeConfig.from_env()
