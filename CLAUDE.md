# Luminorium: notes for Claude sessions

Read [README.md](README.md) first, then the doc for the area you're working in (`docs/`).
[BRIEF.md](BRIEF.md) has the phases; [DESIGN.md](DESIGN.md) the target design; [SPIKES.md](SPIKES.md)
the facts about this house.

## Ground rules

- HA is at `http://192.168.1.104:8123`. The admin token is in `F:\Projects\Sonorium\ha.tok.txt`.
  **Never print it or put it in files, logs or commits.** Use `ha_sup.mjs` (`node ha_sup.mjs ws
  '{"type":"..."}'` or `node ha_sup.mjs GET /addons`) for HA calls; in Git Bash set
  `MSYS_NO_PATHCONV=1`.
- Reading HA's registries and states is fine.
- **Ask Chris first** before: flashing, toggling or running anything on real lights; touching any
  `switch.*` entity; installing or changing anything in HA; creating GitHub repositories.
- PC runs against the real HA are read-only (`tools/dev.py --real`).
- Plugins are Python only. Develop and test on Windows with the fake HA.

## Commands

```bash
.venv/Scripts/python -m pytest
.venv/Scripts/ruff check . && .venv/Scripts/ruff format --check .
.venv/Scripts/python tools/dev.py
```

## House facts that matter

- The front porch, entryway and driveway Z-Wave switches are locked-on relays that feed Hue bulbs.
  They are excluded; the Hue bulbs are the lights.
- The five GE 12724 dimmers use Multilevel Switch v1 (no transition).
- govee2mqtt reaches every Govee device through the cloud today; segments are cloud-only.
- Mapping is a guided capture (centre, 45° left, 45° right); there is no real video to work from.

## Releasing

Bump `version` in `luminorium_addon/config.yaml` and `luminorium/__init__.py` together for every
build, and add a `CHANGELOG.md` entry. Never use a digest in `build_from`. See
[docs/deployment.md](docs/deployment.md).
