"""Colour conversions the direct drivers need (HA does these itself for the HA driver).

The formulas follow HA's `homeassistant.util.color` (Wide RGB D65 for xy).
"""

from __future__ import annotations

import colorsys
import math

from .base import LightState


def xy_to_rgb(x: float, y: float) -> tuple[int, int, int]:
    """CIE xy at full brightness to sRGB, scaled so the largest channel is 255."""
    y = max(y, 1e-6)
    big_y = 1.0
    big_x = (big_y / y) * x
    big_z = (big_y / y) * (1 - x - y)
    r = big_x * 1.656492 - big_y * 0.354851 - big_z * 0.255038
    g = -big_x * 0.707196 + big_y * 1.655397 + big_z * 0.036152
    b = big_x * 0.051713 - big_y * 0.121364 + big_z * 1.011530

    def gamma(c: float) -> float:
        return 12.92 * c if c <= 0.0031308 else (1.0 + 0.055) * c ** (1.0 / 2.4) - 0.055

    r, g, b = (max(0.0, gamma(c)) for c in (r, g, b))
    top = max(r, g, b, 1e-6)
    return round(r / top * 255), round(g / top * 255), round(b / top * 255)


def hs_to_rgb(h: float, s: float) -> tuple[int, int, int]:
    r, g, b = colorsys.hsv_to_rgb(h / 360, s / 100, 1.0)
    return round(r * 255), round(g * 255), round(b * 255)


def kelvin_to_rgb(kelvin: float) -> tuple[int, int, int]:
    """Approximate the colour of white light at a temperature (Tanner Helland's fit)."""
    t = max(1000.0, min(40000.0, kelvin)) / 100
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * (t - 60) ** -0.1332047592
        g = 288.1221695283 * (t - 60) ** -0.0755148492
        b = 255.0

    def clamp(v: float) -> int:
        return max(0, min(255, round(v)))

    return clamp(r), clamp(g), clamp(b)


def state_rgb(state: LightState) -> tuple[int, int, int] | None:
    """The state's colour as RGB, or None when it has no colour (white, or no colour given)."""
    mode, value = state.color_mode, state.color
    if value is None:
        return None
    if mode == "xy":
        return xy_to_rgb(float(value[0]), float(value[1]))
    if mode == "hs":
        return hs_to_rgb(float(value[0]), float(value[1]))
    if mode in ("rgb", "rgbw", "rgbww"):
        return int(value[0]), int(value[1]), int(value[2])
    return None


def state_kelvin(state: LightState) -> int | None:
    if state.color_mode == "color_temp" and state.color is not None:
        return int(state.color)
    return None


def percent(brightness: int, minimum: int = 1) -> int:
    """HA brightness (0-255) as a percentage, at least `minimum`."""
    return max(minimum, min(100, round(brightness * 100 / 255)))
