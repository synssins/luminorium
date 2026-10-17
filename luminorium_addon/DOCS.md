# Luminorium

Light effects, shows and sequences across every light Home Assistant knows about.

Luminorium reads your floors, areas and lights from Home Assistant and shows each light with what
it can do, and drives each light the fastest way it can reach it. A **Test** button turns one
light on, then off, then puts it back exactly as it was. **Palettes** play slowly changing colours
in a room, and the API plays effects and shows (early days: the designer comes later). The
**House map** places every light in 3D, and **Views** place them on a photo of the house, by
hand or with the phone camera.

The menu on the left (behind the ☰ button on a phone) has every page. **Stop all**, top right on
every page, ends everything and puts every light back.

## Lights

- Each light is a card: its state, the driver it uses and how quickly it reacts, what it can do,
  and any warnings. **Test** turns it on, off, then back as it was; **Details** opens its own
  page.
- On a light's page: what it can do; which driver it uses (**Automatic**, or pin one); **Test
  with options** (a fade, an effect, a hold time); its place on the house map; what each effect
  name becomes on it.
- Lights are grouped by HA floor and area. Areas without a floor (outdoor areas, usually) are
  under **Outside / no floor**.
- Some lights are left out by default, with the reason shown: browser screens, light groups,
  Zigbee2MQTT groups, voice-assistant LED rings, Z-Wave "Basic" duplicate entities, and entities
  HA no longer provides. You can include any of them.
- **Switches** are left out until you include them. Include only switches that are light relays.
  Don't include a relay that is locked on and feeds smart bulbs: include the bulbs instead.
  A switch on a light's own device (a gradient or sync toggle) is a setting, not a light.
- Govee strip segments are shown as a count on their light.
- Levels and rooms fold: tap a heading. **Collapse all** / **Expand all** fold everything; your
  choice is remembered on that device. A search shows every match, folded or not.

## Drivers

Every light can be driven through Home Assistant. Where it pays off, Luminorium talks to the
light's own hub or the light itself instead:

| Lights | Driver | Why |
|---|---|---|
| Zigbee2MQTT | **Zigbee2MQTT** over MQTT (Mosquitto) | Faster; z2m groups change several bulbs at once |
| Z-Wave JS | **Z-Wave JS** server | Several dimmers in one message (multicast); exact fade times on dimmers that support them |
| WiZ | **WiZ LAN** (UDP) | All firmware scenes, 10+ changes per second |
| WLED | **WLED** (JSON API, DDP) | Effects and palettes by name; per-LED streaming |
| Govee (govee2mqtt) | **Govee LAN** (UDP) | No cloud round trip; needs "LAN Control" on in the Govee app |

Each light's card shows the driver it uses now. It is chosen automatically: the direct driver
when it can reach the light, otherwise Home Assistant. On the light's page you can pin it to Home
Assistant or to its direct driver instead. A pinned direct driver that can't reach the light
falls back to Home Assistant and says so. The **Drivers** page shows each driver's state.

Govee scenes always go through Home Assistant (they aren't in Govee's LAN API).

## Fixtures

Several bulbs in one fixture (the two in a ceiling fan) look like one light from outside. Group
them as a **fixture** and Luminorium tests them together, and later maps them as one.

- **Suggestions** appear in a room when lights of the same model have numbered names ("Office Fan
  RGB1", "RGB2"). Answer **Group as one** or **Not the same**.
- **Group lights** (above the list): tick the lights, optionally name the fixture, then **Group
  as one fixture** in the bar at the bottom.
- On a fixture: **Rename**, **Ungroup**, and **Test** (all its lights on, off, then restored).

## Palettes

On **Palettes & shows**, choose where to play (every light, a whole level, or a room), then
**Play** on a palette. **Quick play** on the Overview does the same.
Each light wanders through the palette's colours on its own, with long fades. **Stop** puts the
lights back as they were.

Starter palettes: Forest, Ocean, Fire, Aurora, Sunset, Team colours, Warm white. Your own go in
the add-on's config folder (`/addon_configs/<slug>/palettes/<id>.yaml`); one with the same id as
a starter palette replaces it. Saved shows go in `shows/`, extra effect names in `effects/`.

Effects use a light's own built-in effect where it has one (a Hue "fireplace", a WiZ
"Fireplace", a WLED "Fire 2012"), and otherwise run in software within what the light and its
network can take. Z-Wave dimmers get slow fades, never a flood of commands.

## House map

Place every light where it really is, in 3D, without a floorplan or the camera.

Sizes and heights are in feet and inches when Home Assistant uses imperial units (Settings ›
Units changes it). Type them as `8' 6"`, `8 ft 6 in`, `102 in`, or just `8.5`.

1. **Floors & size:** give the house's width and depth, and for each floor (from Home
   Assistant) its height above the ground outside and its ceiling height. Split levels are floors
   half a storey apart. If a floor is only part of the house (one side of a split level), say
   which stretch, left to right.
2. Pick a light on the list, or tap it in the **3D** view. Tap the floor where it is, then drag
   it to fine-tune (**Move**). Drag empty space to turn the view, and scroll or pinch to zoom.
   **Plan & side** has a flat view from above and from the street, for exact positions.
3. Choose its **Type** (ceiling, pendant, wall, floor lamp, tabletop, under cabinet, strip, path or
   post, in the ground). That sets a height, which you can change with the slider, or with **Raise** in the 3D view
   (drag it up or down).
4. **Flash it** lights it up for a moment, so you can check from outside that you picked the
   right one.

Strips stay one light, and their parts can be placed too. A WLED device's LEDs (its segment
lights fold into it) and a Govee strip's segments are listed under the light. Select a part and
tap where it is, or use **Lay out along a line** and tap where the first and the last are.
**Flash** on a part lights only that LED or segment. Everything goes back as it was afterwards.

## Views

A view is a photo of the house from one spot ("Front of house") with lights placed on it. Open
**Views** (link at the bottom of the lights page).

- **New view**, then **Photo…**. Tap a light in the list, then tap where it is on the photo.
  Drag a placed light to move it.
- **Mark a plane**: tap the four corners of the lawn or the house front (top-left, top-right,
  bottom-right, bottom-left) and give its real size if you know it. Lights on a plane get
  positions in metres.
- Select a placed light to rename it, put it on a plane, **Merge** it with others (several lights
  behind one window as one; or as **segments** of a long window), **Split**, reorder, or **Draw a
  segment line** (a strip's segments, or several lights in a row, spread along the line).

## Map with the camera

Lets the phone find where each light is, and how quickly each one reacts. It flashes the lights
you pick, one at a time, so do it when that's fine for the house (night works best).

1. Open Home Assistant on the phone through its **https://** address (Nabu Casa or your own
   certificate); the camera needs it. Open **Map with the camera**.
2. Pick the view and tick the lights you can see from the street (through windows too).
   Optionally give the distance between two of them (for real metres).
3. Pick an anchor in the middle of the house front (the front door) and keep it in the circle.
   **Start the centre station** and hold still while the lights flash (about 20–30 seconds).
   Every light goes back as it was at the end.
4. Walk about 45° to the left around the anchor (the page counts the degrees), start the left
   station; then the right one.
5. **Put them on the view and review**: check the outlines, merge or split where needed.

**Stop this pass** or **Stop all** puts every light back at once. If the camera doesn't work in
the app, use **Record a video instead**: run each station's pass, film it with the camera app,
and upload the video. Each capture is kept (the newest 10) in the add-on's config folder, so it
can be analysed again later.

## Safety

- **Stop all** is always at the bottom of the page. It ends every running test or show and
  restores every light it touched.
- Luminorium saves each light's state before touching it. If the add-on stops or crashes in the
  middle of something, it restores those lights the next time it starts.
- If someone changes a light while Luminorium is using it (a wall switch, an automation), that
  light is dropped and their change is kept.

## Options

- `read_only`: when on, Luminorium never sends anything to any light. Useful for looking around.
  The drivers still look for devices, so you can see which would be used.
- `drivers`: switch any direct driver off; its lights then go through Home Assistant.
- `wiz_subnets`, `govee_subnets`: the networks searched for WiZ and Govee devices (default
  `192.168.10.0/24`). Unicast search works across VLANs where multicast doesn't.
- `govee_razer_models`: Govee models allowed to stream per-segment colours. Leave empty until a
  model has been tested.
- `z2m_base_topic` (optional, default `zigbee2mqtt`), `zwave_url` (optional, found
  automatically).
  Camera mapping is off in this mode.
- `log_level`: `info` by default.

Luminorium uses host networking (to reach WiZ, WLED and Govee devices) and asks the Supervisor
for its own MQTT login, so the Mosquitto add-on must be installed.
