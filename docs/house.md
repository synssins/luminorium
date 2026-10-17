# The house map

Place every light in 3D by hand, without a floorplan and without the camera. Shows can then use
real metres: a wave that rolls from the street to the house and up to the top floor.

Code: `luminorium/house.py` (`HouseService`), the API in `web/server.py`, the page in
`web/static/pages/house.js`.

## The model

- **The house is a box** of the user's size (`size.width` across the front × `size.depth` back),
  14 × 10 m until changed. Rooms aren't drawn: lights already know their HA room and floor.
- **Coordinates, in metres:** `x` across the front from its left corner, `y` back from the front
  wall (negative is the yard, towards the street), `z` above the ground outside.
- **Floors come from HA.** Each has:
  - `elevation`, the floor's height above the ground. A split level is a floor half a storey
    from the next; Chris's house has four levels, each half a floor apart.
  - `ceiling`, its ceiling height (2.4 m by default).
  - an optional span `x0`–`x1`: the stretch of the house, left to right, that the floor covers
    (the left half of a split-level house, say). Empty means the whole width.
- **First guess:** the level whose name has "main" (else the lowest above ground) is at 0.
  Nothing goes deeper than one storey below the ground (2.4 m, 7′ 10″). The floors under main
  share that depth evenly, so a split-level house (levels half a storey apart) comes out right:
  in this house Basement −7′ 10″, Ground −3′ 11″, Main 0, Bedroom +3′ 11″. Above main, floors keep
  the same step in a split-level house, and are a full storey (2.7 m) each in a plain one. The
  user corrects it under **Floors & size**.
- **Outside** (`_outside`) is the yard. A height outside is above the ground.
- **Items:** a light or a fixture. Each has a `floor`, `x`, `y`, `h` (the height above that floor)
  and a `mount`. Its world position is (`x`, `y`, `elevation + h`).
- **Mount types** suggest a height:
  - ceiling: the ceiling less 5 cm
  - pendant: the ceiling less 60 cm
  - wall: 1.8 m
  - floor lamp: 1.5 m
  - tabletop: 0.8 m
  - under cabinet: 1.4 m
  - strip: 1.0 m
  - path or post: 0.5 m
  - in the ground: 0 m
  - other: 1.5 m

  The height can be changed afterwards.
- **What can be placed:** included lights and opted-in switches, plus fixtures (as one item,
  never their member lights).
- **Segmented lights stay one light.** Their **parts** can be placed one by one, or spread
  evenly between two points ("Lay out along a line"):
  - **WLED:** the light's LEDs, labelled with the WLED segment each is in. A WLED device's
    segment lights (`light.front_pathway_rgb`, `…_white`) fold into its main light.
  - **Govee (govee2mqtt):** the strip's segment entities.

  A light with parts sits at the middle of its parts.

Stored in the add-on's config folder as `house.json` (so it's in HA backups):

```json
{
  "size": {"width": 14.0, "depth": 10.0},
  "floors": {"ground_level": {"elevation": -1.3, "ceiling": 2.4, "x0": 0, "x1": 7}},
  "items": {
    "light.front_pathway_master": {"floor": "_outside", "x": 7, "y": -3, "h": 0.5, "mount": "post",
      "parts": {"0": {"x": 2, "y": -3, "h": 0.5}, "1": {"x": 2.9, "y": -3, "h": 0.5}}}
  }
}
```

## Identify

**Flash** lights the selected light, fixture or part for a moment so it can be spotted from where
you stand. Every flash is restored afterwards, and nothing is sent in read-only mode.

- **A light:** white (or full brightness) for 1.5 s, then restored (`LightTester.identify`).
- **A fixture:** the fixture's Test.
- **A Govee segment:** the same flash on that segment's own entity.
- **A WLED LED:** about 2 s of DDP realtime frames with only that LED lit. WLED returns to its
  own state by itself a few seconds after the frames stop.

## API

| Request | Body | Result |
|---|---|---|
| `GET /api/house` | | `{size, floors: [{id, name, level, elevation, ceiling, x0, x1}], outside, mounts: [{id, label}], targets: [...], lights: {items}}`. Each target: `{id, kind: light\|fixture, name, area_id, floor_id, integration, state, placed, item, world: {x, y, z}, parts: [{index, label, entity_id, placed, world}]}` |
| `PUT /api/house/settings` | `{size?: {width, depth}, floors?: {floor_id: {elevation?, ceiling?, x0?, x1?}}}` | the view; `400` for sizes outside 1–200 m or ceilings outside 1.5–12 m |
| `PUT /api/house/items/{target}` | `{floor, x, y, h?, mount?}` (no `h`: the mount's height) | the item; `400` bad floor, mount or number; `404` unknown target |
| `DELETE /api/house/items/{target}` | | `{removed}` |
| `PUT /api/house/items/{target}/parts/{index}` | `{x, y, h?}` | `{placed}`; the item must be placed first |
| `DELETE /api/house/items/{target}/parts/{index}` | | `{removed}` |
| `POST /api/house/items/{target}/line` | `{start: {x, y, h}, end: {x, y, h}, parts?: [index, …]}` | `{placed: n}`: the parts spread evenly from start to end |
| `POST /api/house/identify` | `{target, part?}` | `{flashing, part?}`; `409` when read-only or the light is busy |

## Units

Everything is stored in metres. The page shows and accepts the user's units: feet and inches when
Home Assistant's unit system is imperial (`get_config` → `unit_system.length` is `mi`), else
metres. **Settings › Units** overrides it per browser. Fields accept `8' 6"`, `8 ft 6 in`,
`102 in`, `8.5'`, `2.6 m` or `260 cm`, or a bare number in the current unit. In imperial the
grid is in feet (heavier every 5 ft), and dragging snaps to a whole inch (5 cm in metric).

## The page

- **3D** (the default tab): the house as a volume. Each floor is a slab at its height, over its
  span, with its ceiling outline, above a ground grid. Every placed light is an orb with a line
  down to its floor (lit ones glow); a strip's parts are small dots. Lights on other floors are
  dimmed. The view is drawn by `pages/house3d.js`, a small perspective renderer on a 2D canvas
  (no 3D library to download, so it works offline).
  - Drag empty space to turn the view; scroll or pinch to zoom. **3D**, **Top** and **Front**
    reset the angle.
  - Tap a light to pick it. Tap the floor to put the picked light (or part) there, on the floor
    chosen above the view.
  - **Move:** drag the picked light, or one of its parts, across its floor.
  - **Raise:** drag it up or down; it stops at the ceiling.
- **Plan & side** (the second tab), for exact positions:
- **From above:** the plan, with a 1 m grid (5 m lines heavier) and the house outline. The chosen
  floor's span is highlighted, and lights on other floors are dimmed. Tap empty ground to place
  the selected light or part; drag it to move it (5 cm steps).
- **From the street:** each floor as a band at its height. Drag the selected light up or down.
- **The list:** every light by HA floor; Outside holds the areas with no floor.
- **The panel:** floor, type, position, height, **Flash it**, **Remove**, and the parts with their
  own Flash and **Lay out along a line**.
- **Floors & size:** the house size, and each floor's height, ceiling and span.

The engine doesn't use these positions yet; the colour designer (phase 6) will.
