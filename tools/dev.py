"""Run Luminorium on a PC.

  python tools/dev.py            # against the fake HA and fake devices (nothing real)
  python tools/dev.py --real     # the real HA, READ-ONLY; token from LUMINORIUM_HA_TOKEN_FILE

The fake run also starts fake devices for the direct drivers on loopback: an MQTT broker with a
fake Zigbee2MQTT, a fake Z-Wave JS server, a WiZ bulb and a WLED controller. --real starts no
direct driver (it would reach the real LAN).

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
from luminorium.net.mqtt import MQTTEndpoint  # noqa: E402
from luminorium.settings import DriverSettings, Settings  # noqa: E402
from luminorium.web.server import create_app  # noqa: E402
from tools.fake_ha import TOKEN, FakeHA  # noqa: E402
from tools.fake_lan import FakeWiZBulb, FakeWLED  # noqa: E402
from tools.fake_mqtt import FakeBroker, FakeZ2M  # noqa: E402
from tools.fake_zwave import FakeZWaveServer  # noqa: E402

REAL_HA = "ws://192.168.1.104:8123/api/websocket"


async def fake_devices(fake: FakeHA) -> DriverSettings:
    """Start fake devices for the direct drivers and point the fake HA at them."""
    broker = FakeBroker()
    await broker.start()
    await FakeZ2M(broker).start()
    zwave = FakeZWaveServer()
    fake.zwave_server_url = await zwave.start()
    bulb = FakeWiZBulb(mac="e3bc9ea23456")  # light.wiz_rgbww_tunable_c3b549
    await bulb.start()
    wled = FakeWLED()  # the front pathway lights
    await wled.start()
    for device in fake.devices:
        if ["wled", wled.mac] in device["identifiers"]:
            device["configuration_url"] = f"http://{wled.host}"
    return DriverSettings(
        enabled=frozenset({"z2m", "zwave_js", "wiz", "wled"}),
        mqtt=MQTTEndpoint("127.0.0.1", broker.port),
        wiz_subnets=(),
        wiz_hosts=(bulb.addr,),
        wled_ddp_port=wled.ddp_port,
    )


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
        drivers = DriverSettings()  # none: they would reach the real LAN
    else:
        fake = FakeHA()
        fake.default_latency = 0.15
        fake.unit_system = {"length": "mi", "temperature": "°F"}  # like the house's HA
        drivers = await fake_devices(fake)
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
        drivers=drivers,
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
