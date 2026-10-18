# The web UI

Served through HA Ingress, so every URL is relative, and in the add-on only the Supervisor's
ingress proxy may connect. The design was agreed on a Claude Design canvas ("Luminorium UI
redesign"), modelled on the Zigbee2MQTT frontend: a fixed left menu, summary tiles, card grids,
and an HA-like dark theme with a light one.

There is no build step: plain HTML, CSS and JavaScript in `web/static/`.

## Structure

| File | What |
|---|---|
| `style.css` | The theme as CSS variables (dark default; light under `prefers-color-scheme`, or forced from Settings with `data-theme`), plus the components: shell, buttons, pills, badges, cards, tiles, light cards, palette cards, the house map grid, and the class names the Views and camera pages use |
| `shell.js` | Runs first on every page. Builds the menu and the top bar (title, status pill, read-only pill, **Stop all**) and moves the page's content into `<main id="page">`. Provides `window.L` (below) and polls `api/status` (and `api/inventory` when a page asks) |
| `pages/*.js` | One script per page: `overview`, `lights`, `light`, `palettes`, `house`, `drivers`, `activity`, `settings`. The house map also loads `house3d.js` (the 3D view), `facade.js` (the front photo editor) and `site.js` (the top view; it uses `facade.js`'s drawing helpers) |
| `views.html` + `views.js`, `capture.html` + `capture.js`, `camera.html` | The Views editor, camera mapping and the camera check: their own HTML, loading the same shell (`data-legacy`; `data-own-stop` when the page binds Stop all itself) |
| `spatial.css` | Extra styles for the Views and camera pages |

The server (`web/server.py`) generates the HTML for the shell pages: `/`, `/lights`, `/light`,
`/palettes`, `/house`, `/drivers`, `/activity`, `/settings`. Each loads `style.css`, `shell.js`
and its own `pages/<name>.js`, versioned so an update isn't hidden by the browser cache.

## `window.L`

- `el(spec, attrs, ...children)`: an element builder. `spec` is `"tag.class#id"`; `attrs` takes
  `on: {event: fn}`, `style: {…}` and any attribute.
- `icon(name, size)`: an inline stroke icon.
- `set(node, ...children)`: `replaceChildren`, skipping `null` and `false` (optional sections).
- `api(path, {method, body})`: JSON in and out; throws with the server's `detail`.
- `run(fn)`: runs an action and shows any error as a toast.
- `toast(message)`.
- `onData(fn, {inventory})`, `start(ms)`, `refresh(force)`: polling. While someone is typing in
  the page, re-rendering waits.
- `store(key, default)`, `save(key, value)`: per-browser settings, kept in `localStorage` (and
  harmless when it's unavailable).
- Light helpers: `stateText`, `lightIcon`, `colorHex` (palette colours, kelvin included), and
  the names in `INTEGRATION` and `DRIVER`.
- Lengths: `units()` (`imperial` or `metric`: the Settings choice, else HA's unit system from
  `api/status`), `fmtLen(metres)` (`7' 10"` or `2.40 m`), `parseLen(text)` (feet and inches,
  inches, metres or centimetres, or a bare number in the current unit), `snapLen` (an inch or 5 cm).

No `alert()`, `confirm()` or `prompt()`, which the HA companion app's webview may not show.
Errors go to toasts, and names are typed inline.

## Pages

| Page | What |
|---|---|
| **Overview** | Summary tiles (lights, on now, fixtures, playing, drivers), now playing with quick play, the drivers, each level's lights and how many are on, recent activity |
| **Lights** | Search; filters (included, switches, excluded, all); levels and rooms that fold (remembered); fixture suggestions; **Group lights** mode; a card per light or fixture with state, driver and latency, capabilities, warnings, an include checkbox, **Test** and **Details** |
| **Light** (`light?id=…` or `light?fixture=…`) | What it can do; driver choice (Automatic or a pinned driver) and timing; **Test with options** (fade, effect, hold); its place on the house map and its fixture; Home Assistant ids; what each effect name becomes on it |
| **Palettes & shows** | Playing now, with Stop; tabs for Palettes (a **Play on** target: every light, a level or a room; **Include white lights**), Animations (a sweep: colours from a palette or picked, wipe or band, direction, seconds per pass, band width, brightness, a moving preview; **Play** or **Save as a show**), Shows and Effects |
| **House map** | Placing lights in 3D: **Things to check**, a volumetric view, the front photo and the top view with their drawing tools, in a CAD-style layout (a tool bar across the top for the view shown, a rail of panes on the left, the picked thing's settings on the right); the page fills the window on a big screen ([house.md](house.md)) |
| **Map with camera** | The guided camera capture ([mapping.md](mapping.md)). The older photo views editor (**Views**) is off the menu since 0.3.0-dev.35 (the House map's Front photo and Top view do its job); it opens from the **Views** button here, to make the view a capture maps into |
| **Drivers** | A card per driver: status, endpoint, counts, notes (Z-Wave nodes on unicast, Govee LAN Control) and how many lights use it |
| **Activity** | The latest 30 events |
| **Settings** | Version and mode, units (as in Home Assistant, feet and inches, metres), appearance (match the device, dark, light), the camera check, where files live |

## Phones

Below 820 px the menu folds behind a button, and cards and tiles reflow. The house map stacks
its views, then the panel, then the list. Buttons and fields are at least 44 px high.
