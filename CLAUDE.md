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
- Plugins are Python only. Develop and test on Windows with the fake HA and the fake devices
  (`tools/fake_*.py`). Tests must never reach the LAN: direct drivers are off unless a test
  enables one and points it at a fake.
- On Windows, read and write text files with an explicit `encoding="utf-8"` in Python scripts
  (the default is cp1252 and corrupts non-ASCII text).

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
- govee2mqtt reaches every Govee device through the cloud today; segments are cloud-only. The
  Govee LAN driver needs LAN Control on in the Govee app, and port 4002 free.
- The direct drivers ([docs/drivers.md](docs/drivers.md)) were checked on real lights on
  2026-10-16 (z2m discovery, Z-Wave multicast insecure and S2, WiZ, WLED; results in SPIKES.md).
  The lower hallway GE dimmer (node 22) is out of the stick's direct range and misses multicasts.
  Govee LAN is blocked: govee2mqtt holds UDP 4002.
- Mapping is a guided capture (centre, 45° left, 45° right); there is no real video to work from.

## Releasing

Bump `version` in `luminorium_addon/config.yaml` and `luminorium/__init__.py` together for every
build, and add a `CHANGELOG.md` entry. Never use a digest in `build_from`. See
[docs/deployment.md](docs/deployment.md).
