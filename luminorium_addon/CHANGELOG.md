# Changelog

## 0.3.0-dev.64

- **Right-click any fixture of a light:** each bulb or fixture of a light on one switch (or a
  fixture made of several lights) opens the menu for the whole of it, never one bulb.
- **Lights stay lit wherever they're seen:** a light shows unless the view's cut takes its level
  away; Outside (no cut) lights every level, not just the yard.
- **Lights placed above a ceiling still shine:** a light is kept just under the first ceiling over
  it (a recessed can in a soffit set too high was shut inside it, dark).

## 0.3.0-dev.63

- **Top riser:** a flight now has its top riser, from the top tread up to the floor it reaches,
  instead of a gap at the edge of that floor's hole.

## 0.3.0-dev.62

- **Right-click menu in the 3D view:** right-click a light (its icon, or near where it's placed), a
  TV or a light bar for On, Off, colour and brightness. Under **Simulate** it changes only what's
  shown here; otherwise it's sent to the light. **Pick it** selects the light as a tap would.
  Right-click a garage door to open or close it in the view.
- **New:** `POST api/lights/{id}/set` turns a light (or every light in a fixture) on or off, with an
  optional colour and brightness.
- **Simulate lights every level up to the one shown,** not just that level, and **All on** turns on
  TVs' and light bars' lights too. A TV's Ambilight follows Simulate.
- **More lights at once:** glows close together are joined into one light, so every lit room gets
  one; the brightest 8 cast shadows (4 on small screens) and 12 more (6) light without.
- **Garage doors open:** drawn on their own, down in the opening or up under the ceiling.
- **Doors with glass:** a door can have a glazed top part (`lite`, a share of its height).
- **Light bars:** a new kind of thing in the house (`bar`): a long LED fixture that lights along
  its length when its light is on.
- **Openings sit on the right face:** a window or door goes on the face of the part of the house
  its height falls in (the ground floor's set-back front), not the first part above it.

## 0.3.0-dev.61

- **No walls inside other parts of the house:** a block's face that runs through another block (an
  entry under the bedroom level) isn't drawn; it was blocking the stair openings and the storage
  door.
- **Windows are holes in the wall:** outside walls are cut round every window and door, with see-
  through glass that lets light through (inside light shows outside at night, daylight comes in).
- **Day and Night** (tool bar, the solid view): noon, with the sun high overhead and shadows only
  from the eaves and overhangs; or night under a dim moon, lit by the house's lights. Replaces the
  low sun that threw long shadows.
- **Simulate** (tool bar): try lights out in the view instead of showing them as they are. Each
  light's panel gets **Try it**: on or off, colour and brightness; **All on** and **All off** in the
  tool bar. Nothing is sent to the lights; the settings are kept in this browser.
- **Icons** (tool bar): hide the lights' icons and keep their light (the picked light still shows).

## 0.3.0-dev.60

- **Stairs with head room:** inside, each step sits on a slab that follows the flight's slope, so
  there's room under a stair (a basement stair under the bedroom stair) instead of a solid block.
  Steps outside stay solid down to the ground.
- **Stairwells have sides:** where a flight drops through a floor, its sides are walled from the
  floor below up to the floor above, unless a plan wall is already there.
- **Floors open where the house's parts pass through them:** a floor is cut away where another block
  runs up through its height (an entry and its landing under the bedroom level), so those keep
  their own ceilings. Overlapping holes are merged.
- **Outside and Wood Shop show the whole house:** levels with no walls or blocks in the house don't
  cut the solid view.

## 0.3.0-dev.59

- **No walls where the house's parts meet:** a block's face that's against another block is no
  longer drawn as a solid wall (it covered the plan's own walls, with their doorways and stair
  openings). Faces are worked out in bands of height, so a stretch out in the open at one height
  (a recessed front door's sides) gets its siding even where another block sits above it.
- **The house sits on the ground:** walls of a floor just above the ground go on down into it as
  foundation.
- **Walls stop light:** the house's lights in the WebGL view cast shadows, so light no longer
  comes through walls. Shadows are only redrawn when the house or its lights change.
- **Doors on any wall:** a Top view window can be a `door` (a back door).

## 0.3.0-dev.58

- **WebGL stays on:** the check for WebGL ran every frame and each run took one of the browser's
  few WebGL contexts, so after some turning the browser dropped the view's own context (the
  tablet fell back to 2D). It's checked once now. When the solid view does draw in 2D, it says why
  at the top left.
- **Things in the house** (`site.objects`): a TV (a black panel with a glossy screen) or a plain
  box, placed by its middle, bottom, size and turn. A TV can name its light (an Ambilight strip):
  when that light is on, the wall round the TV glows in its colour and a few lights behind its
  edges wash the wall and the room.
- **Sloped surfaces** (`site.planes`): any flat polygon in 3D, such as a stairwell's sloped ceiling or
  a storage floor.
- **Openings partway up a wall** (a doorway's `sill`): a crawl-through.

## 0.3.0-dev.57

- **The WebGL view on tablets:** the house's lights are a fixed set that only changes when the
  lights do (rebuilding them every frame made the GPU recompile its shaders: slow, and errors on a
  tablet); fewer lights and a smaller shadow map on phones and tablets; the house is only rebuilt
  when it changes. If the GPU drops the WebGL context the view goes back to the 2D drawing. The
  2D canvas (lights, labels, the cube) stays on top of the WebGL one.

## 0.3.0-dev.56

- **The solid view in WebGL:** the house is drawn with three.js (bundled in the add-on, works
  offline) under the 2D view, with the same camera: real solids with a depth buffer, so walls,
  floors, stairs and windows hide each other properly from any angle. Walls are closed boxes (outside
  walls their full thickness, siding only where they face the open), stairs are solid steps,
  windows and doors sit in the walls with white frames, floors carry their finishes, and the lawn,
  walks, beds and trees sit on the ground. Lit by the sun (with shadows) and by up to 12 of the
  house's lights that are on, in their own colour. Falls back to the 2D drawing where WebGL isn't
  available.

## 0.3.0-dev.55

- **Walls have their ends again:** each wall is drawn as a closed solid (sides, ends, cut top),
  only the faces turned toward you, so a wall seen end-on isn't two thin skins.
- **Siding only outdoors:** a block's face that's against another part of the house is plaster;
  only the stretches out in the open (the sides of the front door's recess, say) get siding.
- **Front steps are solid:** stairs get a back face down to the ground, so the stoop isn't hollow.

## 0.3.0-dev.54

- **Walls are solids:** the solid view draws only the faces of walls and steps that are turned
  toward you, so turning the view no longer shows into a wall or its back faces, and faces are
  edged in their own colour, so no thin seams show between them.

## 0.3.0-dev.53

- **Stairwell walls:** a wall can run through more than its level (`z0`, `z1` on a Top view wall):
  a stairwell's sides go from the floor at the bottom of the stairs to the ceiling at the top, one
  continuous wall each side.

## 0.3.0-dev.52

- **A real lawn and paving:** in the solid view the ground is grass (a photo texture from the
  house's own front lawn) and walks, drives and patios are concrete; the grid is faint.
- **Every level's walls show** in the solid view, cut off at the level shown, and run up through
  the floor framing to the next floor (no gap between storeys).
- **Solid outside walls:** each has its thickness (an inside face and a cut top), so interior walls
  meet a wall, not a thin shell. Interior walls are one plaster surface: no outlines or end faces
  between their pieces.
- **Windows everywhere:** the front's windows and doors, and windows on any other outside wall
  (`site.windows`: from a to b along the wall, sill to top, panes), drawn as glass with a white
  frame and mullions, inside and out.

## 0.3.0-dev.51

- **Doorways in 3D:** interior walls open where their doorways are, with the wall carried on over
  each one as a header. A doorway can say how high its opening goes (**Top of the opening** in
  its panel; a door's 6' 8" if empty), so an opening down a few steps tops out at the lower
  level's ceiling and the wall above runs over it. Light passes through a doorway and stops at the
  wall around it.
- **Stairs are real steps:** each tread has its riser, and in the solid view the sides are filled
  in under them (wood inside, concrete outside). Stairs can end in a flat **landing** (a front
  stoop). Where stairs come up through a floor, the floor has a hole over them.
- **Walls and floors that look like the house:** in the solid view the walls are a warm beige, lit
  by which way they face; outside walls show lap siding; floors show what they're finished in
  (`site.finishes`: hardwood, vinyl tile, mosaic tile, for a whole level or a room's stretch), as
  photo textures.

## 0.3.0-dev.50

- **Beams stay in the house's rooms:** every block's walls, floor and ceiling stop light, at any
  height, for any light (a light set to Outside used to shine through the floors above it). A
  beam reaches the same distance every way, so a wide flood no longer throws long spikes.
- **Things to check:** a light set to Outside that sits inside the house is flagged: set its
  floor to the level it's on.

## 0.3.0-dev.49

- **Each type of light lights like it:** a flush mount or ceiling light is a wide dome down that
  fills its room, a can a cone down, a wall light a half dome out, a floor lamp up, and so on;
  the solid view lands each one where it meets the floor.
- **Flood and Spot start the right way:** on a can or other ceiling light they start pointing
  straight down, not level toward the street. Ceiling floods that were never aimed now point
  down.
- **Icons:** the can is a recessed downlight and the flush mount a dome; an aimed can keeps its
  can icon.

## 0.3.0-dev.48

- **Groups are their lights' fixtures by themselves:** a placed group of lights is one fixture per
  light without ticking anything (groups placed before this get it on the next load), in a row
  from where it is: drag each where it is. Unticking **Multiple fixtures** makes it one fixture,
  and it stays one.

## 0.3.0-dev.47

- **A group of lights can be several fixtures:** a group made on the Lights page (two cabinet
  lights grouped) gets **Multiple fixtures on this switch** too, starting with one fixture per
  light, each placed on its own.

## 0.3.0-dev.46

- **Ceilings stop light:** a beam aimed upward ends at its level's ceiling instead of rising
  through it (and over the walls) into the level above.

## 0.3.0-dev.45

- **Light types:** flush mount, can (recessed) and ceiling fan join the types. A light can be a
  **bar lamp** or **strip** with a length, which way it lies, and which way it shines (down, up,
  sideways).
- **Icons:** each light in 3D shows what it is (ceiling, flush, can, fan, pendant, wall, lamp,
  spot, bar, post...) instead of a plain dot.
- **Walls stop light:** spot and flood beams, and the solid view's pools of light, end at the
  first wall in their way.

## 0.3.0-dev.44

- **A refresh stays on your page:** refreshing (in Home Assistant, which reloads the add-on at the
  Overview) comes back to the page you were on, with what it showed. Clicking Overview still
  goes to the Overview.

## 0.3.0-dev.43

- **3D drawing order, fixed:** each room is drawn as a whole, the farthest first: its floor, the
  walls seen from inside, light on the floor, what's in it (interior walls, stairs), then the
  walls seen from outside. An interior wall no longer gets cut off by a wall behind it at some
  tilts.
- **Interior walls by level:** walls on levels above the one shown are hidden (and cut at its
  ceiling); the solid view shows only the shown level's walls and light.
- **A pool of light per fixture:** a light that's several fixtures on one switch lights a pool
  under each fixture, not one big one in the middle.

## 0.3.0-dev.42

- **The plan follows the blocks:** moving a block in 3D takes the walls, rooms and stairs inside
  it along; dragging a face stretches the walls that end against it.
- **Floors, fixed:** a level's floor no longer spreads under a taller block set to another level
  (Main's floor drew to the basement block's outline).

## 0.3.0-dev.41

- **Merge, fixed:** a path and an area merge whichever you pick first; the result is the area,
  with the path as part of it. Before, picking the path first refused.

## 0.3.0-dev.40

- **Join blocks** (3D, Shape): Ctrl+click two or more and **Join**: one shape, no wall between
  them, moved together, each keeping its own floor (a landing a few steps down stays down).
  **Unjoin** separates them.
- **Stairs in 3D:** with a block picked, **Stairs** adds steps from its floor down to the block
  it's joined to (or the level below), sized from the drop. Tap stairs to pick them, drag them
  into place, and set where they lead, their width, tread, step height and steps.

## 0.3.0-dev.39

- **Solid view** (3D tool bar): a dollhouse with solid walls and floors and the roofs off, cut at
  the ceiling of the level you pick, so you see into its rooms. The ground is solid, and a
  basement is a pit lined by its own walls. Each light that's on lights a pool of its own
  colour on the floor, as bright as it is now.

## 0.3.0-dev.38

- **Blocks meet face to face:** a moved block stops against the next instead of going into it,
  and a dragged face stops at the next block. Two blocks that touch share that face: drag it (or
  type Out/In) and both change, one growing as the other shrinks. Alt still drags freely.

## 0.3.0-dev.37

- **3D, easier to read:** each level's floor lies only under its own blocks (no more basement
  square sticking out in front of the house). Picking a block hides everything above it, so you
  can see in. **Dimensions** in the tool bar labels every block's size, **Inside** (less the
  walls, as a tape reads) or **Overall**.
- The **Levels** pane shows names and how many of each level's lights are placed, not heights.

## 0.3.0-dev.36

- **Paths, driveways and patios in 3D** (Shape): add one from the tool bar, tap one to pick it,
  drag it to move it or its corners to shape it, type its size, delete it. Ctrl+click two and
  **Merge**: paths whose ends meet become one walkway with a square corner (an L); other shapes
  become one shape with no seam. **Split apart** undoes a merge. The Top view draws merged
  shapes the same way.

## 0.3.0-dev.35

- **Views** is off the left menu: the House map's Front photo and Top view do its job. It still
  opens from the **Views** button on **Map with camera**, which maps into a view.

## 0.3.0-dev.34

- **Pick several, copy and paste** (Top view): Ctrl+click picks several walls, rooms, stairs or
  yard shapes; drag them together or delete them. Ctrl+C, Ctrl+X and Ctrl+V copy, cut and paste
  onto the level shown in the same place, so a stack of walls copies from one floor to the next
  (doorways come too). Ctrl+A picks everything on the level, Ctrl+D duplicates, Esc lets go. The
  panel has buttons for the same, and **Copy to** a level.

## 0.3.0-dev.33

- **Windows follow their wall in 3D:** a window or door sits on the front wall of the block it's
  in, matched across and up as on the front photo (before, only across, so with blocks one over
  another it could land on the wrong wall). Push that wall back and it goes too.
- **Move windows and doors in 3D:** in Shape, tap one to pick it, then drag it along its wall or
  type its width, height, position and sill. It's saved to the front photo's drawing.

## 0.3.0-dev.32

- **How far from, fixed:** the list only has walls that face the picked wall (alongside it for
  part of its length), and picking a wall starts on the nearest one. Before, a wall chosen for
  the last wall you picked stayed chosen.

## 0.3.0-dev.31

- **Fractions of an inch:** type lengths as `9'5 1/4"`, `9'5.25"`, `9' 5-1/4"` or `5 1/4"`.
  Lengths show to the nearest 1/16" (`9' 5 1/4"`) instead of the nearest inch.

## 0.3.0-dev.30

- **Measure across** (Top view): tap the walls in the order you measured them across a level,
  type each tape measurement (face to face), and **Place the walls** puts each wall where you
  measured it; walls that met a moved wall follow it. When the chain runs from one outside wall
  to the other and the total disagrees with the plan, **Rescale to fit** sets the top view's
  scale from your tape, showing the house's new depth and roofline first.

## 0.3.0-dev.29

- **Measuring walls, like a blueprint:** a picked wall's "How far from" list says where each wall
  is and how far, nearest first, numbered to match tags on the plan. The chosen wall shows in
  blue with a dimension line from face to face. **Pick on the plan** chooses one by tapping it.

## 0.3.0-dev.28

- **Stairs on both levels:** stairs drawn on one level show on the plan of the level they lead
  to as well, going the other way (DOWN where the first says UP). Picking them there edits the
  same stairs.

## 0.3.0-dev.27

- **Dragging a whole wall snaps:** with Select, drag a wall by its middle and whichever end comes
  near another wall's end, an inside corner, or onto a wall across its way, takes the wall there
  (same length, same way round). Alt drags it freely.

## 0.3.0-dev.26

- **Stairs you can size:** type the width, tread depth, step height and number of steps (not
  counting a landing or the floor at the top), or drag the handles on picked stairs (the ends
  move a step at a time). The Top view and 3D draw that many steps at that height. If the steps
  don't add up to the gap between the levels, the panel says so and offers **Fit the step
  height**.

## 0.3.0-dev.25

- **Walls snap at any zoom:** zoomed in, an end dropped anywhere on another wall's body snaps to
  its centre line (the snap reach was a fixed 12 pixels, less than a wall's width up close).
- **Clean corners:** a wall ending near another wall's end, or a corner of the outside walls,
  slides sideways onto it (by up to two wall thicknesses), so the two meet square instead of one
  overhanging. Dragging a wall's end onto a corner does the same.

## 0.3.0-dev.24

- Fixed: the 3D view stopped drawing (no house, no lights, no view cube) once a level had stairs
  drawn in the Top view.

## 0.3.0-dev.23

- **House map, CAD-style layout:** the tools for the view shown sit in a tool bar across the top
  (3D: Move, Raise, Shape, Add block, Split, Aim, Home/Front/Top/Side views and the level shown;
  the photo tabs: their drawing tools). A rail on the left opens Lights, Levels, Rooms, House
  blocks and Yard, and folds away to icons. The picked thing's settings are on the right; with
  nothing picked in 3D the view takes the room.
- The view tabs moved to the top bar. A stray "null" after Things to check is gone.

## 0.3.0-dev.22

- **Moving blocks in 3D:** drag a block across the ground; **Shift+drag** moves it up and down;
  red, green and blue arrows at its corner move it across, back or up only; **Move by** takes
  typed amounts. The distance shows as you drag. **Alt** turns snapping off.
- Shift with the left button no longer slides the view (the right button and the wheel do).

## 0.3.0-dev.21

- **Add blocks in 3D:** in Shape, **Add a block** (or beside the picked one). Drag it to move it,
  and its handles (all six faces now, the bottom too) to size it. Faces snap flush to other
  blocks' faces as they come within 6". **Delete** removes one.

## 0.3.0-dev.20

- **Walls join cleanly:** ends snap to other walls' ends and the outside walls' inside corners,
  or onto another wall (a T), with a ring to show it; corners fill in. A drag that starts at a
  wall's end draws a new wall from it.
- **Angled walls:** tick Angled; the start stays put and the end goes anywhere (still snapping).
- **Move a floor plan:** **Move this plan to** another level, and **Move the whole plan** to drag
  it into place; a wall's level is in its panel too.
- **Stairs** on the floor plan, with treads and an UP or DOWN arrow, and as steps in 3D.
- **3D Shape:** the front of any block moves too (its front wall is then set back or sticks out).
- The top view's toolbar no longer makes the page scroll on shorter windows.

## 0.3.0-dev.19

- **Things to check moved to the top bar:** an alert triangle with how many; tap it for the
  list. The view gets the space back.

## 0.3.0-dev.18

- **View cube** at the top right of the 3D view, with X, Y and Z: click a face, an edge or a
  corner to turn the view there; ⌂ goes back to the usual view. (Replaces the 3D, Top and Front
  buttons.)
- **Shape the house in 3D:** pick a block, drag the handles on its sides, back and top (the
  distance shows as you drag), or move a face out or in by a typed amount.
- **Split a block front to back:** the back part gets its own depth, top, level and floor, for a
  lower back entrance behind the front entry and the like.
- Moving the leftmost block no longer shifts the house's left edge (and what's placed by it).

## 0.3.0-dev.17

- **Square walls from above:** the roof outline (and so the outside walls) is squared to the
  house, turning the photo the fraction of a degree it was off so they still line up. Corners snap
  square while tracing; **Square it up** does it again after hand changes.
- **3D: paths, driveways and curved shapes lie flat** on the ground from any angle (paths were a
  thick line on the screen that turned with the view).

## 0.3.0-dev.16

- **Several fixtures on one switch:** tick **Multiple fixtures on this switch** on a light (cans
  on one dimmer), say how many, and place each one. They're joined by a dashed line in 3D and from
  above; the light sits in the middle of them.
- **Under cabinet** lights default to 54" (a 36" counter, 18" above it).

## 0.3.0-dev.15

- **3D: slide the view.** Drag with the right mouse button or the wheel (or Shift and the left
  button, or two fingers) to move the view, so it doesn't always turn round the middle of the
  house. **3D**, **Top** and **Front** put it back.

## 0.3.0-dev.14

- **3D: tap off a light to let go of it.** Tapping anywhere else no longer moves a light that's
  already placed; drag it to move it. A light not placed yet still goes where you tap.

## 0.3.0-dev.13

- **Floods and spots, from the light's panel:** **Its light** is All around, Flood, Spot or Half
  (a wall light), with sliders for the beam width, how far it points up or down, and which way
  it's turned.
- **Aim at something:** **Aim at something in 3D**, then click the wall, ground or tree it
  should light; or **Aim from above** and tap the ground or a tree (its canopy, for an uplight).
  It stays pointed there when the light is moved. A dashed line and a ring show where the beam
  lands.

## 0.3.0-dev.12

- **The House map fits the window** on a big screen: no page scrollbar, no zooming out. The
  light list and the panel scroll inside themselves; the view takes the rest. On the Front photo
  and Top view the editor's own panel replaces the page's, so the photo gets the room.
  **Things to check** folds to one line (the first item shown) until opened.
- **Plan & side removed:** the Top view and 3D cover it.
- **Guessed floors** are drawn dashed in 3D and labelled "(guessed)" until a floor line or a
  block sets them.

## 0.3.0-dev.11

- **Roof edge lines fixed:** they were measured on the wall while being drawn, then shown at the
  eaves, so a finished line jumped up and came out longer, and the roofline read about 4% too
  long. Lines drawn before are moved to the eaves, staying where they were drawn on the photo.
- **Roof edge lines are two taps:** one end, then the other. Tap a line to add a bend where the
  edge isn't straight, and drag its points to fit.

## 0.3.0-dev.10

- **Things to check:** the House map lists, in plain words, numbers that don't agree and what's
  being guessed: the roof measuring differently from the front and from above, a front-to-back
  check that's off, floors out of order, low ceilings, guessed floors, an inside light outside
  the walls, a wall outside the house, a door too small in the photo, a photo taken from far to
  the side, a tilted ground line. Each has **Show me**.
- Docs for the front photo's camera, the top view, floor plans, aiming and the checks.

## 0.3.0-dev.9

- **Top view.** Add a satellite or drone photo from above (a map screenshot works):
  - **Square up:** drag along any straight wall or roof edge; **Turn** until the street is at
    the bottom.
  - **Scale from the roofline:** trace the front roof edge end to end; the front photo's
    roofline sets the scale (or type the length). **Check front to back** with a second line
    and a known length: a disagreement over 3% is pointed out.
  - **Roof outline:** trace it; the outside walls are drawn the eaves' depth inside it, as
    thick as their build (2x4, 2x6 or 2x8), and set how deep the house is.
- **Yard:** paths (with a width), driveways, patios, pools, garden beds and lawns (straight or
  curved), trees and bushes (round, with a height). Shown on the ground in 3D.
- **Floor plans:** draw a level's walls (kept square to the house), then type how far each is
  from an outside wall or another wall, face to face; walls are 2x4, 2x6 or 2x8 with drywall or
  plaster. Doorways and room names (tied to Home Assistant's areas). Walls show in 3D.
- **Aim lights:** a light can be a flood, a spot, a half (wall light) or all around. From
  above, drag its arrow to point it and the edge of its beam to widen it; tilt it from
  straight down to straight up. Its beam shows as a cone in 3D.
- **Place lights from above**, on a level or outside.

## 0.3.0-dev.8

- **Front photo, measured properly off the door's plane.** The camera is worked out from the
  door (its lens too, when the photo has enough perspective), so every wall is measured on its
  own plane:
  - **Set back into the wall by:** a recessed front door no longer makes the front wall measure
    a few percent too big.
  - **Its front wall** on each house block: in line, sticks out (an overhang), set back, or
    follows the ground line.
- **Ground line with bends.** Tap one end of the house, then the other; tap the line to add a
  bend where the front steps in or out, and drag it onto the corner. Each bend says how far back
  or out it is, and the front of the house follows it in 3D.
- **Roof edge lines:** trace each roof level's bottom edge; the roofline across (overlaps counted
  once) is shown, ready for the top view.
- **Eaves:** how far the eaves stick out (24" unless changed). New light place **Under the
  eaves**.
- **Spaces inside a level:** a block can be part of a level with its own floor, higher or lower
  (a landing, a storage room over the entry), drawn as its own floor in 3D. Lights placed on it
  from the photo go on that level.

## 0.3.0-dev.7

- **Roofs are their own shapes.** Draw any number, each as its outline seen from the street (any
  shape: off-centre peaks, porch overhangs, dormers), and say how it goes back: slopes to a ridge
  (or a hip), the same shape all the way back, or one slope. Each has its depth, ridge distance
  and set-back (or how far it sticks out). Roofs drawn on blocks before are carried over.
- **Floor thickness:** a floor line marks the floor, or the ceiling under it (then the floor is
  12" higher, or whatever **Floors are … thick** says). Ceilings come from the floor drawn above.
- **Basements:** a house block can go into the ground by a set depth, and its bottom can be a
  floor. The 3D view shows it going down through a hole in the ground.
- **House map list:** levels fold away (remembered) and show how many lights are placed; picking
  a light no longer scrolls the list or the page back to the top.

## 0.3.0-dev.6

- **Floors you haven't set follow the ones you have.** Drawing floor lines for some levels on the
  front photo (or setting their heights) now moves the others to match: between two set floors
  evenly, beyond them at the same step. Before, they stayed where the first guess put them, with
  Main at ground level, so the Ground Level showed far under the ground.

## 0.3.0-dev.5

- **Animations: sweep.** Colour travels from one end of the house to the other, by where each
  light is on the house map (only placed lights join in). Wipe (each pass paints the next colour
  across) or band (a band of colour over a dim glow); left to right, right to left, back and
  forth, house to street, or bottom to top; seconds per pass, band width, brightness. A WLED strip
  whose LEDs are placed is swept LED by LED. Play it, or save it as a show.
- **A new palette or show replaces the one before** on the same lights, instead of stacking on
  it. Stopping it still puts the lights back as they were.

## 0.3.0-dev.4

- **White only lights:** mark a light whose bulbs only give white (the pathway's white LEDs) on
  its page. Palettes leave it alone unless **Include white lights** is ticked next to **Play on**.
- **WLED segments that interleave** (white and RGB LEDs alternating, with spacing) are read
  right: the house map labels each LED with its segment, and flashing one LED lights that LED.
- **Halloween palette:** purple and deep orange, each light fading into the next colour over 3-9 s
  at random.

## 0.3.0-dev.3

- **Front photo:** measure the house from a photo of its front. Box the front door (36" × 80" by
  default) and the perspective and scale follow. Drawing tools: front door, ground line, house
  blocks, roofs (gable or ridge), windows and doors, floor lines, place a light, measure; with
  select, pan and zoom, undo and redo, snapping, a magnifier and a scale bar. The blocks set the
  house width and the floor lines set each floor's height and span.
- **See-through house in 3D:** the drawn blocks, roofs and windows show around the floors and
  lights.

## 0.3.0-dev.2

- **House map in 3D:** the house as a volume you can turn and zoom. Each floor is a slab at its
  height, and each light an orb with a line down to its floor. Tap a light to pick it, tap the
  floor to place it, drag to move it, and drag up or down in **Raise** mode. **3D**, **Top** and
  **Front** reset the view. The flat plan and side views stay as a second tab.
- **Feet and inches:** sizes and heights follow Home Assistant's unit system (imperial here), or
  the choice under **Settings › Units**. Fields take `8' 6"`, `8 ft 6 in`, `102 in`, `2.6 m`, and
  the grid and snapping go by feet and inches.
- **Better first guess for floor heights:** nothing deeper than one storey below the ground; the
  levels below main share that depth, so split levels come out half a storey apart.

## 0.3.0-dev.1

A new UI, and the house map.

- **The UI is redesigned** after the Zigbee2MQTT frontend: a left menu, a top bar with the
  Home Assistant status and Stop all on every page, summary tiles and card grids, an HA-like dark
  theme (and a light one), and phone layouts.
- **New pages:**
  - **Overview:** what's on, what's playing, the drivers, each level, activity.
  - **Lights:** cards by level and room, fixtures, grouping, suggestions.
  - **Light detail:** capabilities, driver choice and timing, test with a fade, an effect and a
    hold time, effects on this light.
  - **Palettes & shows**, **Drivers**, **Activity** and **Settings** (appearance).
  - Views and camera mapping now sit in the same shell.
- **House map:** place every light in 3D by hand, no camera or floorplan needed.
  - Floors come from HA. You set each floor's height above the ground (split levels too), its
    ceiling, and which part of the house it covers.
  - Pick a light, tap where it is from above, and drag its height in the view from the street.
  - Mount types (ceiling, pendant, wall, floor lamp, tabletop, under cabinet, strip, path or
    post, in the ground) set the height.
  - Segmented lights stay one light, and their parts can be placed one by one or along a line:
    WLED LEDs (a device's segment lights fold into its main light) and Govee segments.
  - **Flash** identifies a light, a fixture or one part. WLED LEDs flash through realtime
    frames, Govee segments through their own entities, and everything is put back.
- Cards show brightness, colour temperature and effect (`look` in the inventory API).

## 0.2.0-dev.3

From the first checks on the real lights (docs/driver-tests.md):
- **Z-Wave:** a dimmer that misses a multicast (multicast isn't routed, so a node out of the
  stick's direct range never hears it) is corrected by unicast as before, and from then on gets
  unicast; the others keep sharing a multicast. Shown as `unicast_only` in the driver status.
- **Safety:** while a command is still settling (latency, the driver's read-back, 1 s), a report
  that disagrees is the device catching up, not a person. Before, the missed multicast's
  read-back got the hallway dimmer dropped and left unrestored. During the rest of a fade only an
  on/off flip counts as a person.

## 0.2.0-dev.2

The first build with direct drivers, the show engine core, and views with camera mapping
together. None of them has been tried on the real lights yet.

- Camera mapping keeps each measured latency with the driver it was measured through; a light
  that later uses another driver keeps that driver's default.

### Direct drivers (phase 2)

Phase 2: direct drivers. Not yet tried on real lights (see docs/driver-tests.md).

- **Drivers:** Zigbee2MQTT over MQTT (device names from z2m, groups for simultaneous changes),
  Z-Wave JS server (fade durations where the dimmer supports them, multicast by security class
  with read-back), WiZ over UDP (subnet sweep, MAC match, scenes), WLED (JSON API, effects and
  palettes, DDP streaming), Govee LAN (unicast and multicast scan, `devStatus`; segment streaming
  off until tested per model). Home Assistant stays the fallback for every light.
- Each light uses the best driver that can reach it, shown as a **via …** badge; pin a light to
  Home Assistant or its direct driver from the **Driver** select. A driver status line under the
  counts.
- Rate governor: budgets follow the network a command really uses; a Z-Wave multicast or a z2m
  group message counts as one; latest value still wins for every light of a batch.
- Fixtures are tested with one multicast or group message where their lights allow it.
- The Test API takes a fade, an effect and a hold time, for checking drivers.
- Add-on: `host_network: true`, `services: [mqtt:need]`, options `drivers`, `wiz_subnets`,
  `govee_subnets`, `govee_razer_models`, `z2m_base_topic`, `zwave_url`.

### Show engine core (phase 3)

The show engine core (phase 3).

- **Colour:** OKLab blending; each light gets what it can show: xy, hs, rgb, rgbw, rgbww, the
  nearest white temperature for white-only lights, a level for dimmers, on/off for relays.
- **Engine:** a 20 Hz tick composes layers per light (fixtures as one). The planner sends one
  fade per change to lights that can fade, steps for those that can't, averages fast content for
  slow lights (Z-Wave, Govee cloud), sends nothing for invisible changes, keeps within every
  network's budget, and sends early by each light's latency.
- **Layers:** static, palette (per-light random walk, seeded), native effect, software effect
  (flicker, candle, breathe, lightning), dip (back to each light's own level), flash (at most
  3 per second). Shows overlap by priority; `on_end` restore, fade or hold.
- **Effects:** normalised names resolved per integration from `effects/*.yaml` against each
  light's effect list: native, close, software, then the key colour.
- **Palettes and shows** as YAML in `/config`, with seven starter palettes.
- **API:** play, stop and list palettes and shows; `GET /api/running`. A small Palettes panel on
  the lights page.
- New dependency: PyYAML.

### Views and camera mapping (phase 5)

Phase 5: views and camera mapping.

- **Views:** a photo of the house per viewpoint, with lights and fixtures placed on it. Place by
  hand (tap a light, tap the photo, drag to move), or map with the phone camera; both make the
  same elements. Segmented lights and several lights in a row can be spread along a drawn line.
- **Planes:** mark the lawn or the house front with four taps and an optional real size; lights
  on a plane get positions in metres on it.
- **Map with the camera:** pick what's visible, then the app leads three stations (centre, about
  45° left, about 45° right) with a steadiness meter and compass guidance. At each station it
  takes a reference, blinks a sync light, inverts one light (or fixture) at a time and moves on as
  soon as the change has settled, retakes jolted steps with a single revert, and puts every light
  back. Frames, motion and the command log are saved under `/config/mapping/sessions` and
  analysed in the add-on (OpenCV): regions, latency, grouping (one window = one element, a long
  window = segments), 3D positions from the three stations.
- **Review:** the results go onto the view: outlines on the photo; merge, split, reorder,
  rename, assign planes. Measured latencies replace the profile defaults.
- Record-and-upload fallback when the live camera doesn't work in the HA app.
- Stop all ends a capture and restores; nothing is flashed in read-only mode.
- New dependencies: numpy, opencv-python-headless, websockets (the image grows by about 220 MB).

## 0.1.0-dev.3

- Levels and rooms fold (tap a heading), with Collapse all / Expand all, remembered per device.
- **Fixtures:** group lights that share one physical fixture (the two office fan bulbs). A fixture
  is tested as one (all its lights on, off, restored together) and will be mapped as one.
  Suggestions for numbered lights of one model in one room; Group lights, Rename, Ungroup.
- Messages show in the page instead of browser pop-ups (which the HA app may not show).

## 0.1.0-dev.2

- Fix: the add-on couldn't find `SUPERVISOR_TOKEN` under s6-overlay's init and stopped.
  `run.sh` now runs under `with-contenv`, and the token is also read from s6's container
  environment. Running as an add-on without a token now stops with a clear error instead of
  falling back to development settings.

## 0.1.0-dev.1

Phase 1, first build.

- Inventory from HA: floors (plus "Outside / no floor"), areas, lights; default exclusions with
  reasons; switches opt-in; Govee segments folded under their light; light-device settings
  recognised; duplicates across integrations suggested.
- Profiles from HA attributes and Z-Wave node details (command class versions, security,
  dead nodes); per-network defaults for rate and latency.
- HA driver with a rate governor (per light, per network, latest value wins).
- Snapshots before every change, restore on finish, Stop all, restore after a crash; lights
  changed outside Luminorium are dropped, not overwritten.
- Ingress web UI: lights by floor and area, include/exclude, Test button, activity; phone
  camera check page.
