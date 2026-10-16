from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from tools.fake_ha import FIXTURES, TOKEN, FakeHA

from luminorium.app import Luminorium
from luminorium.settings import Settings


def load_fixture(name: str):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


@pytest.fixture
def raw():
    return {
        name: load_fixture(name)
        for name in ("floors", "areas", "devices", "entities", "states", "zwave")
    }


@pytest.fixture
async def fake_ha():
    fake = FakeHA()
    url = await fake.start()
    fake.url = url  # type: ignore[attr-defined]
    yield fake
    await fake.stop()


def make_settings(url: str, data: Path, **overrides) -> Settings:
    values = dict(
        ha_url=url,
        ha_token=TOKEN,
        data_dir=data / "data",
        config_dir=data / "config",
        read_only=False,
    )
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
async def lum(fake_ha, tmp_path):
    app = Luminorium(make_settings(fake_ha.url, tmp_path), test_hold_s=0.05)
    await app.start()
    await asyncio.wait_for(app.inventory.loaded.wait(), 10)
    yield app
    await app.stop()


async def wait_for(predicate, timeout: float = 5.0, interval: float = 0.02):
    """Poll until predicate() is true."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if predicate():
            return
        await asyncio.sleep(interval)
    raise AssertionError("condition not met in time")


@pytest.fixture
def house(raw):
    """The real house's inventory, built from the fixtures (no HA, no app)."""
    from luminorium.inventory.builder import build

    return build(
        raw["floors"], raw["areas"], raw["devices"], raw["entities"], raw["states"], raw["zwave"]
    )
