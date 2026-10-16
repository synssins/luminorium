"""Run Luminorium on a PC.

  python tools/dev.py            # against the fake HA (writes go to the fake; nothing real)
  python tools/dev.py --real     # the real HA, READ-ONLY; token from LUMINORIUM_HA_TOKEN_FILE

UI on http://127.0.0.1:8199/
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "luminorium_addon"), str(ROOT)]

import uvicorn  # noqa: E402

from luminorium.app import Luminorium  # noqa: E402
from luminorium.settings import Settings  # noqa: E402
from luminorium.web.server import create_app  # noqa: E402
from tools.fake_ha import TOKEN, FakeHA  # noqa: E402

REAL_HA = "ws://192.168.1.104:8123/api/websocket"


async def main(real: bool, port: int) -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    data = ROOT / ".dev-data" / ("real" if real else "fake")
    if real:
        token_file = os.environ.get("LUMINORIUM_HA_TOKEN_FILE", "")
        if not token_file:
            raise SystemExit("Set LUMINORIUM_HA_TOKEN_FILE to the HA token file")
        token = Path(token_file).read_text(encoding="utf-8").strip()  # noqa: ASYNC240
        url, read_only = REAL_HA, True  # never writes to the real house from here
    else:
        fake = FakeHA()
        fake.default_latency = 0.15
        url = await fake.start(8124)
        token, read_only = TOKEN, False
    settings = Settings(
        ha_url=url,
        ha_token=token,
        data_dir=data / "data",
        config_dir=data / "config",
        port=port,
        host="127.0.0.1",
        read_only=read_only,
    )
    app = create_app(Luminorium(settings))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None))
    await server.serve()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--real", action="store_true")
    parser.add_argument("--port", type=int, default=8199)
    args = parser.parse_args()
    asyncio.run(main(args.real, args.port))
