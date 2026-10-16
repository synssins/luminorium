"""Runtime settings: from the add-on's options, or from environment variables on a dev PC."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

SUPERVISOR_WS = "ws://supervisor/core/websocket"
OPTIONS_FILE = Path("/data/options.json")
S6_TOKEN_FILE = Path("/run/s6/container_environment/SUPERVISOR_TOKEN")


@dataclass(frozen=True)
class Settings:
    ha_url: str
    ha_token: str = ""
    data_dir: Path = Path("/data")
    config_dir: Path = Path("/config")
    port: int = 8199
    host: str = "0.0.0.0"
    log_level: str = "info"
    # Blocks every service call: inventory and UI work, nothing is ever sent to a light.
    read_only: bool = False
    in_addon: bool = False
    # Clients allowed to reach the web server. In the add-on only the Supervisor's ingress proxy.
    allowed_clients: tuple[str, ...] = ()

    @property
    def token_known(self) -> bool:
        return bool(self.ha_token)

    def __repr__(self) -> str:  # never show the token
        return (
            f"Settings(ha_url={self.ha_url!r}, data_dir={str(self.data_dir)!r}, port={self.port}, "
            f"read_only={self.read_only}, in_addon={self.in_addon})"
        )


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _supervisor_token() -> str:
    """The Supervisor's token: from the environment, or from s6-overlay's copy of the container
    environment (a process started under s6's /init doesn't inherit it)."""
    token = os.environ.get("SUPERVISOR_TOKEN", "")
    if not token and S6_TOKEN_FILE.exists():
        token = S6_TOKEN_FILE.read_text(encoding="utf-8").strip()
    return token


def load() -> Settings:
    supervisor_token = _supervisor_token()
    if not supervisor_token and OPTIONS_FILE.exists():
        # In the add-on but without a token: never fall back to development settings
        raise SystemExit("Running as an add-on but no SUPERVISOR_TOKEN was found")
    if supervisor_token:
        options: dict = {}
        if OPTIONS_FILE.exists():
            options = json.loads(OPTIONS_FILE.read_text(encoding="utf-8"))
        return Settings(
            ha_url=SUPERVISOR_WS,
            ha_token=supervisor_token,
            log_level=str(options.get("log_level", "info")),
            read_only=bool(options.get("read_only", False)),
            in_addon=True,
            allowed_clients=("172.30.32.2", "127.0.0.1"),
        )

    # Development on a PC: LUMINORIUM_HA_URL plus a token, given directly or as a file path.
    token = os.environ.get("LUMINORIUM_HA_TOKEN", "")
    token_file = os.environ.get("LUMINORIUM_HA_TOKEN_FILE", "")
    if not token and token_file:
        token = Path(token_file).read_text(encoding="utf-8").strip()
    url = os.environ.get("LUMINORIUM_HA_URL", "ws://127.0.0.1:8124/api/websocket")
    data_dir = Path(os.environ.get("LUMINORIUM_DATA_DIR", ".dev-data"))
    return Settings(
        ha_url=url,
        ha_token=token,
        data_dir=data_dir / "data",
        config_dir=data_dir / "config",
        port=int(os.environ.get("LUMINORIUM_PORT", "8199")),
        host=os.environ.get("LUMINORIUM_HOST", "127.0.0.1"),
        log_level=os.environ.get("LUMINORIUM_LOG_LEVEL", "info"),
        # Against a real HA from a PC, read-only unless explicitly switched off.
        read_only=not _truthy(os.environ.get("LUMINORIUM_ALLOW_WRITES")) and "127.0.0.1" not in url,
        allowed_clients=(),
    )
