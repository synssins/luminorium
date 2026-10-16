"""Native effect resolution (DESIGN.md section 6.1).

The engine works with normalised effect names (`fire`, `ocean`, ...). Data files map each to the
names integrations use, and every name is checked against the light's own `effect_list`.
For a light, the result is the first that applies of:

1. native exact: the light has the effect
2. native close: it has a near alternative
3. software: the engine runs it (flicker, candle, breathe, lightning)
4. static: the effect's key colour
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from ..inventory.model import Light
from .color import Color, parse_color

log = logging.getLogger(__name__)

BUILTIN_DIR = Path(__file__).resolve().parent.parent / "data" / "effects"
SOFTWARE_EFFECTS = ("flicker", "candle", "breathe", "lightning")
_SPACE = re.compile(r"\s+")


def _norm(name: str) -> str:
    return _SPACE.sub(" ", name.replace("\xa0", " ")).strip().casefold()


@dataclass
class EffectDef:
    key: str
    name: str
    color: Color
    brightness: float = 0.8
    software: str | None = None
    # integration ("*" for any) -> {"exact": [...], "close": [...]}
    native: dict[str, dict[str, list[str]]] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, key: str, data: dict) -> EffectDef:
        software = data.get("software")
        if software is not None and software not in SOFTWARE_EFFECTS:
            raise ValueError(f"effect {key}: unknown software effect {software!r}")
        native = {}
        for integration, names in (data.get("native") or {}).items():
            native[str(integration)] = {
                "exact": [str(n) for n in (names or {}).get("exact") or []],
                "close": [str(n) for n in (names or {}).get("close") or []],
            }
        return cls(
            key=key,
            name=str(data.get("name") or key.replace("_", " ").title()),
            color=parse_color(data.get("color", "white")),
            brightness=float(data.get("brightness", 0.8)),
            software=software,
            native=native,
        )

    def candidates(self, integration: str, kind: str) -> list[str]:
        names = list(self.native.get(integration, {}).get(kind, []))
        names += [n for n in self.native.get("*", {}).get(kind, []) if n not in names]
        return names


@dataclass(frozen=True)
class Resolution:
    method: str  # native | close | software | static
    native_name: str | None = None
    software: str | None = None

    @property
    def is_native(self) -> bool:
        return self.method in ("native", "close")


class EffectLibrary:
    def __init__(self, effects: dict[str, EffectDef] | None = None):
        self.effects: dict[str, EffectDef] = effects or {}

    @classmethod
    def load(cls, *directories: Path) -> EffectLibrary:
        """Read effects/*.yaml from each folder in turn; later folders override earlier ones."""
        lib = cls()
        for directory in (BUILTIN_DIR, *directories):
            if not directory.is_dir():
                continue
            for path in sorted(directory.glob("*.yaml")):
                try:
                    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                    for key, spec in data.items():
                        lib.effects[str(key)] = EffectDef.from_dict(str(key), spec or {})
                except (OSError, yaml.YAMLError, ValueError, TypeError) as err:
                    log.warning("Skipping effects file %s: %s", path, err)
        return lib

    def get(self, key: str) -> EffectDef | None:
        return self.effects.get(key)

    def resolve(self, key: str, light: Light, allow_close: bool = True) -> Resolution:
        effect = self.effects.get(key)
        available = {}
        if light.profile is not None:
            available = {_norm(e): e for e in light.profile.capabilities.effects}
        if effect is None:
            # Not a known effect: maybe the light's own name for something
            own = available.get(_norm(key))
            return Resolution("native", own) if own else Resolution("static")
        for kind in ("exact", "close") if allow_close else ("exact",):
            for name in effect.candidates(light.integration, kind):
                own = available.get(_norm(name))
                if own:
                    return Resolution("native" if kind == "exact" else "close", own)
        if effect.software:
            return Resolution("software", software=effect.software)
        return Resolution("static")

    def native_name(self, key: str, light: Light) -> str | None:
        """The light's own name for a normalised effect, if it has one (exact or close)."""
        return self.resolve(key, light).native_name

    def to_list(self) -> list[dict]:
        return [
            {
                "id": e.key,
                "name": e.name,
                "color": e.color.hex(),
                "software": e.software,
                "integrations": sorted(k for k in e.native if k != "*"),
            }
            for e in self.effects.values()
        ]
