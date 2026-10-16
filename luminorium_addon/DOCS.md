# Luminorium

Light effects, shows and sequences across every light Home Assistant knows about.

This is phase 1 (the inventory and the safety net) plus phase 5 (views and camera mapping). Luminorium reads your floors, areas and lights
from Home Assistant and shows each light with what it can do. A **Test** button turns one light on,
then off, then puts it back exactly as it was.

## Lights

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

## Fixtures

Several bulbs in one fixture (the two in a ceiling fan) look like one light from outside. Group
them as a **fixture** and Luminorium tests them together, and later maps them as one.

- **Suggestions** appear in a room when lights of the same model have numbered names ("Office Fan
  RGB1", "RGB2"). Answer **Group as one** or **Not the same**.
- **Group lights** (above the list): tick the lights, optionally name the fixture, then **Group
  as one fixture**.
- On a fixture: **Rename**, **Ungroup**, and **Test** (all its lights on, off, then restored).

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
  Camera mapping is off in this mode.
- `log_level`: `info` by default.
