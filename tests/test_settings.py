from __future__ import annotations

import json

import pytest

from luminorium import settings


@pytest.fixture
def paths(tmp_path, monkeypatch):
    options = tmp_path / "options.json"
    token = tmp_path / "SUPERVISOR_TOKEN"
    monkeypatch.setattr(settings, "OPTIONS_FILE", options)
    monkeypatch.setattr(settings, "S6_TOKEN_FILE", token)
    monkeypatch.delenv("SUPERVISOR_TOKEN", raising=False)
    return options, token


def test_token_from_s6_container_environment(paths):
    options, token = paths
    options.write_text(json.dumps({"log_level": "debug", "read_only": True}))
    token.write_text("abc\n")
    cfg = settings.load()
    assert cfg.in_addon and cfg.ha_token == "abc"
    assert cfg.ha_url == settings.SUPERVISOR_WS
    assert cfg.read_only and cfg.log_level == "debug"
    assert "abc" not in repr(cfg)


def test_addon_without_token_stops(paths):
    options, _ = paths
    options.write_text("{}")
    with pytest.raises(SystemExit):
        settings.load()


def test_pc_against_real_ha_is_read_only(paths, monkeypatch):
    monkeypatch.setenv("LUMINORIUM_HA_URL", "ws://192.168.1.104:8123/api/websocket")
    monkeypatch.setenv("LUMINORIUM_HA_TOKEN", "x")
    monkeypatch.delenv("LUMINORIUM_ALLOW_WRITES", raising=False)
    assert settings.load().read_only
