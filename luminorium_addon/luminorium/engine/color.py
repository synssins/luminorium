"""Colours: one colour type, blending in OKLab, and conversion to what each light can show.

A `Color` is a hue and saturation at full value (sRGB, 0-1, with the largest channel at 1 for
anything but black). How bright a light is lives in `Look.brightness`, so blending colours never
changes brightness and brightness never changes the colour.

`render()` turns a `Look` into the `LightState` a given light can take: xy, hs, rgb, rgbw, rgbww,
a colour temperature for white-only lights (the nearest kelvin in their range), a level for
dimmers, and on or off for relays.
"""

from __future__ import annotations

import colorsys
import math
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from typing import Any

from ..drivers.base import LightState
from ..inventory.model import Light

# A relay is on when the look is at least this bright (0-1)
RELAY_THRESHOLD = 0.3
# Smallest changes worth sending: OKLab distance between colours, and difference in lightness
# (cube root of brightness, so steps count more near dark than near full)
COLOR_STEP = 0.02
LIGHTNESS_STEP = 0.01
NEUTRAL_KELVIN = 4000

# ---- sRGB, XYZ, OKLab -------------------------------------------------------------------------


def _to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _to_gamma(c: float) -> float:
    c = max(0.0, c)
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def _linear_to_xyz(r: float, g: float, b: float) -> tuple[float, float, float]:
    return (
        0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
        0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
        0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
    )


def _xyz_to_linear(x: float, y: float, z: float) -> tuple[float, float, float]:
    return (
        3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
        -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
        0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
    )


def _linear_to_oklab(r: float, g: float, b: float) -> tuple[float, float, float]:
    lms = (
        0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
        0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
        0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
    )
    l_, m_, s_ = (math.copysign(abs(v) ** (1 / 3), v) for v in lms)
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def _oklab_to_linear(lab: tuple[float, float, float]) -> tuple[float, float, float]:
    L, a, b = lab
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    lc, mc, sc = l_**3, m_**3, s_**3
    return (
        4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
        -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
        -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc,
    )


def kelvin_to_xy(kelvin: float) -> tuple[float, float]:
    """Point on the Planckian locus (Kim et al. cubic spline, 1667-25000 K)."""
    t = min(25000.0, max(1667.0, float(kelvin)))
    if t <= 4000:
        x = -0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x**3 - 1.34811020 * x**2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    return x, y


def xy_to_kelvin(x: float, y: float) -> float:
    """Correlated colour temperature (McCamy). Only meaningful near the white locus."""
    n = (x - 0.3320) / (0.1858 - y)
    return 449.0 * n**3 + 3525.0 * n**2 + 6823.3 * n + 5520.33


# ---- Color ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Color:
    """sRGB 0-1 at full value. `kelvin` is set for colours defined as a white temperature, so
    lights with a white channel can show a real white instead of a mix."""

    r: float
    g: float
    b: float
    kelvin: float | None = None

    @classmethod
    def rgb(cls, r: float, g: float, b: float, kelvin: float | None = None) -> Color:
        """From sRGB in 0-1; scaled so the largest channel is 1."""
        r, g, b = (min(1.0, max(0.0, float(c))) for c in (r, g, b))
        top = max(r, g, b)
        if top <= 0:
            return BLACK
        return cls(r / top, g / top, b / top, kelvin)

    @classmethod
    def rgb255(cls, r: float, g: float, b: float) -> Color:
        return cls.rgb(r / 255, g / 255, b / 255)

    @classmethod
    def from_linear(cls, r: float, g: float, b: float, kelvin: float | None = None) -> Color:
        top = max(r, g, b)
        if top <= 0:
            return BLACK
        return cls.rgb(*(_to_gamma(max(0.0, c) / top) for c in (r, g, b)), kelvin=kelvin)

    @classmethod
    def from_xy(cls, x: float, y: float) -> Color:
        y = max(1e-6, y)
        X, Z = x / y, (1 - x - y) / y
        return cls.from_linear(*_xyz_to_linear(X, 1.0, Z))

    @classmethod
    def from_kelvin(cls, kelvin: float) -> Color:
        x, y = kelvin_to_xy(kelvin)
        base = cls.from_xy(x, y)
        return replace(base, kelvin=float(kelvin))

    @classmethod
    def from_hs(cls, hue: float, saturation: float) -> Color:
        """HA's hs: hue in degrees, saturation in percent."""
        return cls.rgb(*colorsys.hsv_to_rgb((hue % 360) / 360, saturation / 100, 1.0))

    @classmethod
    def from_hex(cls, text: str) -> Color:
        text = text.lstrip("#")
        if len(text) == 3:
            text = "".join(c * 2 for c in text)
        return cls.rgb255(int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))

    @property
    def is_black(self) -> bool:
        return max(self.r, self.g, self.b) <= 0

    @property
    def linear(self) -> tuple[float, float, float]:
        return _to_linear(self.r), _to_linear(self.g), _to_linear(self.b)

    @property
    def oklab(self) -> tuple[float, float, float]:
        return _linear_to_oklab(*self.linear)

    @property
    def xy(self) -> tuple[float, float]:
        if self.kelvin is not None:
            return kelvin_to_xy(self.kelvin)
        X, Y, Z = _linear_to_xyz(*self.linear)
        total = X + Y + Z
        if total <= 0:
            return 0.3127, 0.3290  # D65
        return X / total, Y / total

    @property
    def hs(self) -> tuple[float, float]:
        h, s, _ = colorsys.rgb_to_hsv(self.r, self.g, self.b)
        return h * 360, s * 100

    def cct(self) -> float:
        """The white temperature closest to this colour, for white-only lights."""
        if self.kelvin is not None:
            return self.kelvin
        x, y = self.xy
        kelvin = xy_to_kelvin(x, y) if abs(0.1858 - y) > 1e-6 else NEUTRAL_KELVIN
        if not 1000 <= kelvin <= 20000 or self.hs[1] > 60:
            # Far from white (a red, a green): just warm or cool
            return 2000.0 if self.r >= self.b else 6500.0
        return kelvin

    def mix(self, other: Color, t: float) -> Color:
        """Blend in OKLab: red to green passes through yellow, not brown."""
        t = min(1.0, max(0.0, t))
        if t <= 0:
            return self
        if t >= 1:
            return other
        if self.is_black:
            return other
        if other.is_black:
            return self
        a, b = self.oklab, other.oklab
        lab = tuple(x + (y - x) * t for x, y in zip(a, b, strict=True))
        kelvin = None
        if self.kelvin is not None and other.kelvin is not None:
            # Whites blend along the locus, in mireds
            mired = 1e6 / self.kelvin + (1e6 / other.kelvin - 1e6 / self.kelvin) * t
            kelvin = 1e6 / mired
            return Color.from_kelvin(kelvin)
        return Color.from_linear(*_oklab_to_linear(lab))  # type: ignore[arg-type]

    def distance(self, other: Color) -> float:
        """OKLab distance (about 0.02 is just noticeable)."""
        return math.dist(self.oklab, other.oklab)

    def hex(self) -> str:
        return "#" + "".join(f"{round(c * 255):02x}" for c in (self.r, self.g, self.b))


BLACK = Color(0.0, 0.0, 0.0)
WHITE = Color(1.0, 1.0, 1.0)

NAMED = {
    "red": "#ff0000",
    "green": "#00ff00",
    "blue": "#0000ff",
    "white": "#ffffff",
    "black": "#000000",
    "yellow": "#ffd000",
    "orange": "#ff6a00",
    "amber": "#ffa000",
    "purple": "#8000ff",
    "violet": "#a040ff",
    "magenta": "#ff00ff",
    "pink": "#ff4f9a",
    "cyan": "#00ffff",
    "teal": "#00ffa0",
    "lime": "#a0ff00",
}
NAMED_KELVIN = {"warm_white": 2700, "soft_white": 3000, "neutral_white": 4000, "cool_white": 5500}
_KELVIN_RE = re.compile(r"^(\d{3,5})\s*k$", re.IGNORECASE)


def parse_color(value: Any) -> Color:
    """A colour from YAML or JSON: "#ff8800", "red", "2700K", {xy: [x, y]}, {kelvin: 2700},
    {rgb: [255, 0, 0]}, {hs: [30, 100]} or {hex: "#ff8800"}."""
    if isinstance(value, Color):
        return value
    if isinstance(value, str):
        text = value.strip()
        lower = text.lower().replace(" ", "_")
        if text.startswith("#"):
            return Color.from_hex(text)
        if lower in NAMED:
            return Color.from_hex(NAMED[lower])
        if lower in NAMED_KELVIN:
            return Color.from_kelvin(NAMED_KELVIN[lower])
        match = _KELVIN_RE.match(text)
        if match:
            return Color.from_kelvin(int(match.group(1)))
        raise ValueError(f"unknown colour {value!r}")
    if isinstance(value, dict):
        if "xy" in value:
            x, y = value["xy"]
            return Color.from_xy(float(x), float(y))
        if "kelvin" in value:
            return Color.from_kelvin(float(value["kelvin"]))
        if "rgb" in value:
            r, g, b = value["rgb"]
            return Color.rgb255(r, g, b)
        if "hs" in value:
            h, s = value["hs"]
            return Color.from_hs(float(h), float(s))
        if "hex" in value:
            return Color.from_hex(str(value["hex"]))
        if "color" in value:
            return parse_color(value["color"])
    raise ValueError(f"unknown colour {value!r}")


def color_to_dict(color: Color) -> dict:
    if color.kelvin is not None:
        return {"kelvin": round(color.kelvin)}
    return {"hex": color.hex()}


# ---- Look -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Look:
    """What an element should show: a colour, a brightness (0 is off), and optionally a native
    effect by its normalised name."""

    color: Color = WHITE
    brightness: float = 1.0
    effect: str | None = None
    white_k: float | None = None  # what a white-only light should show instead (palette hint)

    @property
    def on(self) -> bool:
        return self.brightness > 0 and (not self.color.is_black or self.effect is not None)

    @property
    def level(self) -> float:
        """Brightness of the light itself: 0 for black, whatever the brightness says."""
        return 0.0 if self.color.is_black and self.effect is None else self.brightness

    def scaled(self, factor: float) -> Look:
        return replace(self, brightness=max(0.0, min(1.0, self.brightness * factor)))

    def mix(self, other: Look, t: float) -> Look:
        t = min(1.0, max(0.0, t))
        if t <= 0:
            return self
        if t >= 1:
            return other
        # Fading from or to off keeps the colour of the side that is on
        if not self.on:
            color = other.color
        elif not other.on:
            color = self.color
        else:
            color = self.color.mix(other.color, t)
        effect = self.effect if t < 0.5 else other.effect
        white_k = other.white_k if t >= 0.5 or self.white_k is None else self.white_k
        return Look(color, self.level + (other.level - self.level) * t, effect, white_k)


OFF = Look(BLACK, 0.0)


def average(looks: Iterable[Look]) -> Look:
    """The mean of several looks (OKLab, weighted by brightness): what a slow light shows in
    place of content it can't follow."""
    items = list(looks)
    if not items:
        return OFF
    total = sum(lk.level for lk in items)
    brightness = total / len(items)
    if total <= 0:
        return Look(items[-1].color, 0.0)
    lab = [0.0, 0.0, 0.0]
    for lk in items:
        if lk.level <= 0:
            continue
        for i, v in enumerate(lk.color.oklab):
            lab[i] += v * lk.level / total
    effects = [lk.effect for lk in items]
    effect = max(set(effects), key=effects.count)
    kelvins = [lk.color.kelvin for lk in items if lk.level > 0]
    if all(k is not None for k in kelvins):
        mired = sum(1e6 / k for k in kelvins) / len(kelvins)  # type: ignore[operator]
        color = Color.from_kelvin(1e6 / mired)
    else:
        color = Color.from_linear(*_oklab_to_linear(tuple(lab)))  # type: ignore[arg-type]
    return Look(color, brightness, effect, items[-1].white_k)


# ---- rendering to a light ---------------------------------------------------------------------

EffectNamer = Callable[[str, Light], "str | None"]
# Order of preference when a light offers several colour modes
MODE_PREFERENCE = ("xy", "hs", "rgb", "rgbww", "rgbw")


def _byte(level: float) -> int:
    return max(1, min(255, round(level * 255)))


def _clamp_kelvin(kelvin: float, white: tuple[int, int]) -> int:
    lo, hi = white
    return int(round(min(hi, max(lo, kelvin))))


def render(look: Look, light: Light, effect_name: EffectNamer | None = None) -> LightState:
    """The state to send to this light so it shows the look as well as it can."""
    profile = light.profile
    caps = profile.capabilities if profile else None
    level = look.level
    if profile is not None and profile.relay:
        return LightState(on=level >= RELAY_THRESHOLD)
    if level * 255 < 0.5:
        return LightState(on=False)
    if caps is None:
        return LightState(on=True, brightness=_byte(level))
    brightness = _byte(level) if caps.dimming else None

    if look.effect and effect_name is not None:
        native = effect_name(look.effect, light)
        if native:
            return LightState(on=True, brightness=brightness, effect=native)

    color = look.color
    if caps.color_modes:
        if color.kelvin is not None and caps.white:
            return LightState(
                True, brightness, "color_temp", _clamp_kelvin(color.kelvin, caps.white)
            )
        mode = next(m for m in MODE_PREFERENCE + tuple(caps.color_modes) if m in caps.color_modes)
        return LightState(True, brightness, mode, _color_value(color, mode))
    if caps.white:
        kelvin = look.white_k or color.cct()
        return LightState(True, brightness, "color_temp", _clamp_kelvin(kelvin, caps.white))
    if caps.dimming:
        return LightState(True, brightness)
    return LightState(True)


def _color_value(color: Color, mode: str) -> Any:
    if mode == "xy":
        x, y = color.xy
        return [round(x, 4), round(y, 4)]
    if mode == "hs":
        h, s = color.hs
        return [round(h, 1), round(s, 1)]
    r, g, b = (round(c * 255) for c in (color.r, color.g, color.b))
    if mode == "rgb":
        return [r, g, b]
    w = min(r, g, b)
    if mode == "rgbw":
        return [r - w, g - w, b - w, w]
    if mode == "rgbww":
        # Split the white part between the cold and warm channels by the colour's temperature
        kelvin = color.kelvin or (color.cct() if w else NEUTRAL_KELVIN)
        warm = min(1.0, max(0.0, (6500 - kelvin) / (6500 - 2000)))
        return [r - w, g - w, b - w, round(w * (1 - warm)), round(w * warm)]
    raise ValueError(mode)


def look_from_state(state: LightState) -> Look:
    """What a light state looks like: for snapshots (a light's own level) and to compare states."""
    if not state.on:
        return OFF
    level = (state.brightness / 255) if state.brightness is not None else 1.0
    color = WHITE
    value = state.color
    try:
        if state.color_mode == "xy" and value:
            color = Color.from_xy(float(value[0]), float(value[1]))
        elif state.color_mode == "hs" and value:
            color = Color.from_hs(float(value[0]), float(value[1]))
        elif state.color_mode == "rgb" and value:
            color = Color.rgb255(*value[:3])
        elif state.color_mode in ("rgbw", "rgbww") and value:
            w = sum(value[3:]) / max(1, len(value) - 3)
            color = Color.rgb255(*(c + w for c in value[:3]))
        elif state.color_mode == "color_temp" and value:
            color = Color.from_kelvin(float(value))
    except (TypeError, ValueError, IndexError):
        color = WHITE
    return Look(color, level, state.effect)


def perceptible(a: LightState | None, b: LightState) -> bool:
    """Would a light changing from state a to state b look different?"""
    if a is None:
        return True
    if a.on != b.on or a.effect != b.effect:
        return True
    if not b.on:
        return False
    la, lb = look_from_state(a), look_from_state(b)
    if abs(la.brightness ** (1 / 3) - lb.brightness ** (1 / 3)) >= LIGHTNESS_STEP:
        return True
    return la.color.distance(lb.color) >= COLOR_STEP
