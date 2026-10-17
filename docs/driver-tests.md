# Direct-driver checks on real lights

Short tests of the phase 2 drivers on the house's real lights. **Steps 0–4 were run on
2026-10-16; results are in [SPIKES.md](../SPIKES.md#driver-checks-on-the-real-house-2026-10-16-2108-2130-luminorium-020-dev2--dev3).** Step 5 (Govee) is still open.
Each needs Chris's OK before it is run, ideally in daylight, with someone near the lights. Every
step is small and is put back afterwards.

All of it is done from Luminorium itself, installed as an add-on (0.2.0-dev.1 or later), so the
drivers use the same discovery and paths as in daily use. Before step 1, nothing touches a light.

## 0. Install and look (no light changes)

1. Install the new version with **`read_only: true`** in the options.
2. Open Luminorium from the sidebar. *Checks that Ingress still works with `host_network: true`.*
3. The "Drivers" line under the counts should read roughly: Zigbee2MQTT ~20 devices, Z-Wave JS
   ~29 nodes, WiZ LAN 2 bulbs, WLED 1 device, Govee LAN: a number, or an error.
   - Zigbee2MQTT not connected → the Supervisor didn't give MQTT credentials (log: "MQTT broker").
   - Z-Wave JS not connected → the log lists the URLs tried.
   - Govee "can't listen on UDP 4002" → govee2mqtt holds the port; Govee stays on HA.
   - Govee LAN: 0 devices → LAN Control off in the Govee app, or the devices don't answer.
4. Spot-check badges: the porch Hue says "via Zigbee2MQTT" with `z2m 'Front Porch Light '`;
   the kitchen cabinets "via Z-Wave JS" with node 26; the C3B549 WiZ "via WiZ LAN"; the front
   pathway WLED "via WLED".
5. Turn `read_only` off for the steps below, and back on when done if wanted.

## 1. Z-Wave multicast on two GE 12724s

Lights: **basement main** (node 38) and **lower hallway** (node 22): both insecure, Multilevel
Switch v1. About 10 s.

1. Group them as a temporary fixture ("Group lights", tick both, "Group as one fixture").
2. Press the fixture's **Test**: both go to full, then off, then back to how they were.
3. Expect: both change together (one multicast frame each for on and off). The Z-Wave JS
   driver status counts the multicasts; `read_back_misses` should stay 0. If it isn't 0, a node
   missed the multicast and was corrected by unicast about 1.5 s later (visible as a lag).
4. Ungroup the fixture.

Then the same with the two **S2 Authenticated** dimmers, **ZEN77** (kitchen cabinets, node 26)
and **ZEN35** (living room scene controller, node 51), to confirm S2 multicast works.

## How to send a variation of Test

Steps 2 and 4 use the Test sequence with options (a fade, an effect). Open Luminorium, open the
browser's developer console on its page (the Ingress frame), and run:

```js
fetch("api/lights/<entity_id>/test", {method: "POST", headers: {"Content-Type": "application/json"},
  body: JSON.stringify({transition_ms: 3000, effect: null, hold_s: 3})}).then(r => r.json())
```

It is the normal Test (snapshot, on, hold, off, hold, restore) with a fade of `transition_ms` on
the way on and off (0–10000), an `effect` while on (one the light lists), and `hold_s` (0–30).
The Activity list says which driver ran it: "Testing … via zwave_js, 3000 ms fade".

## 2. A 3 s fade on the ZEN77

Light: **kitchen cabinet light switch** (ZEN77, node 26, Multilevel Switch v4). About 12 s.

1. Run the snippet above for `light.kitchen_cabinet_light_switch` with `transition_ms: 3000`.
2. Expect a smooth 3 s ramp up, a hold, a 3 s ramp down, then the cabinets as they were. The
   driver sends `node.set_value` with `options: {"transitionDuration": "3s"}`.
3. For contrast, the same on a GE 12724 (`light.basement_main_lights`) should *jump* (v1: the
   driver sends no duration; the dimmer uses its own ramp rate).

## 3. One WiZ brightness change

Light: **WiZ C3B549** (192.168.10.64, no area). About 5 s.

1. Press **Test** on it: full, off, restored. Activity should say "via wiz".
2. Expect each step within about 100–200 ms (watch for the 0.4–1.1 s Wi-Fi power-save spikes
   seen in the spike). A bulb that stops answering goes back to HA after three missed polls
   ("WiZ … stopped answering" in the log).

## 4. One WLED effect

Light: **front pathway RGB** (`light.front_pathway_rgb`, segment 0 of 192.168.10.215). About 10 s.

1. Run the snippet for `light.front_pathway_rgb` with `effect: "Breathe"` and `hold_s: 5`.
2. Expect segment 0 to breathe for 5 s, go off, then return to its previous state (colour and
   effect as HA last reported them). Activity should say "via wled".

## 5. Govee LAN `devStatus`

Device: **H7055 front path lights**. Read-only: changes nothing.

1. Needs LAN Control on in the Govee app (open question 3 in SPIKES.md).
2. The Drivers line should count it, and the path lights should say "via Govee LAN".
3. Open `api/status` in the console (`fetch("api/status").then(r => r.json())`):
   `drivers.govee.found` lists each device with what it last answered to `devStatus` (polled
   every minute): `onOff`, `brightness`, `color`, `colorTemInKelvin`. Compare with the Govee app.

**Not in this list, still off:** Govee `razer` segment streaming. It needs its own test per
model (the frame layout is unverified on H7021, H7055, H7066, H60B0) before a model is added to
`govee_razer_models`.

## What to record

For each step: worked / didn't, how long it took, anything odd in the add-on log. Results go in
SPIKES.md under a new "Driver checks" section.
