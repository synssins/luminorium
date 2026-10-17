"""Palettes and shows as YAML: the built-in set shipped with the add-on, and the user's own in
the add-on config folder (`/config/palettes/*.yaml`, `/config/shows/*.yaml`). A user file with
the same id as a built-in one replaces it. Files are read on every request, so edits made in
the folder show up without a restart."""

from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import yaml

from .engine.effects import EffectLibrary
from .engine.layers import LayerContext, LayerError, Palette, build_layer

log = logging.getLogger(__name__)

BUILTIN_PALETTES = Path(__file__).resolve().parent / "data" / "palettes"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class LibraryError(ValueError):
    pass


def check_id(item_id: str) -> str:
    if not isinstance(item_id, str) or not ID_RE.match(item_id):
        raise LibraryError("ids are 1-64 characters: lower-case letters, digits, '_' and '-'")
    return item_id


def _read_dir(directory: Path) -> dict[str, tuple[dict, Path]]:
    out: dict[str, tuple[dict, Path]] = {}
    if not directory.is_dir():
        return out
    for path in sorted(directory.glob("*.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as err:
            log.warning("Skipping %s: %s", path, err)
            continue
        if not isinstance(data, dict):
            log.warning("Skipping %s: not a mapping", path)
            continue
        item_id = str(data.get("id") or path.stem)
        out[item_id] = ({**data, "id": item_id}, path)
    return out


def _write_yaml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class Library:
    def __init__(self, config_dir: Path, builtin_palettes: Path = BUILTIN_PALETTES):
        self.config_dir = config_dir
        self.builtin_palettes = builtin_palettes
        self.palettes_dir = config_dir / "palettes"
        self.shows_dir = config_dir / "shows"
        self.effects_dir = config_dir / "effects"

    def effects(self) -> EffectLibrary:
        return EffectLibrary.load(self.effects_dir)

    # ---- palettes ------------------------------------------------------------------------------

    def _palette_sources(self) -> dict[str, tuple[dict, str]]:
        merged = {pid: (d, "builtin") for pid, (d, _) in _read_dir(self.builtin_palettes).items()}
        merged.update({pid: (d, "user") for pid, (d, _) in _read_dir(self.palettes_dir).items()})
        return merged

    def palettes(self) -> dict[str, Palette]:
        out = {}
        for pid, (data, _) in self._palette_sources().items():
            try:
                out[pid] = Palette.from_dict(data, pid)
            except (LayerError, ValueError, TypeError) as err:
                log.warning("Skipping palette %s: %s", pid, err)
        return out

    def palette_list(self) -> list[dict]:
        sources = self._palette_sources()
        return [
            {**p.to_dict(), "source": sources[pid][1]}
            for pid, p in sorted(self.palettes().items(), key=lambda kv: kv[1].name.lower())
        ]

    def save_palette(self, palette_id: str, data: dict[str, Any]) -> Palette:
        check_id(palette_id)
        try:
            palette = Palette.from_dict({**data, "id": palette_id})
        except (LayerError, ValueError, TypeError) as err:
            raise LibraryError(str(err)) from err
        _write_yaml(self.palettes_dir / f"{palette_id}.yaml", palette.to_dict())
        return palette

    def delete_palette(self, palette_id: str) -> None:
        """Delete the user's palette (a built-in one it replaced shows again)."""
        check_id(palette_id)
        found = _read_dir(self.palettes_dir).get(palette_id)
        if found is None:
            raise KeyError(palette_id)
        found[1].unlink()

    # ---- shows ---------------------------------------------------------------------------------

    def shows(self) -> dict[str, dict]:
        return {sid: data for sid, (data, _) in _read_dir(self.shows_dir).items()}

    def show(self, show_id: str) -> dict:
        check_id(show_id)
        shows = self.shows()
        if show_id not in shows:
            raise KeyError(show_id)
        return shows[show_id]

    def save_show(self, show_id: str, data: dict[str, Any]) -> dict:
        check_id(show_id)
        show = {**data, "id": show_id}
        self.check_show(show)
        _write_yaml(self.shows_dir / f"{show_id}.yaml", show)
        return show

    def delete_show(self, show_id: str) -> None:
        check_id(show_id)
        found = _read_dir(self.shows_dir).get(show_id)
        if found is None:
            raise KeyError(show_id)
        found[1].unlink()

    def check_show(self, show: dict) -> None:
        """Layers must build. Targets are checked when the show plays (lights come and go, and a
        show without targets is played on targets given then)."""
        layers = show.get("layers")
        if not isinstance(layers, list) or not layers:
            raise LibraryError("a show needs at least one layer")
        ctx = LayerContext(self.effects(), self.palettes(), "check")
        for i, spec in enumerate(layers):
            if not isinstance(spec, dict):
                raise LibraryError(f"layer {i + 1} is not a mapping")
            try:
                build_layer(spec, ctx, i)
            except LayerError as err:
                raise LibraryError(f"layer {i + 1}: {err}") from err
