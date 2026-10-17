// House map: place every light in 3D by hand, in the 3D view, on the front photo, or from above
// (the top view). Floors come from HA; the house is measured from the photos, or a box of your size.
"use strict";

(function () {
  const { el, icon, api, run, toast, onData, start } = L;
  const page = document.getElementById("page");
  const params = new URLSearchParams(location.search);

  const ui = {
    sel: params.get("select") || null, // target id
    part: null,                         // selected part index of the selected target
    floor: null,                        // floor shown in 3D
    mode: null,                         // null | "line-start" | "line-end"
    lineStart: null,
    search: "",
    settings: false,
    drag: null,
    view: ["3d", "photo", "top"].includes(L.store("house.view", "3d")) ? L.store("house.view", "3d") : "3d", // "3d" | "photo" | "top"
    mode3d: "move",                     // "move" | "raise" in the 3D view
    folded: new Set(L.store("house.folded", [])), // levels folded away in the list
  };
  let house = null;
  let inventory = null;
  let status = null;

  // ---- data --------------------------------------------------------------------------------

  async function load() {
    const [h, inv] = await Promise.all([api("api/house"), api("api/inventory")]);
    house = h;
    inventory = inv;
    if (!ui.floor) ui.floor = defaultFloor();
  }
  const target = (id) => house.targets.find((t) => t.id === id) || null;
  const floorsById = () => new Map(house.floors.map((f) => [f.id, f]));
  function floorOfTarget(t) {
    if (t.item) return t.item.floor;
    if (floorsById().has(t.floor_id)) return t.floor_id;
    return t.floor_id === "_no_floor" ? house.outside : ui.floor;
  }
  function defaultFloor() {
    const t = ui.sel && target(ui.sel);
    if (t) return floorOfTarget(t);
    return house.floors.find((f) => /main/i.test(f.name))?.id || house.floors[0]?.id || house.outside;
  }
  function floorName(id) {
    return id === house.outside ? "Outside" : floorsById().get(id)?.name || id;
  }
  function floorZ(id) { return id === house.outside ? 0 : floorsById().get(id)?.elevation ?? 0; }
  function ceilingOf(id) { return id === house.outside ? 6 : floorsById().get(id)?.ceiling ?? 2.4; }

  const r2 = (v) => L.snapLen(v); // a whole inch, or 5 cm

  async function lineClick(at) {
    if (ui.mode === "line-start") { ui.lineStart = at; ui.mode = "line-end"; paint(); toast("Now tap where the last one is"); return; }
    const t = target(ui.sel);
    const h = t.item ? t.item.h : 0.5;
    ui.mode = null;
    await run(async () => {
      const r = await api(`api/house/items/${encodeURIComponent(t.id)}/line`, { method: "POST",
        body: { start: { ...ui.lineStart, h }, end: { ...at, h } } });
      toast(`${r.placed} parts spread along the line`);
    });
    ui.lineStart = null;
    await reload();
  }

  // ---- the 3D view -----------------------------------------------------------------------------

  let canvas3d = null;
  let view3d = null;
  function scene3d() {
    const tops = house.floors.map((f) => f.elevation + f.ceiling);
    const bottoms = house.floors.map((f) => f.elevation);
    const lights = house.targets.filter((t) => t.world).map((t) => {
      const sel = t.id === ui.sel;
      const here = t.item.floor === ui.floor || t.item.floor === house.outside;
      return {
        id: t.id, label: t.name, x: t.world.x, y: t.world.y, z: t.world.z, floorZ: floorZ(t.item.floor), aim: t.item.aim || null, floor: t.item.floor,
        on: t.state === "on", sel, dim: !here && !sel,
        parts: t.parts.filter((p) => p.world).map((p) => ({ index: p.index, x: p.world.x, y: p.world.y, z: p.world.z, sel: sel && ui.part === p.index })),
      };
    });
    const m = house.massing;
    const peaks = m ? [...m.blocks.map((b) => b.z1), ...(m.roofs || []).flatMap((r) => r.pts.map((q) => q[1]))] : [];
    return {
      W: house.size.width, D: Math.max(house.size.depth, ...(m ? m.blocks.map((b) => (b.y0 || 0) + b.depth) : [])),
      zMin: Math.min(0, ...bottoms, ...(m ? m.blocks.map((b) => b.z0) : [])), zMax: Math.max(2.5, ...tops, ...peaks),
      massing: m,
      top: house.top,
      floors: house.floors.map((f) => ({ ...f, active: f.id === ui.floor, label: L.fmtLen(f.elevation, { signed: true }) })),
      lights, grid: L.units() === "imperial" ? L.FT : 1,
      placeZ: floorZ(ui.floor), selPart: ui.part, labels: false,
    };
  }
  function ensure3d() {
    if (view3d) return;
    canvas3d = el("canvas", { "aria-label": "The house in 3D: floors and lights", role: "img",
      class: "hm-canvas", style: { width: "100%", display: "block", borderRadius: "10px", cursor: "grab" } });
    view3d = new window.House3D(canvas3d, {
      onPick: (id, part) => { const t = target(id); ui.sel = id; ui.part = part; if (t && part === null) ui.floor = floorOfTarget(t); paint(); },
      onPlace: async (x, y) => {
        const at = { x: r2(x), y: r2(y) };
        if (ui.mode) return lineClick(at);
        if (!ui.sel) { toast("Pick a light first, from the list or by tapping it"); return; }
        const t = target(ui.sel);
        if (ui.part !== null && t.item) await placePart(ui.part, at);
        else await placeItem({ ...at, floor: t.item ? t.item.floor : ui.floor });
      },
      onMove: async (id, part, x, y, done) => {
        const t = target(id);
        const at = { x: r2(x), y: r2(y) };
        if (part === null) { t.item.x = at.x; t.item.y = at.y; t.world.x = at.x; t.world.y = at.y; }
        else { const p = t.parts.find((q) => q.index === part); p.world.x = at.x; p.world.y = at.y; }
        view3d.setScene(scene3d());
        if (done) { if (part === null) await placeItem(at); else await placePart(part, at); }
      },
      onAimAt: async (point, what) => {
        const t = target(ui.sel);
        if (!t || !t.item) return;
        const aim = t.item.aim || { kind: "flood", beam: 90, tilt: 0, heading: 0 };
        ui.aiming = false;
        await aimLight(t.id, { kind: aim.kind, beam: aim.beam, tilt: aim.tilt, heading: aim.heading, at: point, what });
        toast(`${t.name} now points at ${what}`);
      },
      onRaise: async (id, h, done) => {
        const t = target(id);
        const hh = Math.min(ceilingOf(t.item.floor), r2(h));
        t.item.h = hh; t.world.z = floorZ(t.item.floor) + hh;
        view3d.setScene(scene3d());
        if (done) await placeItem({ h: hh });
      },
    });
  }

  // ---- actions --------------------------------------------------------------------------------

  async function placeItem(change) {
    const t = target(ui.sel);
    if (!t) return;
    const cur = t.item || {};
    const floor = change.floor ?? cur.floor ?? floorOfTarget(t);
    await run(() => api(`api/house/items/${encodeURIComponent(t.id)}`, { method: "PUT", body: {
      floor, x: change.x ?? cur.x ?? house.size.width / 2, y: change.y ?? cur.y ?? house.size.depth / 2,
      h: "h" in change ? change.h : change.mount ? null : cur.h ?? null, mount: change.mount ?? cur.mount ?? null } }));
    await reload();
  }
  async function placePart(index, at) {
    const t = target(ui.sel);
    await run(() => api(`api/house/items/${encodeURIComponent(t.id)}/parts/${index}`, { method: "PUT", body: { x: at.x, y: at.y } }));
    await reload();
  }
  async function identify(part) {
    const t = target(ui.sel);
    await run(async () => {
      await api("api/house/identify", { method: "POST", body: { target: t.id, part } });
      toast(part === undefined || part === null ? `Flashing ${t.name}` : `Flashing part ${part + 1} of ${t.name}`);
    });
  }
  async function removeItem() {
    const t = target(ui.sel);
    await run(() => api(`api/house/items/${encodeURIComponent(t.id)}`, { method: "DELETE" }));
    await reload();
  }
  async function saveSettings(form) {
    // Every field is a length in the user's units; empty "covers" fields mean the whole width
    const bad = [];
    const len = (name, optional = false) => {
      const input = form.querySelector(`[name="${name}"]`);
      if (optional && !input.value.trim()) return null;
      const v = L.parseLen(input.value);
      if (Number.isNaN(v)) bad.push(input.value || "(empty)");
      return v;
    };
    const floors = {};
    for (const f of house.floors) {
      floors[f.id] = { elevation: len(`${f.id}.elevation`), ceiling: len(`${f.id}.ceiling`), x0: len(`${f.id}.x0`, true), x1: len(`${f.id}.x1`, true) };
    }
    const size = { width: len("width"), depth: len("depth") };
    if (bad.length) { toast(`Couldn't read ${bad.map((b) => `“${b}”`).join(", ")} as a length`); return false; }
    const ok = await run(async () => { await api("api/house/settings", { method: "PUT", body: { size, floors } }); toast("Saved"); return true; });
    await reload();
    return !!ok;
  }
  async function reload() { house = await api("api/house"); paint(); }

  // ---- the front photo ------------------------------------------------------------------------

  let facade = null;
  function ensureFacade() {
    if (facade) return;
    facade = new window.FacadeEditor({
      house: () => house,
      floors: () => house.floors,
      selection: () => ({ target: ui.sel ? target(ui.sel) : null, part: ui.part }),
      place: (x, z, where, wallY, block, eave) => placeFromPhoto(x, z, where, wallY, block, eave),
      // the drawing was saved: the house width and floor heights may have changed
      saved: (view) => { house = view; paintSide(); },
      changed: () => reload(),
    });
    facade.load(house.facade);
  }
  let site = null;
  function ensureSite() {
    if (site) return;
    site = new window.SiteEditor({
      house: () => house,
      floors: () => house.floors,
      areas: () => inventory.areas,
      selection: () => ({ target: ui.sel ? target(ui.sel) : null, part: ui.part }),
      select: (id) => { ui.sel = id; ui.part = null; const t = target(id); if (t) ui.floor = floorOfTarget(t); paintSide(); },
      place: (x, y, level) => placeFromAbove(x, y, level),
      aim: (id, aim) => aimLight(id, aim),
      saved: (view) => { house = view; paintSide(); if (site) site.render(); },
      changed: () => reload(),
    });
    site.load(house.site);
  }
  // A tap on the top view: across and back, on a level (or outside)
  async function placeFromAbove(x, y, level) {
    const t = target(ui.sel);
    if (!t) return;
    if (ui.part !== null && t.item) {
      await run(() => api(`api/house/items/${encodeURIComponent(t.id)}/parts/${ui.part}`, { method: "PUT", body: { x, y } }));
      await reload();
      return;
    }
    const floor = level && (level === house.outside || floorsById().has(level)) ? level : floorOfTarget(t);
    ui.floor = floor;
    await placeItem({ x, y, floor, ...(t.item && t.item.floor === floor ? {} : { h: null, mount: t.item?.mount || (floor === house.outside ? "post" : "ceiling") }) });
    toast(`${t.name}: ${floorName(floor)}`);
  }
  async function aimLight(id, aim) {
    await run(() => api(`api/house/items/${encodeURIComponent(id)}/aim`, { method: "PUT", body: aim }));
    house = await api("api/house");
    if (site) { site.render(); site.paintInspector(); }
    paint();
  }

  // A tap on the photo: across (x) and height above the ground (z), in house metres
  // where: "inside" (by the window), "wall" (outside, on the wall) or "eave" (under the eaves);
  // wallY: how far back the wall tapped is; block: the house block tapped, if any
  async function placeFromPhoto(x, z, where, wallY = 0, block = null, eave = 0.6096) {
    const t = target(ui.sel);
    if (!t) return;
    const outside = where !== "inside";
    const y = where === "inside" ? wallY + 0.3 : where === "eave" ? wallY - eave / 2 : wallY - 0.15;
    const at = { x: r2(x), y: r2(y) };
    if (ui.part !== null && t.item) {
      const h = Math.max(0, r2(z - floorZ(t.item.floor)));
      await run(() => api(`api/house/items/${encodeURIComponent(t.id)}/parts/${ui.part}`, { method: "PUT", body: { ...at, h } }));
      await reload();
      return;
    }
    let floor = house.outside;
    if (!outside && block && block.level && floorsById().has(block.level)) floor = block.level;
    else if (!outside) {
      // the highest floor under the point, where that floor covers it
      const under = house.floors.filter((f) => (f.x0 == null || x >= f.x0 - 0.05) && (f.x1 == null || x <= f.x1 + 0.05) && f.elevation <= z + 0.05)
        .sort((a, b) => b.elevation - a.elevation)[0];
      floor = under ? under.id : floorOfTarget(t);
    }
    const h = Math.max(0, Math.min(outside ? 30 : ceilingOf(floor), r2(z - floorZ(floor))));
    ui.floor = floor;
    const mount = where === "eave" ? "soffit" : t.item?.mount && t.item.mount !== "soffit" ? t.item.mount : "wall";
    await placeItem({ ...at, floor, h, mount });
    toast(`${t.name}: ${floorName(floor)}, ${L.fmtLen(h)} up`);
  }

  // ---- things to check --------------------------------------------------------------------------

  ui.checksOpen = L.store("house.checksOpen", false);
  function checksCard() {
    const list = [...(house.checks || []), ...(facade ? facade.checks() : [])];
    if (!list.length) return null;
    const warns = list.filter((c) => c.level === "warn").length;
    const TAB = { photo: ["photo", "Front photo"], top: ["top", "Top view"], floors: [null, "Floors & size"] };
    const first = list.find((c) => c.level === "warn") || list[0];
    const go = (tab) => {
      if (tab === "floors") { ui.settings = true; paint(); return; }
      ui.view = TAB[tab][0]; L.save("house.view", ui.view); paint();
    };
    return el("section.card", { "aria-label": "Things to check", style: { padding: "12px 16px", gap: "8px", borderColor: warns ? "var(--warn-line)" : "var(--line)" } },
      el("button", { type: "button", "aria-expanded": String(ui.checksOpen), on: { click: () => { ui.checksOpen = !ui.checksOpen; L.save("house.checksOpen", ui.checksOpen); paint(); } },
        style: { display: "flex", alignItems: "center", gap: "8px", border: "0", background: "none", color: "var(--text)", padding: "0", cursor: "pointer", font: "inherit", textAlign: "left" } },
        el("span", { style: { display: "inline-flex", transform: ui.checksOpen ? "rotate(90deg)" : "none", transition: "transform .15s" } }, icon("chev", 14)),
        el("b", { style: { flex: "none" } }, warns ? `${warns} thing${warns === 1 ? "" : "s"} to check` : "Notes"),
        ui.checksOpen ? el("span.small.muted", list.length > warns ? `· ${list.length - warns} note${list.length - warns === 1 ? "" : "s"}` : "")
          : el("span.small.muted", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0" } }, `· ${first.text}`)),
      ui.checksOpen ? list.map((c) => el("div.row", { style: { gap: "10px", alignItems: "flex-start" } },
        el("span", { "aria-hidden": "true", style: { width: "10px", height: "10px", borderRadius: "50%", marginTop: "6px", flex: "none", background: c.level === "warn" ? "var(--warn, #e0a030)" : "var(--info, #5aa9e6)" } }),
        el("span", { style: { flex: "1" } }, c.text),
        TAB[c.tab] ? el("button.btn.small", { type: "button", on: { click: () => go(c.tab) } }, `Show me`) : null)) : null);
  }

  // ---- panels ---------------------------------------------------------------------------------

  function listPanel() {
    const areas = new Map(inventory.areas.map((a) => [a.id, a.name]));
    const groups = new Map();
    for (const t of house.targets) {
      if (ui.search && !t.name.toLowerCase().includes(ui.search)) continue;
      const key = floorsById().has(t.floor_id) ? t.floor_id : house.outside;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const order = [...house.floors.map((f) => f.id), house.outside].filter((k) => groups.has(k));
    return el("aside.card.hm-list", { "aria-label": "Lights to place", style: { padding: "14px", gap: "8px" } },
      el("label.search", { style: { flex: "none" } }, icon("search", 16), el("span.sr", "Find a light"),
        el("input", { type: "search", placeholder: "Find a light", value: ui.search, on: { input: (e) => { ui.search = e.target.value.toLowerCase(); paintList(); } } })),
      order.map((k) => {
        // A search shows every match, folded or not
        const folded = ui.folded.has(k) && !ui.search;
        const placedN = groups.get(k).filter((t) => t.placed).length;
        return el("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
        el("button", { type: "button", "aria-expanded": String(!folded), on: { click: () => {
          if (ui.folded.has(k)) ui.folded.delete(k); else ui.folded.add(k);
          L.save("house.folded", [...ui.folded]); paintList();
        } },
          style: { display: "flex", alignItems: "center", gap: "6px", width: "100%", minHeight: "36px", padding: "8px 4px 2px", border: "0", background: "none", cursor: "pointer",
            fontWeight: "600", letterSpacing: ".6px", textTransform: "uppercase", fontSize: "12px", color: "var(--muted)", textAlign: "left" } },
          el("span", { style: { display: "inline-flex", transition: "transform .15s", transform: folded ? "none" : "rotate(90deg)" } }, icon("chev", 14)),
          el("span", { style: { flex: "1" } }, floorName(k)),
          el("span", { style: { fontWeight: "500", letterSpacing: "0", textTransform: "none" } }, `${placedN}/${groups.get(k).length}`)),
        folded ? null : groups.get(k).map((t) => {
          const sel = t.id === ui.sel;
          return el("button", { type: "button", "aria-pressed": String(sel), on: { click: () => { ui.sel = t.id; ui.part = null; ui.floor = floorOfTarget(t); paint(); } },
            style: { display: "flex", alignItems: "center", gap: "10px", minHeight: "44px", padding: "4px 10px", borderRadius: "10px", textAlign: "left",
              border: `1px solid ${sel ? "var(--accent)" : "transparent"}`, background: sel ? "var(--accent-soft)" : "transparent", color: "var(--text)", cursor: "pointer" } },
            el("span", { style: { width: "10px", height: "10px", borderRadius: "50%", flex: "none", ...(t.placed ? { background: "var(--ok)" } : { border: "2px solid var(--faint)" }) } }),
            el("span", { style: { flex: "1", minWidth: "0", display: "flex", flexDirection: "column" } },
              el("span", t.name), el("span.small.muted", [areas.get(t.area_id), t.kind === "fixture" ? "fixture" : null, t.parts.length ? `${t.parts.length} parts` : null].filter(Boolean).join(" · "))));
        }));
      }));
  }

  function inspector() {
    const t = ui.sel && target(ui.sel);
    if (!t) return el("aside.card.hm-insp",
      el("h2", "Pick a light"), el("p.muted", { style: { margin: 0 } }, "Choose one on the left, then tap where it is: on the floor in 3D, on the Front photo, or from above in the Top view. In 3D, drag it to fine-tune, and use Raise to set its height."));
    const item = t.item;
    const floor = item ? item.floor : floorOfTarget(t);
    const ceil = ceilingOf(floor);
    const num = (label, key, value) => el("label.field", el("span", label),
      el("input", { type: "text", value: value === undefined || value === null ? "" : L.fmtLen(value), inputmode: "text", disabled: !item,
        "aria-label": label, autocomplete: "off",
        on: { change: (e) => {
          const v = L.parseLen(e.target.value);
          if (Number.isNaN(v)) { toast(`Couldn't read “${e.target.value}” as a length`); e.target.value = L.fmtLen(value); return; }
          placeItem({ [key]: v });
        } } }));
    const parts = t.parts.length ? el("section", { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
      el("div.card-head", el("h3", `Parts (${t.parts.length})`),
        el("button.btn.small", { type: "button", disabled: !item && false, "aria-pressed": String(!!ui.mode),
          on: { click: () => { ui.mode = ui.mode ? null : "line-start"; ui.lineStart = null; paint(); if (ui.mode) toast("In 3D, tap where the first one is"); } } },
          ui.mode ? "Cancel line" : "Lay out along a line")),
      el("span.small.muted", "Select a part, then tap where it goes in 3D or the Top view. Flash shows which one it is."),
      t.parts.map((p) => el("div.row", { style: { gap: "8px", padding: "6px 8px", borderRadius: "10px", flexWrap: "nowrap",
        background: ui.part === p.index ? "var(--accent-soft)" : "var(--card2)" } },
        el("button", { type: "button", "aria-pressed": String(ui.part === p.index), on: { click: () => { ui.part = ui.part === p.index ? null : p.index; paint(); } },
          style: { flex: "1", minWidth: "0", textAlign: "left", border: 0, background: "none", color: "var(--text)", cursor: "pointer", minHeight: "36px", display: "flex", alignItems: "center", gap: "8px" } },
          el("span", { style: { width: "8px", height: "8px", borderRadius: "50%", flex: "none", ...(p.placed ? { background: "var(--info)" } : { border: "2px solid var(--faint)" }) } }), p.label),
        el("button.btn.small", { type: "button", disabled: status?.read_only, on: { click: () => identify(p.index) } }, "Flash")))) : null;

    return el("aside.card.accent.hm-insp", { "aria-label": "Selected light" },
      el("div", el("h2", t.name), el("span.small.muted", [t.kind === "fixture" ? "Fixture" : L.INTEGRATION[t.integration] || t.integration, item ? `placed on ${floorName(item.floor)}` : "not placed yet"].join(" · "))),
      el("label.field", el("span", "Floor"),
        el("select", { on: { change: (e) => { ui.floor = e.target.value; if (item) placeItem({ floor: e.target.value }); else paint(); } } },
          [...house.floors.map((f) => [f.id, f.name]), [house.outside, "Outside"]].map(([v, n]) => el("option", { value: v, selected: v === floor }, n)))),
      el("label.field", el("span", "Type"),
        el("select", { disabled: !item, on: { change: (e) => placeItem({ mount: e.target.value }) } },
          house.mounts.map((m) => el("option", { value: m.id, selected: item && item.mount === m.id }, m.label)))),
      el("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px" } },
        num("Across", "x", item?.x), num("Back from the front", "y", item?.y)),
      el("label.field", el("span", "Height above the floor", el("span.mono", item ? L.fmtLen(item.h) : "–")),
        el("input", { type: "range", min: 0, max: ceil, step: 0.05, value: item?.h ?? 0, disabled: !item,
          on: { change: (e) => placeItem({ h: Number(e.target.value) }) } })),
      item ? null : el("div.banner", { style: { fontSize: "14px" } }, "Tap where this light is in 3D, on the Front photo, or in the Top view to place it."),
      item ? beamPanel(t) : null,
      el("div.row", { style: { gap: "8px" } },
        el("button.btn.primary", { type: "button", disabled: status?.read_only, style: { flex: "1" }, on: { click: () => identify(undefined) } }, "Flash it"),
        item ? el("button.btn", { type: "button", on: { click: removeItem } }, "Remove") : null),
      parts);
  }

  // ---- floods and spots ----------------------------------------------------------------------

  const BEAM_KINDS = [["all", "All around"], ["flood", "Flood"], ["spot", "Spot"], ["wall", "Half"]];
  const BEAM_WIDTH = { flood: 90, spot: 25, wall: 180 };
  function beamPanel(t) {
    const aim = t.item.aim || null;
    const kind = aim ? aim.kind : "all";
    const send = (change) => aimLight(t.id, change);
    const slider = (label, key, min, max, fmt) => {
      const out = el("span.mono", fmt(aim[key]));
      return el("label.field", el("span", label, out), el("input", { type: "range", min, max, step: 1, value: aim[key],
        on: { input: (e) => { out.textContent = fmt(Number(e.target.value)); },
          // turning it by hand: no longer aimed at a spot
          change: (e) => send({ kind: aim.kind, beam: aim.beam, tilt: aim.tilt, heading: aim.heading, [key]: Number(e.target.value) }) } }));
    };
    const tiltText = (v) => { v = Math.round(v); return v >= 85 ? "straight up" : v <= -85 ? "straight down" : v === 0 ? "level" : v > 0 ? `${v}° up` : `${-v}° down`; };
    return el("section", { "aria-label": "Its light", style: { display: "flex", flexDirection: "column", gap: "10px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
      el("div.field", el("span", "Its light"),
        el("div.seg", { role: "radiogroup", "aria-label": "Its light" }, BEAM_KINDS.map(([k, label]) =>
          el("button", { type: "button", role: "radio", "aria-checked": String(kind === k), on: { click: () => {
            if (k === "all") send(null);
            else send({ ...(aim || { tilt: 0, heading: 0 }), kind: k, beam: aim && aim.kind === k ? aim.beam : BEAM_WIDTH[k] });
          } } }, label)))),
      !aim ? el("span.small.muted", "Bulbs and ceiling lights light all around. Choose Flood or Spot for a light that points somewhere (a wall wash, an uplight on a tree), or Half for a wall light.") : [
        el("div.row", { style: { gap: "8px", flexWrap: "wrap" } },
          el("button.btn.small.primary", { type: "button", "aria-pressed": String(!!ui.aiming), on: { click: () => { ui.aiming = !ui.aiming; ui.view = "3d"; L.save("house.view", "3d"); paint(); } } },
            ui.aiming ? "Cancel aiming" : "Aim at something in 3D"),
          el("button.btn.small", { type: "button", on: { click: () => { ui.aiming = false; ui.view = "top"; L.save("house.view", "top"); paint(); if (site) { site.setTool("aim"); site.sel = { kind: "light", id: t.id }; site.paint(); } } } }, "Aim from above")),
        el("span.small", aim.at ? `Aimed at ${aim.what || "a spot"}, ${L.fmtLen(Math.hypot(aim.at.x - t.world.x, aim.at.y - t.world.y, aim.at.z - t.world.z))} away.`
          : `Faces ${typeof headingText === "function" ? headingText(aim.heading).replace(/^toward /, "toward ") : `${aim.heading}°`}, ${tiltText(aim.tilt)}.`),
        slider("Beam width", "beam", 5, aim.kind === "wall" ? 180 : 160, (v) => `${v}°`),
        slider("Points", "tilt", -90, 90, tiltText),
        slider("Turned", "heading", 0, 359, (v) => (typeof headingText === "function" ? headingText(v) : `${v}°`)),
      ]);
  }

  function settingsPanel() {
    if (!ui.settings) return null;
    const cell = (name, value, label, placeholder = "") => el("label.field", el("span", label),
      el("input", { name, type: "text", autocomplete: "off", value: value === null || value === undefined ? "" : L.fmtLen(value), placeholder }));
    const form = el("form.card", { "aria-label": "Floors and size", on: { submit: async (e) => { e.preventDefault(); if (await saveSettings(form)) { ui.settings = false; paint(); } } } },
      el("div.card-head", el("h2", "Floors & size"), el("span.small.muted", "Heights are from the ground outside; split levels are floors half a storey apart")),
      el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" } },
        cell("width", house.size.width, "House width"), cell("depth", house.size.depth, "House depth")),
      house.floors.map((f) => el("div", { style: { display: "grid", gridTemplateColumns: "minmax(140px, 1.2fr) repeat(4, minmax(90px, 1fr))", gap: "10px", alignItems: "end", borderTop: "1px solid var(--line)", paddingTop: "10px" } },
        el("b", { style: { paddingBottom: "12px" } }, f.name),
        cell(`${f.id}.elevation`, f.elevation, "Floor height"), cell(`${f.id}.ceiling`, f.ceiling, "Ceiling"),
        cell(`${f.id}.x0`, f.x0, "Covers from", L.fmtLen(0)), cell(`${f.id}.x1`, f.x1, "to", L.fmtLen(house.size.width)))),
      el("p.small.muted", { style: { margin: 0 } }, "“Covers” is the stretch of the house, left to right from the front, that this floor is in. Leave it empty for the whole width."),
      el("div.row", el("button.btn.primary", { type: "submit" }, "Save"), el("button.btn", { type: "button", on: { click: () => { ui.settings = false; paint(); } } }, "Cancel")));
    return form;
  }

  // ---- paint ----------------------------------------------------------------------------------

  let views = null;
  let listBox = null;
  function repaintViews() {
    if (!views) return;
    if (ui.view === "3d") { view3d.mode = ui.mode3d; view3d.aimMode = !!ui.aiming; view3d.setScene(scene3d()); return; }
  }
  function paintList() {
    if (!listBox) return;
    const top = listBox.scrollTop;
    listBox.replaceWith(listBox = listPanel());
    listBox.scrollTop = top;
  }
  let inspBox = null;
  function paintSide() {
    paintList();
    if (inspBox) inspBox.replaceWith(inspBox = inspector());
  }

  function paint() {
    if (!house || !inventory) return;
    // Picking a light repaints the page: keep it, and the list, scrolled where they were
    const pageTop = window.scrollY;
    const listTop = listBox ? listBox.scrollTop : 0;
    paintPage();
    if (listBox) listBox.scrollTop = listTop;
    window.scrollTo(window.scrollX, pageTop);
  }
  function paintPage() {
    const placed = house.targets.filter((t) => t.placed).length;
    const extra = L.topExtra();
    extra.replaceChildren(el("span.small.muted", `${placed} of ${house.targets.length} placed`),
      el("button.btn.small", { type: "button", "aria-expanded": String(ui.settings), on: { click: () => { ui.settings = !ui.settings; paint(); } } }, "Floors & size"));
    const floorTabs = el("div.chips", { role: "group", "aria-label": "Floor shown" },
      [...house.floors.map((f) => [f.id, f.name]), [house.outside, "Outside"]].map(([id, name]) =>
        el("button.chip", { type: "button", "aria-pressed": String(ui.floor === id), on: { click: () => { ui.floor = id; paint(); } } }, name)));
    views = {};
    listBox = listPanel();
    const lineBanner = ui.mode ? el("div.banner", { style: { fontSize: "14px" } }, ui.mode === "line-start" ? "Tap where the first part is." : "Now tap where the last part is.") : null;
    const viewTabs = el("div.tabs", { role: "tablist", "aria-label": "View" },
      [["3d", "3D"], ["photo", "Front photo"], ["top", "Top view"]].map(([k, label]) => el("button", { type: "button", role: "tab", "aria-selected": String(ui.view === k),
        on: { click: () => { ui.view = k; L.save("house.view", k); paint(); } } }, label)));
    let main;
    if (ui.view === "3d") {
      ensure3d();
      const t = ui.sel && target(ui.sel);
      const hint = ui.aiming && t ? `Click what ${t.name} should point at: a wall, the ground, or a tree. Drag to turn the view first if you need to.`
        : !t ? "Pick a light from the list, or tap one."
        : !t.placed ? `Tap where ${t.name} is on the ${floorName(ui.floor)} floor.`
        : ui.mode3d === "raise" ? "Drag the picked light up or down."
        : "Drag the picked light across its floor, or tap the floor to put it there.";
      main = el("section.card", { "aria-label": "The house in 3D", style: { padding: "14px 16px" } },
        el("div.row", { style: { justifyContent: "space-between" } },
          el("div.seg", { role: "radiogroup", "aria-label": "Dragging the picked light" },
            [["move", "Move"], ["raise", "Raise"]].map(([k, label]) => el("button", { type: "button", role: "radio", "aria-checked": String(ui.mode3d === k),
              on: { click: () => { ui.mode3d = k; paint(); } } }, label))),
          el("div.row", { style: { gap: "6px" } }, [["3d", "3D"], ["top", "Top"], ["front", "Front"]].map(([k, label]) =>
            el("button.btn.small", { type: "button", on: { click: () => view3d.preset(k) } }, label)))),
        floorTabs, lineBanner, canvas3d, el("span.small.muted", hint));
    } else if (ui.view === "top") {
      ensureSite();
      main = el("section.card", { "aria-label": "The house from above", style: { padding: "14px 16px" } }, site.root);
    } else {
      ensureFacade();
      main = el("section.card", { "aria-label": "The front photo", style: { padding: "14px 16px" } }, facade.root);
    }
    inspBox = inspector();
    L.set(page,
      checksCard(),
      settingsPanel(),
      // the photo editors have their own panel: give the photo the room
      el("div", { class: ui.view === "3d" ? "hm" : "hm hm-editor" },
        listBox,
        el("div.hm-views", viewTabs, main),
        ui.view === "3d" ? inspBox : null));
    repaintViews();
    if (ui.view === "photo") facade.paint();
    if (ui.view === "top") site.paint();
  }

  // Redraw once the status says which units HA uses (and whenever that changes)
  let shownUnits = null;
  onData((d) => {
    status = d.status;
    if (house && L.units() !== shownUnits) { shownUnits = L.units(); if (!L.typing()) paint(); }
  });
  load().then(() => { paint(); start(15000); }).catch((e) => L.set(page, el("div.empty", `Couldn't load the house map: ${e.message}`)));
})();
