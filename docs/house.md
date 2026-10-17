# The house map

Place every light in 3D by hand, without a floorplan and without the camera. Shows can then use
real metres: a wave that rolls from the street to the house and up to the top floor.

Code: `luminorium/house.py` (`HouseService`), the API in `web/server.py`, the page in
`web/static/pages/house.js`.

## The model

- **The house is a box** of the user's size (`size.width` across the front × `size.depth` back),
  14 × 10 m until changed, or the **blocks drawn on the front photo** (below). Rooms aren't drawn:
  lights already know their HA room and floor.
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
- **Floors the user hasn't set follow the ones they have** (a height saved, or a floor line on the
  front photo): a floor between two set ones goes evenly between them, and one beyond them keeps
  going at the step between the nearest two (a storey, 2.7 m, when only one is set).
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

## The front photo

A photo of the front of the house, measured from its front door. Code: `pages/facade.js`
(`FacadeEditor`), `HouseService.set_photo`, `set_facade`, `massing` in `house.py`.

- **Scale and perspective from the door.** The user boxes the front door and drags its four
  corners onto the frame's corners. The door is 36" × 80" (0.9144 × 2.032 m) unless changed. A
  homography from those four points (direct linear transform, solved in the page) turns any point
  on the photo into metres on the plane of the front wall, and back. Things set back from the door
  come out a little small; a straight-on photo from across the street keeps that small.
- **Facade metres:** shapes are stored from the door's bottom left corner, `X` across and `Z` up.
  The **ground line** turns `Z` into height above the ground (the door sill is often a step or two
  up), and the leftmost block's left edge is the house's `x = 0`.
- **Drawing tools** (a toolbar beside the photo, each with a key):
  | Tool | Key | What it draws |
  |---|---|---|
  | Select | V | Picks a shape; drag it or its handles, Delete removes it |
  | Pan | H | Moves the photo (also: Space, the middle button, or two fingers; scroll or pinch zooms) |
  | Front door | D | Drag a box round the door, then fit its four corners. Door size in the bar above |
  | Ground line | G | Tap where the wall meets the ground |
  | House block | B | Drag a box from the ground to the eaves, wall edge to wall edge. Split levels and the garage are their own blocks |
  | Roof | R | Tap the top of a roof: **point faces the street** (a gable; its peak can sit off-centre) or **ridge along the front** |
  | Window or door | N | Drag a box over a window, door or garage door |
  | Floor line | F | Pick an HA floor, then drag along where that floor is (a tap runs it across the block it's on) |
  | Place a light | L | Tap where the light picked in the list is: **inside, by the window** (30 cm in, on the floor under that point) or **outside, on the wall** |
  | Measure | M | Drag between two points for the distance |

  Undo and redo (Ctrl+Z, Ctrl+Shift+Z) cover every change. Edges snap to the ones already drawn
  (hold Alt to stop it). While a corner or a box is being dragged, a magnifier shows the photo under
  the pointer. A scale bar shows a round length at the bottom left.
- **Steps** along the top tick off as they're done: photo, front door, ground, house blocks,
  roofs, floors, lights. A tap on a step picks its tool.
- **What it changes, on every save:** the blocks set the house width; each floor line sets its
  floor's height above the ground and the part of the house it covers (the whole width when it
  runs at least 95% across). Floors without a line keep their values.
- **In 3D** the blocks are drawn as see-through walls with their roofs, and the windows and doors
  on the front, around the floors and lights.
- The photo is shrunk in the page to 2400 px and saved as a JPEG, as `house_front.img` in the
  config folder. A new photo keeps the drawing but needs the door marked again.

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
| `PUT /api/house/photo?w=&h=` | the image bytes (JPEG, PNG or WebP, under 15 MB) | the facade; the door must be marked again |
| `GET /api/house/photo` | | the image |
| `PUT /api/house/facade` | `{door: {pts: [[u, v] ×4: top left, top right, bottom right, bottom left], w, h}, ground: {z}, blocks: [{id, name, x0, x1, z0, z1, roof: flat\|gable\|ridge, peak_x?, peak_z?, depth?, y0?}], openings: [{id, kind: window\|door\|garage, x0, x1, z0, z1}], lines: [{id, floor, x0, x1, z}]}` (facade metres) | the view, with the house width and floors applied; `400` without a photo or for a bad shape |
| `DELETE /api/house/facade` | | the view; removes the photo and the drawing |

`GET /api/house` also returns `facade` (the drawing as saved) and `massing` (`null` until a door
and a block are drawn, else `{blocks, openings}` in house metres, for the 3D view).

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
- **Front photo** (the second tab): the drawing tools above.
- **Plan & side** (the third tab), for exact positions:
- **From above:** the plan, with a 1 m grid (5 m lines heavier) and the house outline. The chosen
  floor's span is highlighted, and lights on other floors are dimmed. Tap empty ground to place
  the selected light or part; drag it to move it (5 cm steps).
- **From the street:** each floor as a band at its height. Drag the selected light up or down.
- **The list:** every light by HA floor; Outside holds the areas with no floor.
- **The panel:** floor, type, position, height, **Flash it**, **Remove**, and the parts with their
  own Flash and **Lay out along a line**.
- **Floors & size:** the house size, and each floor's height, ceiling and span.

The engine doesn't use these positions yet; the colour designer (phase 6) will.
