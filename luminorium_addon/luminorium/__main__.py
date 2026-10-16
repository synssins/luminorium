"""Entry point: python -m luminorium"""

from __future__ import annotations

import asyncio
import logging

import uvicorn

from . import __version__, settings
from .app import Luminorium
from .web.server import create_app


def main() -> None:
    cfg = settings.load()
    logging.basicConfig(
        level=getattr(logging, cfg.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger(__name__).info("Luminorium %s, %r", __version__, cfg)
    if not cfg.token_known:
        raise SystemExit("No HA token: set LUMINORIUM_HA_TOKEN or LUMINORIUM_HA_TOKEN_FILE")
    app = create_app(Luminorium(cfg))
    server = uvicorn.Server(
        uvicorn.Config(app, host=cfg.host, port=cfg.port, log_config=None, proxy_headers=False)
    )
    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
