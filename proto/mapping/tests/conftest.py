import os
import sys

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import run_demo  # noqa: E402

_cache: dict = {}


@pytest.fixture(scope="session")
def scenario():
    """Renders, analyses and scores a named scenario once per test session (fixed seeds)."""
    def get(name: str) -> dict:
        if name not in _cache:
            _cache[name] = run_demo.run(name)
        return _cache[name]
    return get
