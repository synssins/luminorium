"""The show engine: running shows, the 20 Hz tick, and handing lights back.

A running show is a set of layers, each on a set of elements (a light, or a fixture whose lights
all get the same look). Every tick the engine composes, for each light it holds, the layers that
cover it (by priority, each seeing the one below), and the planner turns that into commands that
go out through Safety (snapshots, outside changes) and the Governor (rates).

All shows share one Safety session, `engine`, so shows can overlap on a light: the higher
priority wins and the lower one shows again when it ends. A light is handed back when no running
show covers it any more, as the show that last had it says (`on_end`): `restore` (the default)
puts back what was there before, `fade` does the same as a fade over `fade_s`, `hold` leaves the
light as it is.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from ..drivers.base import LightState
from ..inventory.model import Inventory, Kind, Light
from ..inventory.service import InventoryService
from .color import look_from_state, perceptible
from .effects import EffectLibrary
from .governor import Priority
from .layers import INF, Layer, LayerContext, LayerError, Palette, Span, build_layer
from .planner import Command, Planner
from .safety import LightBusy, Safety

log = logging.getLogger(__name__)

TICK_HZ = 20.0
SESSION = "engine"
ON_END = ("restore", "fade", "hold")


class ShowError(ValueError):
    """A show or its targets can't be played as given."""


@dataclass
class Element:
    id: str
    name: str
    members: list[str]


def resolve_targets(inv: Inventory, targets: dict | None) -> dict[str, Element]:
    """Targets (`all`, `floors`, `areas`, `fixtures`, `lights`, `exclude`) → elements. A light in a
    fixture brings its whole fixture. Only included, available lights are used."""
    if not targets:
        raise ShowError("no targets given")
    unknown: list[str] = []
    chosen: set[str] = set()
    drivable = {lt.entity_id: lt for lt in inv.drivable()}

    def pick(pred: Callable[[Light], bool]) -> None:
        chosen.update(eid for eid, lt in drivable.items() if pred(lt))

    if targets.get("all"):
        pick(lambda lt: True)
    for floor in _list(targets.get("floors")):
        if floor not in inv.floors:
            unknown.append(f"floor {floor}")
        pick(lambda lt, f=floor: lt.floor_id == f)
    for area in _list(targets.get("areas")):
        if area not in inv.areas:
            unknown.append(f"area {area}")
        pick(lambda lt, a=area: lt.area_id == a)
    for fixture_id in _list(targets.get("fixtures")):
        fixture = inv.fixtures.get(fixture_id)
        if fixture is None:
            unknown.append(f"fixture {fixture_id}")
            continue
        chosen.update(m for m in fixture.members if m in drivable)
    for eid in _list(targets.get("lights")):
        light = inv.get(eid)
        if light is None or light.kind not in (Kind.LIGHT, Kind.SWITCH):
            unknown.append(f"light {eid}")
        elif eid not in drivable:
            raise ShowError(f"{light.name} is excluded")
        else:
            chosen.add(eid)
    if unknown:
        raise ShowError("unknown " + ", ".join(unknown))
    chosen -= set(_list(targets.get("exclude")))

    elements: dict[str, Element] = {}
    for eid in sorted(chosen):
        light = drivable[eid]
        if not light.available:
            continue
        fixture = inv.fixtures.get(light.fixture) if light.fixture else None
        if fixture is not None:
            members = [m for m in fixture.members if m in drivable and drivable[m].available]
            elements[fixture.id] = Element(fixture.id, fixture.name, members)
        else:
            elements[eid] = Element(eid, light.name, [eid])
    return elements


def _list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value]


@dataclass
class RunningShow:
    id: str
    name: str
    kind: str  # palette | show
    source: str | None  # palette or show id
    seed: str
    priority: int
    on_end: str
    fade_s: float
    started: float
    ends: float
    started_at: float  # wall clock, for the API
    layers: list[Layer]
    elements: list[dict[str, Element]]  # per layer
    # entity_id -> [(layer, element id)], in composition order
    stack: dict[str, list[tuple[Layer, str]]] = field(default_factory=dict)
    order: int = 0

    @property
    def lights(self) -> set[str]:
        return set(self.stack)

    def to_dict(self, now: float) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "source": self.source,
            "seed": self.seed,
            "priority": self.priority,
            "on_end": self.on_end,
            "started_at": self.started_at,
            "elapsed_s": round(now - self.started, 1),
            "remaining_s": None if self.ends == INF else round(max(0.0, self.ends - now), 1),
            "lights": sorted(self.lights),
            "layers": [
                {**layer.describe(), "elements": sorted(els)}
                for layer, els in zip(self.layers, self.elements, strict=True)
            ],
        }


class Engine:
    def __init__(
        self,
        inventory: InventoryService,
        safety: Safety,
        effects: EffectLibrary,
        palettes: Callable[[], dict[str, Palette]],
        clock: Callable[[], float] = time.monotonic,
        tick_hz: float = TICK_HZ,
    ):
        self.inventory = inventory
        self.safety = safety
        self.effects = effects
        self.palettes = palettes
        self.clock = clock
        self.tick_s = 1.0 / tick_hz
        self.planner = Planner(effects.native_name)
        self.shows: dict[str, RunningShow] = {}
        self.base: dict[str, LightState] = {}  # each held light's state before the engine
        self._last_owner: dict[str, RunningShow] = {}
        self._releasing: dict[str, asyncio.Task] = {}
        self._loop_task: asyncio.Task | None = None
        self._order = 0
        self.commands_sent = 0

    @property
    def session(self):
        return self.safety.session(SESSION)

    # ---- play and stop -------------------------------------------------------------------------

    async def play(
        self,
        spec: dict,
        *,
        kind: str = "show",
        source: str | None = None,
        targets: dict | None = None,
    ) -> RunningShow:
        """Start a show from its spec (see docs/engine.md). `targets` replaces the show's own."""
        on_end = str(spec.get("on_end", "restore"))
        if on_end not in ON_END:
            raise ShowError(f"on_end must be one of {', '.join(ON_END)}")
        layer_specs = spec.get("layers") or []
        if not layer_specs:
            raise ShowError("a show needs at least one layer")
        seed = str(spec.get("seed") or random.randrange(1, 10**9))
        ctx = LayerContext(self.effects, self.palettes(), seed)
        try:
            layers = [build_layer(dict(ls), ctx, i) for i, ls in enumerate(layer_specs)]
        except LayerError as err:
            raise ShowError(str(err)) from err

        inv = self.inventory.inventory
        show_targets = targets or spec.get("targets")
        elements: list[dict[str, Element]] = []
        for layer in layers:
            layer_targets = (layer.targets if not targets else None) or show_targets
            elements.append(resolve_targets(inv, layer_targets))

        # Colour palettes leave white-only lights alone (they'd just glow white) unless asked
        if not (spec.get("include_white") or (show_targets or {}).get("include_white")):
            for layer, els in zip(layers, elements, strict=True):
                if layer.kind != "palette":
                    continue
                for el in list(els.values()):
                    el.members = [m for m in el.members if not inv.lights[m].white_only]
                    if not el.members:
                        del els[el.id]

        # Lights another session (a test) is using are left out
        busy = {eid for eid, snap in self.safety.snapshots.items() if snap.session != SESSION}
        for els in elements:
            for el in list(els.values()):
                el.members = [m for m in el.members if m not in busy]
                if not el.members:
                    del els[el.id]
        if not any(elements):
            raise ShowError("none of the target lights can be used now")

        # A light being handed back from an earlier show finishes that first
        claimed = {m for els in elements for el in els.values() for m in el.members}
        pending = [self._releasing[e] for e in claimed if e in self._releasing]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        now = self.clock()
        run_id = f"{kind}-{uuid.uuid4().hex[:6]}"
        name = str(spec.get("name") or source or run_id)
        self._order += 1
        show = RunningShow(
            id=run_id,
            name=name,
            kind=kind,
            source=source,
            seed=seed,
            priority=int(spec.get("priority", 0)),
            on_end=on_end,
            fade_s=max(0.0, float(spec.get("fade_s", 2.0))),
            started=now,
            ends=INF,
            started_at=time.time(),
            layers=layers,
            elements=elements,
            order=self._order,
        )
        for layer, els in zip(layers, elements, strict=True):
            layer.bind(now)
            for el in els.values():
                layer.setup(el.id, [inv.lights[m] for m in el.members])
                for m in el.members:
                    show.stack.setdefault(m, []).append((layer, el.id))
        for entries in show.stack.values():
            entries.sort(key=lambda e: (e[0].priority, e[0].index))
        duration = spec.get("duration_s")
        if duration is not None:
            show.ends = now + float(duration)
        elif all(layer.end != INF for layer in layers):
            show.ends = max(layer.end for layer in layers)

        session = self.session
        for eid in show.lights:
            session.dropped.discard(eid)
            if eid not in self.base:
                light = inv.lights[eid]
                self.base[eid] = LightState.from_ha(light.state, light.attributes)
                self.planner.seed(eid, self.base[eid])
        self.shows[run_id] = show
        self.safety.note(f"Playing {name} on {len(show.lights)} light(s)", show=run_id)
        self._ensure_loop()
        return show

    async def stop(self, run_id: str, on_end: str | None = None) -> bool:
        show = self.shows.get(run_id)
        if show is None:
            return False
        if on_end is not None:
            if on_end not in ON_END:
                raise ShowError(f"on_end must be one of {', '.join(ON_END)}")
            show.on_end = on_end
        self._finish(show, "stopped")
        tasks = [t for t in self._releasing.values()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return True

    async def stop_shows(self) -> int:
        count = len(self.shows)
        for show in list(self.shows.values()):
            self._finish(show, "stopped")
        tasks = list(self._releasing.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return count

    def running(self) -> list[dict]:
        now = self.clock()
        return [s.to_dict(now) for s in sorted(self.shows.values(), key=lambda s: s.order)]

    # ---- the tick ------------------------------------------------------------------------------

    def _ensure_loop(self) -> None:
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = self.session.run(self._loop())

    async def _loop(self) -> None:
        try:
            next_tick = self.clock()
            while self.shows:
                try:
                    self.tick(self.clock())
                except Exception:
                    log.exception("Engine tick failed")
                next_tick += self.tick_s
                delay = next_tick - self.clock()
                if delay < -1.0:  # fell far behind (a stalled loop): don't try to catch up
                    next_tick = self.clock()
                await asyncio.sleep(max(0.0, delay))
        except asyncio.CancelledError:
            # Stop all: Safety restores every light itself; forget everything here
            self.shows.clear()
            self.base.clear()
            self._last_owner.clear()
            self.planner = Planner(self.effects.native_name, self.planner.budgets)
            raise
        finally:
            self._loop_task = None

    def tick(self, now: float) -> list[Command]:
        self._drop_outside_changes()
        for show in list(self.shows.values()):
            if now >= show.ends:
                self._finish(show, "finished")
        if not self.shows:
            return []

        inv = self.inventory.inventory
        stacks: dict[str, list[tuple[Layer, str, RunningShow]]] = {}
        for show in sorted(self.shows.values(), key=lambda s: (s.priority, s.order)):
            for eid, entries in show.stack.items():
                stacks.setdefault(eid, []).extend((layer, el, show) for layer, el in entries)

        items = []
        for eid, stack in stacks.items():
            light = inv.get(eid)
            if light is None or not light.available or eid in self._releasing:
                continue
            if eid not in self.safety.snapshots and not self.planner.has_sent(eid):
                # Not touched yet: follow what the light does until then
                self.base[eid] = LightState.from_ha(light.state, light.attributes)
                self.planner.seed(eid, self.base[eid])
            for _, _, show in stack:
                self._last_owner[eid] = show
            items.append((light, self._composer(eid, stack)))

        commands = self.planner.plan(now, items)
        for cmd in commands:
            light = inv.get(cmd.entity_id)
            if light is not None:
                self.session.run(self._send(light, cmd))
        return commands

    def _composer(self, eid: str, stack: list[tuple[Layer, str, RunningShow]]):
        base_look = look_from_state(self.base.get(eid) or LightState(on=False))
        ordered = sorted(
            stack, key=lambda e: (e[2].priority, e[0].priority, e[2].order, e[0].index)
        )

        def span_at(t: float) -> Span:
            span = Span(base_look, t)
            next_start = INF
            for layer, element, _ in ordered:
                if layer.active(t):
                    span = layer.span(element, t, span)
                elif layer.start > t:
                    next_start = min(next_start, layer.start)
            return span.clip(next_start) if next_start < span.until else span

        return span_at

    async def _send(self, light: Light, cmd: Command) -> None:
        try:
            await self.safety.command(
                self.session,
                light,
                cmd.state,
                transition_ms=cmd.transition_ms,
                priority=Priority.SHOW,
            )
            self.commands_sent += 1
        except LightBusy as err:
            self._drop(light.entity_id, str(err))
        except asyncio.CancelledError:
            raise
        except Exception as err:
            log.warning("Command to %s failed: %s", light.entity_id, err)

    # ---- ending and handing back --------------------------------------------------------------

    def _finish(self, show: RunningShow, why: str) -> None:
        if self.shows.pop(show.id, None) is None:
            return
        still = {eid for s in self.shows.values() for eid in s.lights}
        for eid in show.lights - still:
            self._hand_back(eid, show)
        self.safety.note(f"{show.name} {why}", show=show.id)

    def _hand_back(self, eid: str, show: RunningShow) -> None:
        owner = self._last_owner.pop(eid, show)
        last = self.planner.last(eid)
        self.planner.forget(eid)
        self.base.pop(eid, None)
        snap = self.safety.snapshots.get(eid)
        if snap is None or snap.session != SESSION:
            return  # never commanded, or dropped after an outside change
        restore = owner.on_end != "hold"
        if restore and last is not None and not perceptible(last, snap.state):
            restore = False  # already back where it was (a dip ends at the light's own level)
        transition = round(owner.fade_s * 1000) if owner.on_end == "fade" else None

        async def release() -> None:
            try:
                await self.safety.release(
                    self.session, [eid], restore=restore, transition_ms=transition
                )
            finally:
                self._releasing.pop(eid, None)

        self._releasing[eid] = self.session.run(release())

    def _drop_outside_changes(self) -> None:
        session = self.safety.sessions.get(SESSION)
        if session is None:
            return
        for eid in list(session.dropped):
            if any(eid in s.stack for s in self.shows.values()):
                self._drop(eid, "changed outside Luminorium")

    def _drop(self, eid: str, why: str) -> None:
        for show in list(self.shows.values()):
            if show.stack.pop(eid, None) is not None:
                for els in show.elements:
                    for el in list(els.values()):
                        if eid in el.members:
                            el.members.remove(eid)
                        if not el.members:
                            del els[el.id]
                if not show.stack:
                    self.shows.pop(show.id, None)
                    self.safety.note(f"{show.name} ended: no lights left", show=show.id)
        self.planner.forget(eid)
        self.base.pop(eid, None)
        self._last_owner.pop(eid, None)
        log.info("%s dropped from shows: %s", eid, why)

    async def close(self) -> None:
        if self._loop_task is not None:
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
