"""Layers: what each element shows over time (DESIGN.md section 6.3).

A layer is sampled per element at a time `t` and returns a `Span`: the look at `t`, and how it
goes on from there: constant, or a straight fade to another look, until a time. The planner uses
spans to send one long fade instead of many small steps. Content that changes too fast to
describe that way (software effects) is marked `busy`, and the planner samples or averages it.

Layers stack by priority. Each layer sees the span of everything below it (`below`), so a dip
dims whatever is under it and a fade-in starts from it. The bottom of the stack is the light's
own state from before the engine touched it.
"""

from __future__ import annotations

import bisect
import math
import random
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any

from ..inventory.model import Light
from .color import OFF, Color, Look, color_to_dict, parse_color
from .effects import SOFTWARE_EFFECTS, EffectLibrary, Resolution

INF = math.inf
# Photosensitivity: nothing flashes faster than this unless a show allows strobe (not yet)
MAX_FLASH_HZ = 3.0
DEFAULT_PRIORITY = {
    "static": 10,
    "palette": 10,
    "native_effect": 20,
    "software_effect": 20,
    "dip": 50,
    "flash": 60,
}


class LayerError(ValueError):
    pass


@dataclass(frozen=True)
class Span:
    look: Look
    start: float = 0.0
    until: float = INF
    to: Look | None = None  # None: constant; else a straight fade to this look at `until`
    crisp: bool = False  # edges should be sharp (no transition)
    busy: bool = False  # changes faster than spans describe: sample it

    def at(self, t: float) -> Look:
        if self.to is None or self.until == INF or t <= self.start:
            return self.look
        if t >= self.until:
            return self.to
        return self.look.mix(self.to, (t - self.start) / (self.until - self.start))

    def clip(self, until: float) -> Span:
        if until >= self.until:
            return self
        if self.to is None:
            return replace(self, until=until)
        return replace(self, to=self.at(until), until=until)


def base_span(look: Look, t: float) -> Span:
    return Span(look, t)


def _range(value: Any, default: tuple[float, float], scale: float = 1.0) -> tuple[float, float]:
    if value is None:
        return default
    if isinstance(value, int | float):
        return float(value) * scale, float(value) * scale
    lo, hi = value
    lo, hi = float(lo) * scale, float(hi) * scale
    return (lo, hi) if lo <= hi else (hi, lo)


def _rng(*parts: object) -> random.Random:
    # str seeds are hashed with SHA-512: the same on every run and every machine
    return random.Random(":".join(str(p) for p in parts))


# ---- palettes ---------------------------------------------------------------------------------


@dataclass
class Palette:
    id: str
    name: str
    colors: list[tuple[Color, float]]  # (colour, weight)
    brightness: tuple[float, float] = (0.35, 0.7)  # 0-1
    transition_s: tuple[float, float] = (8.0, 20.0)
    hold_s: tuple[float, float] = (5.0, 30.0)
    spread: str = "per_element"  # per_element | together
    white_kelvin: float | None = None  # what white-only lights show; else each colour's nearest
    category: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict, palette_id: str | None = None) -> Palette:
        pid = str(data.get("id") or palette_id or "").strip()
        if not pid:
            raise LayerError("a palette needs an id")
        colors = []
        for entry in data.get("colors") or []:
            weight = 1.0
            if isinstance(entry, dict) and "weight" in entry:
                weight = float(entry["weight"])
                entry = {k: v for k, v in entry.items() if k != "weight"}
            if weight <= 0:
                continue
            try:
                colors.append((parse_color(entry), weight))
            except (ValueError, TypeError) as err:
                raise LayerError(f"palette {pid}: {err}") from err
        if not colors:
            raise LayerError(f"palette {pid} has no colours")
        spread = str(data.get("spread", "per_element"))
        if spread not in ("per_element", "together"):
            raise LayerError(f"palette {pid}: spread must be per_element or together")
        category = data.get("category") or []
        white = data.get("white")
        brightness = _range(data.get("brightness"), (0.35, 0.7), 1 / 100)
        if not 0 <= brightness[0] <= brightness[1] <= 1:
            raise LayerError(f"palette {pid}: brightness is a percent range, 0-100")
        palette = cls(
            id=pid,
            name=str(data.get("name") or pid.replace("_", " ").title()),
            colors=colors,
            brightness=brightness,
            transition_s=_range(data.get("transition_s"), (8.0, 20.0)),
            hold_s=_range(data.get("hold_s"), (5.0, 30.0)),
            spread=spread,
            white_kelvin=parse_color(white).cct() if white is not None else None,
            category=[category] if isinstance(category, str) else [str(c) for c in category],
        )
        if palette.transition_s[0] < 0 or palette.hold_s[0] < 0:
            raise LayerError(f"palette {pid}: times can't be negative")
        if palette.transition_s[1] + palette.hold_s[1] <= 0:
            raise LayerError(f"palette {pid}: transition_s or hold_s must be above 0")
        return palette

    def to_dict(self) -> dict:
        data: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "colors": [{**color_to_dict(c), "weight": w} for c, w in self.colors],
            "brightness": [round(self.brightness[0] * 100), round(self.brightness[1] * 100)],
            "transition_s": list(self.transition_s),
            "hold_s": list(self.hold_s),
            "spread": self.spread,
        }
        if self.white_kelvin is not None:
            data["white"] = {"kelvin": round(self.white_kelvin)}
        return data


class _Walk:
    """One element's random walk through a palette: hold, fade to the next colour, hold, ...
    Built lazily and deterministically from its seed, so any time can be sampled."""

    KEEP_S = 120.0

    def __init__(
        self, palette: Palette, rng: random.Random, start: float, scale: float, phase: bool
    ):
        self.p = palette
        self.rng = rng
        self.scale = scale
        self.index = self._pick(None)
        look = self._look(self.index)
        hold = rng.uniform(0, palette.hold_s[1]) if phase else rng.uniform(*palette.hold_s)
        # segments: (t0, t1, from, to); a hold has from == to
        self.starts: list[float] = [start]
        self.segments: list[tuple[float, float, Look, Look]] = [(start, start + hold, look, look)]

    def _pick(self, previous: int | None) -> int:
        choices = [i for i in range(len(self.p.colors)) if i != previous] or [0]
        weights = [self.p.colors[i][1] for i in choices]
        return self.rng.choices(choices, weights)[0]

    def _look(self, index: int) -> Look:
        lo, hi = self.p.brightness
        brightness = self.rng.uniform(lo, hi) * self.scale
        return Look(self.p.colors[index][0], min(1.0, brightness), white_k=self.p.white_kelvin)

    def _extend(self, t: float) -> None:
        while self.segments[-1][1] <= t:
            _, end, _, current = self.segments[-1]
            self.index = self._pick(self.index)
            nxt = self._look(self.index)
            fade = self.rng.uniform(*self.p.transition_s)
            hold = self.rng.uniform(*self.p.hold_s)
            self.starts += [end, end + fade]
            self.segments += [
                (end, end + fade, current, nxt),
                (end + fade, end + fade + hold, nxt, nxt),
            ]
        # Forget the distant past
        cut = bisect.bisect_left(self.starts, t - self.KEEP_S)
        if cut > 2:
            del self.starts[: cut - 2]
            del self.segments[: cut - 2]

    def span(self, t: float) -> Span:
        self._extend(t)
        i = max(0, bisect.bisect_right(self.starts, t) - 1)
        t0, t1, a, b = self.segments[i]
        if a is b or t1 <= t0:
            return Span(a, t, t1)
        k = (t - t0) / (t1 - t0)
        return Span(a.mix(b, k), t, t1, to=b)


# ---- software effects -------------------------------------------------------------------------


class SoftwareEffect:
    """Deterministic functions of time; the planner keeps them within each light's rate."""

    def __init__(self, kind: str, look: Look, params: dict, seed: str):
        if kind not in SOFTWARE_EFFECTS:
            raise LayerError(f"unknown software effect {kind!r}")
        self.kind = kind
        self.look = look
        self.seed = seed
        self.speed = float(params.get("speed_hz", {"flicker": 6.0, "candle": 3.0}.get(kind, 1.0)))
        self.speed = min(10.0, max(0.1, self.speed))
        self.depth = min(
            1.0, max(0.0, float(params.get("depth", 0.5 if kind == "flicker" else 0.4)))
        )
        self.period = max(0.5, float(params.get("period_s", 4.0)))
        self.low = min(1.0, max(0.0, float(params.get("low", 0.15))))
        self.interval = max(1.0, float(params.get("interval_s", 6.0)))
        self._strikes: list[tuple[float, float]] = []  # lightning flashes (on, off)
        self._strike_rng = _rng(seed, "strikes")
        self._next_strike = 0.0

    def _noise(self, k: int) -> float:
        return _rng(self.seed, k).random()

    def span(self, t: float, below: Span) -> Span:
        look = self.look
        if self.kind == "flicker":
            k = math.floor(t * self.speed)
            factor = 1 - self.depth * self._noise(k)
            return Span(look.scaled(factor), t, (k + 1) / self.speed, crisp=True, busy=True)
        if self.kind == "candle":
            x = t * self.speed
            k = math.floor(x)
            a, b = self._noise(k), self._noise(k + 1)
            w = (1 - math.cos(math.pi * (x - k))) / 2
            factor = 1 - self.depth * (a + (b - a) * w)
            return Span(look.scaled(factor), t, (k + 1) / self.speed, busy=True)
        if self.kind == "breathe":
            phase = (1 - math.cos(2 * math.pi * t / self.period)) / 2
            factor = self.low + (1 - self.low) * phase
            return Span(look.scaled(factor), t, t + self.period / 16, busy=True)
        # lightning: the layer below between strikes, short bright flashes in a strike
        flash = self._flash_at(t)
        if flash is not None:
            return Span(look, t, flash[1], crisp=True, busy=True)
        nxt = self._next_flash_after(t)
        return Span(below.at(t), t, min(nxt, below.until), crisp=True, busy=True)

    def _strikes_until(self, t: float) -> None:
        rng = self._strike_rng
        while self._next_strike <= t + 30:
            start = self._next_strike + rng.expovariate(1 / self.interval)
            when = start
            for _ in range(rng.choice((1, 1, 2, 2, 3))):
                on = rng.uniform(0.08, 0.15)
                self._strikes.append((when, when + on))
                when += 1 / MAX_FLASH_HZ + rng.uniform(0, 0.15)
            self._next_strike = when + 1.0
        while len(self._strikes) > 64 and self._strikes[0][1] < t - 10:
            self._strikes.pop(0)

    def _flash_at(self, t: float) -> tuple[float, float] | None:
        self._strikes_until(t)
        for on, off in self._strikes:
            if on <= t < off:
                return on, off
            if on > t:
                break
        return None

    def _next_flash_after(self, t: float) -> float:
        self._strikes_until(t)
        for on, _ in self._strikes:
            if on > t:
                return on
        return t + 1.0


# ---- layers -----------------------------------------------------------------------------------


@dataclass
class LayerContext:
    effects: EffectLibrary
    palettes: dict[str, Palette]
    seed: str
    # element id -> where it is on the house map ({x, y, z} in metres), or None
    position: Callable[[str], dict | None] | None = None


class Layer:
    kind = ""
    colour = False  # a colour layer: white-only lights are left out of it unless asked

    def __init__(self, spec: dict, ctx: LayerContext, index: int):
        self.spec = spec
        self.index = index
        self.seed = f"{ctx.seed}:{index}"
        self.priority = int(spec.get("priority", DEFAULT_PRIORITY.get(self.kind, 10)))
        self.at_s = max(0.0, float(spec.get("at_s", 0.0)))
        duration = spec.get("duration_s")
        self.duration_s: float | None = float(duration) if duration is not None else None
        self.fade_in_s = max(0.0, float(spec.get("fade_in_s", self.default_fade_in())))
        self.fade_out_s = max(0.0, float(spec.get("fade_out_s", 0.0)))
        self.targets: dict | None = spec.get("targets")
        self.start = 0.0
        self.end = INF

    def default_fade_in(self) -> float:
        return 0.0

    def bind(self, show_start: float) -> None:
        self.start = show_start + self.at_s
        self.end = self.start + self.duration_s if self.duration_s is not None else INF

    def setup(self, element: str, lights: list[Light]) -> None:
        """Called once per element before the first sample."""

    def active(self, t: float) -> bool:
        return self.start <= t < self.end

    def content(self, element: str, t: float, below: Span) -> Span:
        raise NotImplementedError

    def span(self, element: str, t: float, below: Span) -> Span:
        own = self.content(element, t, below).clip(self.end)
        fade_in_end = self.start + self.fade_in_s
        fade_out_start = self.end - self.fade_out_s
        if t < fade_in_end:
            return self._blend(below, own, t, fade_in_end, (t - self.start) / self.fade_in_s, 1.0)
        if self.fade_out_s and t >= fade_out_start:
            k = (t - fade_out_start) / self.fade_out_s
            return self._blend(below, own, t, self.end, 1 - k, 0.0)
        if self.fade_out_s and own.until > fade_out_start:
            own = own.clip(fade_out_start)
        return own

    @staticmethod
    def _blend(
        below: Span, own: Span, t: float, phase_end: float, k_now: float, k_end: float
    ) -> Span:
        until = min(phase_end, own.until, below.until)
        k_until = k_now + (k_end - k_now) * ((until - t) / (phase_end - t) if phase_end > t else 1)
        look = below.at(t).mix(own.at(t), k_now)
        to = below.at(until).mix(own.at(until), k_until)
        return Span(look, t, until, to=to, crisp=own.crisp, busy=own.busy)

    def describe(self) -> dict:
        return {
            "type": self.kind,
            "priority": self.priority,
            "at_s": self.at_s,
            "duration_s": self.duration_s,
        }


class StaticLayer(Layer):
    kind = "static"

    def __init__(self, spec, ctx, index):
        super().__init__(spec, ctx, index)
        self.look = Look(
            parse_color(spec.get("color", "warm_white")), _fraction(spec.get("brightness", 100))
        )

    def default_fade_in(self) -> float:
        return 1.0

    def content(self, element, t, below):
        return Span(self.look, t)


class PaletteLayer(Layer):
    kind = "palette"
    colour = True

    def __init__(self, spec, ctx, index):
        super().__init__(spec, ctx, index)
        ref = spec.get("palette")
        if isinstance(ref, dict):
            self.palette = Palette.from_dict(ref, "inline")
        elif isinstance(ref, str) and ref in ctx.palettes:
            self.palette = ctx.palettes[ref]
        else:
            raise LayerError(f"unknown palette {ref!r}")
        self.scale = _fraction(spec.get("brightness", 100))
        self._walks: dict[str, _Walk] = {}

    def default_fade_in(self) -> float:
        return 2.0

    def _walk(self, element: str) -> _Walk:
        walk = self._walks.get(element)
        if walk is None:
            together = self.palette.spread == "together"
            key = "together" if together else element
            walk = _Walk(self.palette, _rng(self.seed, key), self.start, self.scale, not together)
            self._walks[element] = walk
        return walk

    def content(self, element, t, below):
        return self._walk(element).span(t)

    def describe(self):
        return {**super().describe(), "palette": self.palette.id}


class SoftwareEffectLayer(Layer):
    kind = "software_effect"

    def __init__(self, spec, ctx, index):
        super().__init__(spec, ctx, index)
        self.effect = str(spec.get("effect", ""))
        if self.effect not in SOFTWARE_EFFECTS:
            raise LayerError(f"software_effect must be one of {', '.join(SOFTWARE_EFFECTS)}")
        default = "1900K" if self.effect == "candle" else "white"
        self.look = Look(
            parse_color(spec.get("color", default)), _fraction(spec.get("brightness", 100))
        )
        self.params = dict(spec)
        self._per_element: dict[str, SoftwareEffect] = {}

    def _fx(self, element: str) -> SoftwareEffect:
        fx = self._per_element.get(element)
        if fx is None:
            fx = SoftwareEffect(self.effect, self.look, self.params, f"{self.seed}:{element}")
            self._per_element[element] = fx
        return fx

    def content(self, element, t, below):
        return self._fx(element).span(t, below)

    def describe(self):
        return {**super().describe(), "effect": self.effect}


class NativeEffectLayer(Layer):
    """A normalised effect: native where every light of the element has it, else software,
    else the effect's key colour."""

    kind = "native_effect"

    def __init__(self, spec, ctx, index):
        super().__init__(spec, ctx, index)
        self.key = str(spec.get("effect", ""))
        self.library = ctx.effects
        effect = ctx.effects.get(self.key)
        color = spec.get("color")
        self.color = (
            parse_color(color)
            if color is not None
            else (effect.color if effect else Color.from_kelvin(2700))
        )
        default_b = effect.brightness if effect else 0.8
        self.brightness = _fraction(spec.get("brightness", default_b * 100))
        self.software = effect.software if effect else None
        self.allow_close = bool(spec.get("allow_close", True))
        self.allow_software = bool(spec.get("allow_software", True))
        self.methods: dict[str, str] = {}
        self.resolutions: dict[str, dict[str, Resolution]] = {}
        self._software: dict[str, SoftwareEffect] = {}

    def setup(self, element, lights):
        res = {lt.entity_id: self.library.resolve(self.key, lt, self.allow_close) for lt in lights}
        self.resolutions[element] = res
        if res and all(r.is_native for r in res.values()):
            self.methods[element] = "native"
        elif self.software and self.allow_software:
            self.methods[element] = "software"
            look = Look(self.color, self.brightness)
            self._software[element] = SoftwareEffect(
                self.software, look, self.spec, f"{self.seed}:{element}"
            )
        else:
            self.methods[element] = "static"

    def content(self, element, t, below):
        method = self.methods.get(element, "static")
        if method == "native":
            return Span(Look(self.color, self.brightness, effect=self.key), t)
        if method == "software":
            return self._software[element].span(t, below)
        return Span(Look(self.color, self.brightness), t)

    def describe(self):
        return {
            **super().describe(),
            "effect": self.key,
            "resolution": {
                el: {
                    eid: {"method": r.method, "name": r.native_name or r.software}
                    for eid, r in res.items()
                }
                for el, res in self.resolutions.items()
            },
        }


class DipLayer(Layer):
    """Dim to a fraction of each element's own level, hold, and come back to it."""

    kind = "dip"

    def __init__(self, spec, ctx, index):
        super().__init__(spec, ctx, index)
        self.level = _fraction(spec.get("level", 20))
        self.down_s = max(0.0, float(spec.get("fade_s", 0.5)))
        self.hold_s = max(0.0, float(spec.get("hold_s", 3.0)))
        self.up_s = max(0.0, float(spec.get("restore_s", 1.0)))
        if self.duration_s is None:
            self.duration_s = self.down_s + self.hold_s + self.up_s

    def _phase(self, t: float) -> tuple[float, float, float]:
        """(factor now, end of this phase, factor at its end)"""
        s, lv = self.start, self.level
        if t < s + self.down_s:
            k = (t - s) / self.down_s
            return 1 + (lv - 1) * k, s + self.down_s, lv
        if t < s + self.down_s + self.hold_s:
            return lv, s + self.down_s + self.hold_s, lv
        up_start = s + self.down_s + self.hold_s
        if self.up_s <= 0:
            return 1.0, self.end, 1.0
        k = min(1.0, (t - up_start) / self.up_s)
        return lv + (1 - lv) * k, up_start + self.up_s, 1.0

    def content(self, element, t, below):
        factor, end, factor_end = self._phase(t)
        until = min(end, below.until)
        if until > t and end > t:
            factor_until = factor + (factor_end - factor) * (until - t) / (end - t)
        else:
            factor_until = factor_end
        look = below.at(t).scaled(factor)
        to = below.at(until).scaled(factor_until)
        if to == look and below.to is None:
            return Span(look, t, until, busy=below.busy, crisp=below.crisp)
        return Span(look, t, until, to=to, busy=below.busy)

    def describe(self):
        return {**super().describe(), "level": self.level}


class FlashLayer(Layer):
    """Flash a colour `count` times (at most 3 per second), dark in between, then back to
    whatever is below."""

    kind = "flash"

    def __init__(self, spec, ctx, index):
        super().__init__(spec, ctx, index)
        self.look = Look(
            parse_color(spec.get("color", "white")), _fraction(spec.get("brightness", 100))
        )
        self.count = max(1, int(spec.get("count", 1)))
        self.on_s = max(0.05, float(spec.get("on_s", 0.3)))
        off = max(0.05, float(spec.get("off_s", 0.3)))
        self.off_s = max(off, 1 / MAX_FLASH_HZ - self.on_s)
        if self.duration_s is None:
            self.duration_s = self.count * self.on_s + (self.count - 1) * self.off_s

    def content(self, element, t, below):
        period = self.on_s + self.off_s
        n = math.floor((t - self.start) / period)
        phase_start = self.start + n * period
        if t < phase_start + self.on_s:
            return Span(self.look, t, phase_start + self.on_s, crisp=True)
        return Span(OFF, t, phase_start + period, crisp=True)


class SweepLayer(Layer):
    """Colour that travels across the house, by where each light is on the house map.

    - `wipe`: each pass paints the next colour from one end to the other, blending over `soft_s`
    - `band`: a band of colour `width` wide (a fraction of the run) moves over a dim glow
    `axis` is x (across the front), y (from the street back) or z (up); `direction` is forward,
    reverse or bounce; `period_s` is one pass. Elements need a position (the engine leaves out
    the ones that have none); a WLED light whose LEDs are placed is streamed LED by LED.
    """

    kind = "sweep"
    colour = True
    BAND_STEP_S = 0.2

    def __init__(self, spec, ctx, index):
        super().__init__(spec, ctx, index)
        ref = spec.get("palette")
        if ref:
            if ref not in ctx.palettes:
                raise LayerError(f"unknown palette {ref!r}")
            colors = [c for c, _ in ctx.palettes[ref].colors]
        else:
            colors = [parse_color(c) for c in spec.get("colors", ["#7a1fff", "#ff4500"]) or []]
        if not colors:
            raise LayerError("a sweep needs at least one colour")
        self.colors = colors
        self.mode = str(spec.get("mode", "wipe"))
        if self.mode not in ("wipe", "band"):
            raise LayerError("sweep mode must be wipe or band")
        self.axis = str(spec.get("axis", "x"))
        if self.axis not in ("x", "y", "z"):
            raise LayerError("sweep axis must be x, y or z")
        self.direction = str(spec.get("direction", "forward"))
        if self.direction not in ("forward", "reverse", "bounce"):
            raise LayerError("sweep direction must be forward, reverse or bounce")
        self.period_s = min(600.0, max(1.0, float(spec.get("period_s", 8))))
        self.width = min(1.0, max(0.05, float(spec.get("width", 0.25))))
        self.soft_s = min(self.period_s * 0.9, max(0.0, float(spec.get("soft_s", 1.5))))
        self.brightness = _fraction(spec.get("brightness", 100))
        self.glow = _fraction(spec.get("glow", 12))  # the band's background, % of brightness
        self.position = ctx.position
        self.values: dict[str, float] = {}  # element -> its place along the axis (m)
        self.extra: list[float] = []  # LED positions that widen the run
        self.streamed: dict[str, tuple[Any, list[float | None]]] = {}  # element -> (light, LEDs)
        self.carriers: set[str] = set()  # WLED main lights: held on at full brightness

    def default_fade_in(self) -> float:
        return 1.5

    def setup(self, element, lights):
        p = self.position(element) if self.position else None
        if p is not None:
            self.values[element] = float(p[self.axis])

    def stream(self, element: str, light: Any, leds: list[dict | None]) -> None:
        """Drive this element LED by LED (positions as {x, y, z}, None for unplaced LEDs)."""
        vals = [None if p is None else float(p[self.axis]) for p in leds]
        self.streamed[element] = (light, vals)
        self.extra.extend(v for v in vals if v is not None)

    def u(self, value: float) -> float:
        all_values = [*self.values.values(), *self.extra]
        lo, hi = min(all_values), max(all_values)
        return 0.5 if hi - lo < 1e-6 else (value - lo) / (hi - lo)

    def _forward(self, n: int) -> bool:
        if self.direction == "bounce":
            return n % 2 == 0
        return self.direction == "forward"

    def _look(self, n: int) -> Look:
        return Look(self.colors[n % len(self.colors)], self.brightness)

    # wipe: pass n reaches a spot at start + (n + where) * period, blending in over soft_s
    def _window(self, n: int, u: float) -> tuple[float, float]:
        where = u if self._forward(n) else 1 - u
        end = self.start + (n + where) * self.period_s
        return end - self.soft_s, end

    def _wipe(self, u: float, t: float) -> Span:
        n = math.floor((t - self.start) / self.period_s)
        for m in (n + 1, n, n - 1):
            hb, he = self._window(m, u)
            if hb <= t < he:
                k = (t - hb) / (he - hb)
                return Span(self._look(m - 1).mix(self._look(m), k), t, he, to=self._look(m))
            if t >= he:
                nxt = self._window(m + 1, u)[0]
                return Span(self._look(m), t, max(t + 0.05, nxt))
        return Span(self._look(-1), t, max(t + 0.05, self._window(0, u)[0]))

    def _band(self, u: float, t: float) -> Look:
        T = (t - self.start) / self.period_s
        n = math.floor(T)
        f = T - n
        w = self.width
        centre = -w + f * (1 + 2 * w)
        if not self._forward(n):
            centre = 1 - centre
        k = max(0.0, 1 - abs(u - centre) / w)
        k = 0.5 - 0.5 * math.cos(math.pi * k)  # soft edges
        fg = self._look(n)
        return fg.scaled(self.glow).mix(fg, k)

    def sample(self, value: float, t: float) -> Look:
        u = self.u(value)
        return self._wipe(u, t).look if self.mode == "wipe" else self._band(u, t)

    def content(self, element, t, below):
        if element in self.carriers:
            return Span(Look(self.colors[0], self.brightness), t)
        value = self.values.get(element)
        if value is None:
            return Span(below.at(t), t, below.until)
        u = self.u(value)
        if self.mode == "wipe":
            return self._wipe(u, t)
        step = self.BAND_STEP_S
        return Span(self._band(u, t), t, t + step, to=self._band(u, t + step), busy=True)

    def frame(self, element: str, t: float) -> list[tuple[int, int, int]]:
        """One frame for a streamed element: an RGB value per LED."""
        light, vals = self.streamed[element]
        fallback = self.values.get(element)
        out = []
        for v in vals:
            v = fallback if v is None else v
            look = OFF if v is None else self.sample(v, t)
            if self.active(t) and t < self.start + self.fade_in_s:
                look = look.scaled((t - self.start) / self.fade_in_s)
            c = look.color
            b = 0.0 if look.color.is_black else look.brightness
            out.append(tuple(round(255 * ch * b) for ch in (c.r, c.g, c.b)))
        return out

    def describe(self):
        return {**super().describe(), "mode": self.mode, "axis": self.axis}


LAYER_TYPES: dict[str, type[Layer]] = {
    cls.kind: cls
    for cls in (
        StaticLayer,
        PaletteLayer,
        SoftwareEffectLayer,
        NativeEffectLayer,
        DipLayer,
        FlashLayer,
        SweepLayer,
    )
}


def build_layer(spec: dict, ctx: LayerContext, index: int) -> Layer:
    kind = spec.get("type")
    cls = LAYER_TYPES.get(str(kind))
    if cls is None:
        raise LayerError(f"unknown layer type {kind!r}; one of {', '.join(LAYER_TYPES)}")
    try:
        return cls(spec, ctx, index)
    except LayerError:
        raise
    except (TypeError, ValueError, KeyError) as err:
        raise LayerError(f"{kind} layer: {err}") from err


def _fraction(percent: Any) -> float:
    """A percent (0-100) as 0-1."""
    return min(1.0, max(0.0, float(percent) / 100))
