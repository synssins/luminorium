"""Small JSON documents in /data, written atomically."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


class JsonStore:
    def __init__(self, directory: Path):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)

    def path(self, name: str) -> Path:
        return self.directory / f"{name}.json"

    def load(self, name: str, default: Any = None) -> Any:
        try:
            return json.loads(self.path(name).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return default
        except json.JSONDecodeError:
            # Keep the broken file for inspection; start from the default
            broken = self.path(name).with_suffix(".broken.json")
            os.replace(self.path(name), broken)
            return default

    def save(self, name: str, data: Any) -> None:
        target = self.path(name)
        fd, tmp = tempfile.mkstemp(dir=self.directory, prefix=f".{name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=1, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, target)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def delete(self, name: str) -> None:
        self.path(name).unlink(missing_ok=True)
