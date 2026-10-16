"""The planner: turns what each light should show into as few governed commands as possible.

Every tick, for each light that may send again (its own rate, and its network's budget):

- **Latency compensation:** layers are sampled at `now + latency`, so a 650 ms Z-Wave dimmer is
  sent its change 650 ms before a 30 ms WLED strip gets the same moment, and both land together.
- **Fades:** where the content is a straight fade (a palette moving to its next colour, a dip
  going down) and the light can do transitions, the light is sent the fade's end with the fade's
  remaining time: one command per fade, however long.
- **Steps:** a light without transitions follows a fade in steps at its own rate.
- **Busy content** (software effects): fast lights are sent samples (crisp for flicker and
  lightning); slow lights (an interval of a second or more: Z-Wave, Govee cloud, relays) get the
  average over their interval as one fade, so they glow along instead of lagging.
- **Threshold:** nothing is sent when the change would not be visible (`color.perceptible`).
- **Budgets:** a network's commands are spread over its budget (Z-Wave 2/s for the whole mesh),
  the stalest lights first, so the governor never has to queue.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from ..drivers.base import LightState
from ..inventory.model import Light
from .color import EffectNamer, average, perceptible, render
from .governor import HA_DRIVER_BUDGET, NETWORK_BUDGETS
from .layers import INF, Span

SpanFn = Callable[[float], Span]

# A light that can send less often than this is "slow": busy content is averaged for it
SLOW_INTERVAL_S = 1.0
LOWPASS_SAMPLES = 8
MIN_INTERVAL_S = 0.05
MAX_TRANSITION_S = 3600.0
# The planner keeps a little under the governor's budgets so the governor never queues
BUDGET_SHARE = 0.9


class Budget:
    """A token bucket driven by the caller's clock; it never waits."""

    def __init__(self, rate: float, burst: float):
        self.rate = rate
        self.capacity = float(burst)
        self.tokens = float(burst)
        self.updated: float | None = None

    def _refill(self, now: float) -> None:
        if self.updated is not None:
            self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now

    def available(self, now: float) -> bool:
        self._refill(now)
        return self.tokens >= 1

    def take(self, now: float) -> None:
        self._refill(now)
        self.tokens -= 1


def default_budgets() -> dict[str, Budget]:
    budgets = {
        name: Budget(rate * BUDGET_SHARE, burst) for name, (rate, burst) in NETWORK_BUDGETS.items()
    }
    budgets["_ha"] = Budget(HA_DRIVER_BUDGET[0] * BUDGET_SHARE, HA_DRIVER_BUDGET[1])
    return budgets


@dataclass
class Command:
    entity_id: str
    state: LightState
    transition_ms: int | None
    reason: str  # fade | step | sample | lowpass | hold
    at: float


@dataclass
class _Track:
    last: LightState | None = None  # what the light shows, or is fading to
    sent_at: float = -INF
    sent: int = 0


@dataclass
class _Candidate:
    light: Light
    command: Command
    urgent: bool
    stale: float
    budgets: list[Budget] = field(default_factory=list)


def interval_of(light: Light) -> float:
    profile = light.profile
    if profile is None or not profile.max_rate_hz:
        return 0.5
    return max(MIN_INTERVAL_S, 1.0 / profile.max_rate_hz)


def latency_of(light: Light) -> float:
    return (light.profile.latency_ms if light.profile else 250) / 1000


def fades_natively(light: Light) -> bool:
    profile = light.profile
    return profile is not None and not profile.relay and profile.capabilities.transition == "native"


class Planner:
    def __init__(
        self, effect_name: EffectNamer | None = None, budgets: dict[str, Budget] | None = None
    ):
        self.effect_name = effect_name
        self.budgets = budgets if budgets is not None else default_budgets()
        self._tracks: dict[str, _Track] = {}
        self.sent = 0
        self.skipped = 0  # changes too small to see

    # ---- per-light state ---------------------------------------------------------------------

    def seed(self, entity_id: str, state: LightState) -> None:
        """What the light shows now, before the planner sends anything."""
        track = self._tracks.setdefault(entity_id, _Track())
        if track.sent == 0:
            track.last = state

    def forget(self, entity_id: str) -> None:
        self._tracks.pop(entity_id, None)

    def last(self, entity_id: str) -> LightState | None:
        track = self._tracks.get(entity_id)
        return track.last if track else None

    def has_sent(self, entity_id: str) -> bool:
        track = self._tracks.get(entity_id)
        return bool(track and track.sent)

    # ---- planning ----------------------------------------------------------------------------

    def desired(self, light: Light, span_at: SpanFn, now: float) -> Command:
        """What this light should be sent now, ignoring whether it may send."""
        interval = interval_of(light)
        t0 = now + latency_of(light)
        span = span_at(t0)
        native = fades_natively(light)
        transition: float | None
        if not span.busy:
            if span.to is not None and span.until > t0 and span.until != INF:
                remaining = span.until - t0
                if native:
                    look, transition, reason = span.to, remaining, "fade"
                else:
                    look = span.at(t0 + min(interval, remaining) / 2)
                    transition, reason = None, "step"
            else:
                look, reason = span.look, "hold"
                transition = 0.0 if span.crisp and native else None
        elif interval >= SLOW_INTERVAL_S:
            samples = [
                span_at(t0 + interval * (i + 0.5) / LOWPASS_SAMPLES).look
                for i in range(LOWPASS_SAMPLES)
            ]
            look, reason = average(samples), "lowpass"
            transition = interval if native else None
        else:
            look, reason = span.look, "sample"
            transition = (0.0 if span.crisp else interval) if native else None
        state = render(look, light, self.effect_name)
        ms = None if transition is None else round(min(transition, MAX_TRANSITION_S) * 1000)
        return Command(light.entity_id, state, ms, reason, now)

    def plan(self, now: float, items: list[tuple[Light, SpanFn]]) -> list[Command]:
        candidates: list[_Candidate] = []
        for light, span_at in items:
            track = self._tracks.setdefault(light.entity_id, _Track())
            if now - track.sent_at < interval_of(light) - 1e-6:
                continue
            command = self.desired(light, span_at, now)
            if not perceptible(track.last, command.state):
                self.skipped += 1
                continue
            last = track.last
            urgent = (
                last is None or last.on != command.state.on or last.effect != command.state.effect
            )
            budgets = []
            network = light.profile.network if light.profile else None
            if network in self.budgets:
                budgets.append(self.budgets[network])
            if (light.profile is None or light.profile.driver == "ha") and "_ha" in self.budgets:
                budgets.append(self.budgets["_ha"])
            candidates.append(_Candidate(light, command, urgent, now - track.sent_at, budgets))

        # On/off and effect changes first, then the lights that waited longest
        candidates.sort(key=lambda c: (not c.urgent, -min(c.stale, 1e9)))
        commands = []
        for c in candidates:
            if not all(b.available(now) for b in c.budgets):
                continue
            for b in c.budgets:
                b.take(now)
            track = self._tracks[c.light.entity_id]
            track.last = c.command.state
            track.sent_at = now
            track.sent += 1
            self.sent += 1
            commands.append(c.command)
        return commands
