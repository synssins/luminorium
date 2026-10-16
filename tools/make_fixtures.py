"""Turn raw HA dumps into scrubbed test fixtures.

Usage: python tools/make_fixtures.py DUMP_DIR [OUT_DIR]

DUMP_DIR holds what tools/capture_ha.mjs writes: floor.json, area.json, device.json, entity.json,
states.json and zwave.json. Only lights, switches and assist satellites (plus their devices) are
kept. MAC addresses, Govee device ids, the Z-Wave home id and personal names are replaced
consistently across all files, so the fixtures still link up.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

KEEP_DOMAINS = {"light", "switch", "assist_satellite"}
# Switches from other integrations (cars, alarms, appliances) are left out: not lights, and their
# ids can carry account details.
SWITCH_PLATFORMS = {"zwave_js", "mqtt", "esphome", "wled", "wiz", "matter", "template", "group"}
NAMES = {"Cindy": "Partner", "cindy": "partner"}
STATE_ATTRS_DROP = {"entity_picture"}


def fake_hex(value: str, length: int) -> str:
    return hashlib.sha256(("luminorium:" + value).encode()).hexdigest()[:length].upper()


def main(dump: Path, out: Path) -> None:
    load = lambda name: json.loads((dump / f"{name}.json").read_text(encoding="utf-8"))  # noqa: E731
    floors, areas = load("floor"), load("area")
    entities = [
        e
        for e in load("entity")
        if e["entity_id"].split(".")[0] in KEEP_DOMAINS
        and (not e["entity_id"].startswith("switch.") or e["platform"] in SWITCH_PLATFORMS)
    ]
    device_ids = {e["device_id"] for e in entities if e.get("device_id")}
    devices = [d for d in load("device") if d["id"] in device_ids]
    for d in devices:
        d["serial_number"] = None
    keep_ids = {e["entity_id"] for e in entities}
    states = [s for s in load("states") if s["entity_id"] in keep_ids]
    for s in states:
        for key in STATE_ATTRS_DROP:
            s["attributes"].pop(key, None)
        s.pop("context", None)
    zwave = load("zwave") if (dump / "zwave.json").exists() else {}
    zwave = {k: v for k, v in zwave.items() if k in device_ids}

    files = {
        "floors": floors,
        "areas": areas,
        "devices": devices,
        "entities": entities,
        "states": states,
        "zwave": zwave,
    }
    text = {name: json.dumps(data, indent=1, ensure_ascii=False) for name, data in files.items()}
    blob = "\n".join(text.values())

    replacements: dict[str, str] = dict(NAMES)
    for mac in set(re.findall(r"(?i)\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b", blob)):
        h = fake_hex(mac.lower(), 12).lower()
        fake = ":".join(h[i : i + 2] for i in range(0, 12, 2))
        replacements[mac] = fake if mac.islower() else fake.upper()
    for gid in set(re.findall(r"gv2mqtt-([0-9A-F]{16})", blob)):
        replacements[gid] = fake_hex(gid, 16)
    for home in set(re.findall(r'"(\d{9,10})\.\d+-\d+-', blob)):
        replacements[home] = str(int(fake_hex(home, 8), 16))[:10]

    for email in set(re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", blob)):
        replacements[email] = "user@example.com"
    pattern = re.compile(
        "|".join(re.escape(k) for k in sorted(replacements, key=len, reverse=True))
    )
    out.mkdir(parents=True, exist_ok=True)
    for name, content in text.items():
        scrubbed = pattern.sub(lambda m: replacements[m.group(0)], content)
        (out / f"{name}.json").write_text(scrubbed + "\n", encoding="utf-8")
        print(f"{name}: {len(files[name])} items")


if __name__ == "__main__":
    dump_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("tests/fixtures/ha")
    main(dump_dir, out_dir)
