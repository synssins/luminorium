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
  - under cabinet: 54" (a 36" counter, 18" above it)
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
- **Several fixtures on one switch** (cans on one dimmer): tick **Multiple fixtures on this
  switch** on a placed light and say **How many** (2-50). Each becomes a part, "Fixture 1"…,
  starting in a row from the light, 4 ft apart; place or drag each where it is. The light sits in
  the middle of them. In 3D and from above they're joined by a dashed line: one switch. Stored as
  `fixtures` (the count) and `parts` on the item; `PUT /api/house/items/{target}/fixtures`
  `{count}` (0 for one fixture again). Not for lights whose parts are their own segments.

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

- **The camera, from the door.** The door's four corners and its size give a homography; from
  it the editor works out the camera (`solveCamera` in `facade.js`): its focal length from the
  door's perspective when two estimates agree, else a typical phone lens (65° across), then
  where it stood. With the camera, any plane parallel to the front wall (`Y` = a set-back or an
  overhang) and the level ground (`Z` = the ground) maps to the photo and back. Each shape is
  measured on its own plane: blocks and roofs on their front face, windows on their block's,
  roof edge lines at the eaves (`Y` = -eave). Changing a plane (a block's front face, the door's
  recess, the eaves) keeps every shape where it is on the photo and measures it again
  (`keepOnPhoto`).
- **Scale and perspective from the door.** The user boxes the front door and drags its four
  corners onto the frame's corners. The door is 36" × 80" (0.9144 × 2.032 m) unless changed. A
  homography from those four points (direct linear transform, solved in the page) turns any point
  on the photo into metres on the plane of the front wall, and back. Things set back from the door
  come out a little small; a straight-on photo from across the street keeps that small.
- **Facade metres:** shapes are stored from the door's bottom left corner, `X` across and `Z` up;
  `Y` is how far back from the main front wall (0), into the house. The door sits **Set back into
  the wall by** `door.recess` behind it.
  The **ground line** turns `Z` into height above the ground (the door sill is often a step or two
  up), and the leftmost block's left edge is the house's `x = 0`.
- **Drawing tools** (a toolbar beside the photo, each with a key):
  | Tool | Key | What it draws |
  |---|---|---|
  | Select | V | Picks a shape; drag it or its handles, Delete removes it |
  | Pan | H | Moves the photo (also: Space, the middle button, or two fingers; scroll or pinch zooms) |
  | Front door | D | Drag a box round the door, then fit its four corners. Door size in the bar above |
  | Ground line | G | Tap where the wall meets the ground at one end of the house, then at the other. Tap the line to add a bend where the front steps in or out, and drag it onto the corner; drag the ends to tilt it; Alt-click a bend to take it out. The ground's height is the ends' average; each point is found on the ground (`onGround`), giving the front **footprint** (how far back or out each bend is) |
  | House block | B | Drag a box from the ground to the eaves, wall edge to wall edge. Split levels, the garage and the entry are their own blocks. **Its front wall:** in line, sticks out (an overhang), set back (a recessed entry), or follows the ground line (from its footprint). **Part of** a level, with **its floor** the same as the level's or higher or lower (a landing, storage over the entry); **its bottom is that level's floor** sets the level's height. It can **go into the ground** by a length (a basement) |
  | Roof outline | R | Tap each corner of a roof as seen from the street, all the way round; tap the first corner (or Enter) to finish, Backspace takes the last one back, Esc stops. Any number of roofs, any shape (a porch overhang and a dormer are roofs of their own). Each says how it **goes back**: **slopes to a ridge** (the outline is the front slope; a trapezoid makes a hip roof), **same shape all the way back** (a gable facing the street, or a flat roof), or **one slope to the back** (a shed roof); plus its depth, how far back the ridge is, and how far it's set back (less than 0 sticks out toward the street). Drag a corner to move it, double-click an edge to add one, Alt-click a corner to take it out |
  | Roof edge line | E | Tap one end of a roof level's bottom edge, then the other (one line per level); tap a line to add a bend, drag points to fit, Alt-click a bend away. Measured at the eaves (`Y` = -eave). The **roofline** is from the leftmost point to the rightmost, overlaps counted once; it scales the top view. **Eaves stick out** (24" unless changed) |
  | Window or door | N | Drag a box over a window, door or garage door |
  | Floor line | F | Pick an HA floor, then drag along where that floor is (a tap runs it across the block it's on). The line marks **the floor**, or **the ceiling under it** (where the siding changes between storeys): then the floor is a floor's thickness higher. **Floors are … thick** (12" unless changed) |
  | Place a light | L | Tap where the light picked in the list is, measured on the block tapped: **inside, by the window** (30 cm in, on the block's level, else the floor under that point), **outside, on the wall**, or **under the eaves** (half the eaves' depth out, mount Under the eaves) |
  | Measure | M | Drag between two points for the distance |

  Undo and redo (Ctrl+Z, Ctrl+Shift+Z) cover every change. Edges snap to the ones already drawn
  (hold Alt to stop it). While a corner or a box is being dragged, a magnifier shows the photo under
  the pointer. A scale bar shows a round length at the bottom left.
- **Steps** along the top tick off as they're done: photo, front door, ground, house blocks,
  roofs, floors, lights. A tap on a step picks its tool.
- **What it changes, on every save:** the blocks set the house width; each floor line sets its
  floor's height above the ground and the part of the house it covers (the whole width when it
  runs at least 95% across), and a block whose bottom is a floor sets that floor. A floor's
  ceiling is the underside of the next floor drawn above it over the same part of the house (that
  floor's height less the floor thickness). Floors without a line follow the ones with one.
- Drawings from before roofs were their own shapes (a block's gable or ridge) are turned into
  roof outlines when loaded.
- **In 3D** the blocks are drawn as see-through walls, each roof is built from its outline as it
  says, and the windows and doors are on the front. A block that goes into the ground leaves a
  hole in the ground grid where it goes in.
- The photo is shrunk in the page to 2400 px and saved as a JPEG, as `house_front.img` in the
  config folder. A new photo keeps the drawing but needs the door marked again.

## The top view

A photo from above (`pages/site.js`, `SiteEditor`; `house_site.py`). Kept as `site` in
`house.json`; the photo is `house_top.img`.

- **Placing the photo:** photo px (`u` right, `v` down) to house metres: flip `v`, turn by
  `theta`, scale by `s`, shift by `(tx, ty)` (`xf`).
  - **Square up:** one line along any straight wall or roof edge, running **across the front** or
    **front to back**, turns the photo square. **Turn** adds quarter turns until the street is at
    the bottom.
  - **Scale from the roofline:** the front roof edge traced end to end. Only the distance across
    between its two ends counts (after squaring). It equals the front photo's roofline, or a typed
    length; the left end goes to the roofline's left end, the eaves' depth in front of the wall.
  - **Check front to back** (optional): a second line and its known length. Over 3% apart is a
    check (below).
  Changing the placement keeps what's traced where it is on the photo.
- **Roof outline:** its corners, in house metres. While tracing, a corner within 10° of straight
  across or straight back from the last one snaps to it (Alt to stop it). Finishing (or **Square
  it up**, or loading one drawn before) squares it to the house: the edges' average lean is taken
  out by turning the photo that much (`trim`), and each edge is made exactly straight. Only for
  outlines whose edges are all within 12° of square. The **outside walls** are the outline pulled in
  by the eaves (`inset`), as thick as their build (2x4, 2x6 or 2x8: studs, drywall, sheathing and
  siding). The deepest point sets the house's depth, and blocks without their own depth go back
  as far as the plan does over their width.
- **Yard:** paths (a centre line and a width), driveways, patios, pools, garden beds, lawns
  (outlines, straight or **curved**: a smooth curve through the points), trees and bushes (a
  centre, a radius, an optional height). Drawn on the ground in 3D.
- **Floor plans,** one per level:
  - **Walls:** tap where one starts and ends; it stays square to the house and snaps to other
    walls' ends and the outside walls' inside faces. Its build: 2x4, 2x6 or 2x8 with drywall
    (½") or plaster (¾") on each face. **How far from** an outside wall or a parallel wall,
    **wall face to wall face**, as measured with a tape: typing it moves the wall.
  - **Doorways:** on a wall, a width and how far from the wall's end.
  - **Rooms:** a name tied to one of Home Assistant's areas.
  In 3D each wall is a see-through panel from its level's floor to its ceiling.
- **Lights from above:** place a light on a level or outside. **Aim a light:** tap it; it is
  **All around** (bulbs, ceiling lights), a **Flood** (90°), a **Spot** (25°) or a **Half** (a
  wall light, up to 180°). Drag its arrow to turn it and the edge of its beam to widen it; tilt it
  from straight down to straight up in the panel. Stored on the item as `aim: {kind, beam, tilt,
  heading}`: heading in degrees clockwise from above, 0 facing the street. Drawn as a wedge from
  above (a circle when it points straight up or down) and a cone in 3D.

## Floods and spots

The light's panel has **Its light**: **All around** (no aim), **Flood** (90°), **Spot** (25°) or
**Half** (a wall light, 180°), with sliders for the beam width, how far it **Points** up or down,
and which way it's **Turned**. Two ways to point it at something:

- **Aim at something in 3D:** click what it should light. The click is cast into the scene
  (`House3D.raycast`): the nearest of the ground, a house block's walls (as boxes), and trees and
  bushes (as spheres round their canopy). The light then points at that spot.
- **Aim from above** (the Top view's **Aim a light**): tap the ground, or a tree or bush (its
  canopy, for an uplight).

Aimed at a spot, the item keeps `aim.at` ({x, y, z}) and `aim.what` ("the garage wall"), and the
heading and tilt are worked out from the light to it (`_aim_towards`), again whenever the light
is moved. Turning it by hand (the sliders, the arrow from above) drops the spot. In 3D a dashed
line runs from the light to a ring where the beam lands; from above, to a crosshair.

## Checks

`HouseService.checks()` (in `GET /api/house` as `checks`) and the front photo's own
(`FacadeEditor.checks()`) are plain arithmetic: numbers that should agree and don't, and things
being guessed. Each has a `level` (`warn` or `info`), a `tab` to show (`photo`, `top`, `floors`)
and a sentence. The page lists them above the views (**Things to check**), each with **Show me**.

| Check | When |
|---|---|
| Mark the front door | a front photo without a door |
| No ground line | heights are measured from the door sill |
| Roof across, from above vs the front | more than 3% apart |
| Front to back, from above vs the length given | more than 3% apart |
| Floors out of Home Assistant's order | a floor at or below the one HA has under it |
| Low ceiling | under 6 ft |
| Guessed floors | some floors set, others following them |
| Inside light outside the walls | an inside light outside the plan |
| Wall outside the house | a floor plan wall beyond the outside walls |
| Small door (page) | the door under 40 px wide in the photo |
| Photo from the side (page) | the camera further off to the side than 70% of its distance |
| Ground line tilted (page) | its ends more than 1 ft apart in height |

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
| `PUT /api/house/facade` | `{door: {pts: [[u, v] ×4: top left, top right, bottom right, bottom left], w, h}, ground: {z}, floor_depth?: 0.3048, blocks: [{id, name, x0, x1, z0, z1, depth?, y0?, below?, floor?}], roofs: [{id, name, pts: [[X, Z], …3–40], back: ridge\|extrude\|shed, depth?, y0?, ridge_y?}], openings: [{id, kind: window\|door\|garage, x0, x1, z0, z1}], lines: [{id, floor, x0, x1, z, at: floor\|below}]}` (facade metres) | the view, with the house width and floors applied; `400` without a photo or for a bad shape |
| `DELETE /api/house/facade` | | the view; removes the photo and the drawing |
| `PUT /api/house/photo?which=top&w=&h=` | the image bytes | the top view; it must be placed again |
| `GET /api/house/photo?which=top` | | the image |
| `PUT /api/house/site` | `{xf: {s, theta, tx, ty}, square: {a, b, runs: across\|depth}, turns, ref: {pts, length?}, check: {pts, length}, outline: [[x, y]…], ext_wall: 2x4\|2x6\|2x8, yard: [{id, kind, name, pts?, smooth?, width?, c?, r?, h?}], walls: [{id, level, a, b, studs, finish}], doors: [{id, wall, at, width}], rooms: [{id, level, at, area, name}]}` | the view; `400` for an unknown level, area, build, wall or yard kind |
| `DELETE /api/house/site` | | the view; removes the top photo and its drawing |
| `PUT /api/house/items/{target}/aim` | `{kind: flood\|spot\|wall, beam?, tilt?, heading?, at?: {x, y, z}, what?}` or `null` (with `at`, heading and tilt point at it) | the item; `400` before it's placed or out of range |

`GET /api/house` also returns `site` (the top view as saved), `top` (`{plan, outline, ext_thick,
yard, walls (with thickness), doors, rooms}`) and `checks`. `massing` adds `footprint` (the front
along the ground), `roofline` and `eave`; its blocks add `level` and `offset` for spaces.

`GET /api/house` also returns `facade` (the drawing as saved) and `massing` (`null` until a door
and a block are drawn, else `{blocks, openings, roofs}` in house metres, for the 3D view; a
block's `z0` includes how far it goes into the ground).

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
  - Drag empty space to turn the view; drag with the right button or the wheel (or Shift and the
    left button, or two fingers) to slide it; scroll or pinch to zoom.
  - **The view cube** (top right) turns with the view, with X (across), Y (back) and Z (up) at its
    corner. Click a face (FRONT, BACK, LEFT, RIGHT, TOP, BOTTOM), an edge or a corner to look from
    there; the view turns smoothly. **⌂** goes back to the usual view and takes the slide away.
  - **Shape:** tap a house block to pick it. Yellow handles on its sides, back and top (and its
    front, for a block behind another) drag those faces, showing the distance as they go, an inch
    (or 5 cm) at a time. The panel shows its size and moves a face **Out** or **In** by a typed
    amount, **splits it front to back** (the front part keeps the depth typed; a new block behind
    it, "(back)", takes the rest, with its own top, level and floor), and sets its level and floor.
    `PUT /api/house/blocks/{id}` `{x0?, x1?, z0?, z1?, y0?, depth?, name?, level?, offset?}` and
    `POST /api/house/blocks/{id}/split` `{front_depth}`, in house metres. Blocks behind others
    (`behind`) aren't on the front photo. The house's left edge is fixed (`facade.ox`) once there
    are blocks, so moving a block's left face doesn't shift what's placed by it.
  - Tap a light to pick it. A light (or part) not placed yet goes where you then tap the floor,
    on the floor chosen above the view. Tapping off a placed light lets go of it: it only moves
    when dragged.
  - **Move:** drag the picked light, or one of its parts, across its floor.
  - **Raise:** drag it up or down; it stops at the ceiling.
  (The flat "Plan & side" tab was removed in 0.3.0-dev.12: the Top view and 3D cover it.)
- **Front photo** (the second tab): the drawing tools above.
- **Top view** (the third tab): the photo from above, the yard, floor plans, and aiming.
- **Fits the window** on a big screen (1181 px wide and 600 px tall or more): nothing scrolls the
  page; the list and the panel scroll inside themselves and the view takes the rest. On the
  photo tabs the editor's own panel replaces the page's, to give the photo the room.
- **Guessed floors** (`set: false` in `floors`, heights followed from the set ones) are drawn
  dashed in 3D and labelled "(guessed)".
- **The list:** every light by HA floor; Outside holds the areas with no floor. Each level folds
  away (remembered) and shows how many of its lights are placed; a search shows every match.
  Picking a light keeps the list and the page scrolled where they were.
- **The panel:** floor, type, position, height, **Flash it**, **Remove**, and the parts with their
  own Flash and **Lay out along a line**.
- **Floors & size:** the house size, and each floor's height, ceiling and span.

The engine doesn't use these positions yet; the colour designer (phase 6) will.
