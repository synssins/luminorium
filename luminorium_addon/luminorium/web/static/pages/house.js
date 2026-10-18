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
    // the panel open on the left: lights, levels, rooms, blocks, yard, or "" for none
    dims: !!L.store("house.dims", false),          // block dimensions shown in 3D
    solid: !!L.store("house.solid", false),        // solid walls and ground, lit by the lights
    dimsInside: L.store("house.dimsInside", true) !== false, // inside (as taped) or overall
    panel: ["lights", "levels", "rooms", "blocks", "yard", ""].includes(L.store("house.panel", "lights")) ? L.store("house.panel", "lights") : "lights",
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
  const r3 = (v) => Math.round(v * 1000) / 1000; // to the millimetre

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
  // The icon on a light's orb: what it is (its form, its beam, else how it's mounted)
  function lightIcon(item) {
    if (item.form) return "bar";
    if (item.aim) return "spot";
    return { ceiling: "ceiling", fan: "fan", can: "can", flush: "flush", pendant: "pendant", wall: "wall", floor_lamp: "lamp", table: "lamp", soffit: "soffit", post: "post", ground: "post", under_cabinet: "bar", strip: "bar" }[item.mount] || "bulb";
  }
  function scene3d() {
    const tops = house.floors.map((f) => f.elevation + f.ceiling);
    const bottoms = house.floors.map((f) => f.elevation);
    const lights = house.targets.filter((t) => t.world).map((t) => {
      const sel = t.id === ui.sel;
      const here = t.item.floor === ui.floor || t.item.floor === house.outside;
      return {
        id: t.id, label: t.name, x: t.world.x, y: t.world.y, z: t.world.z, floorZ: floorZ(t.item.floor), aim: t.item.aim || null, floor: t.item.floor, linked: t.fixtures > 0,
        form: t.item.form || null, icon: lightIcon(t.item),
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
      selBlock: ui.mode3d === "shape" ? ui.block : null,
      selOpening: ui.mode3d === "shape" ? ui.opening : null,
      selYard: ui.mode3d === "shape" ? ui.yard : null,
      selStair: ui.mode3d === "shape" ? ui.stair : null,
      blockPicks: ui.mode3d === "shape" ? ui.blockPicks || [] : [],
      // a block picked in Shape: everything above its top is hidden, to see into it
      // (the solid view: the level shown cuts at its ceiling, to look into its rooms)
      cutZ: (() => {
        const b = ui.mode3d === "shape" && ui.block && m && m.blocks.find((q) => q.id === ui.block);
        if (b) return b.z1;
        const f = ui.solid && floorsById().get(ui.floor);
        return f ? f.elevation + f.ceiling : null;
      })(),
      dims: ui.dims ? blockDims() : [],
      solid: !!ui.solid,
      glows: ui.solid ? glows() : [],
      yardPicks: ui.mode3d === "shape" ? ui.yardPicks || [] : [],
      floors: house.floors.map((f) => ({ ...f, active: f.id === ui.floor, label: L.fmtLen(f.elevation, { signed: true }) })),
      lights, grid: L.units() === "imperial" ? L.FT : 1,
      placeZ: floorZ(ui.floor), selPart: ui.part, labels: false,
    };
  }
  function ensure3d() {
    if (view3d) return;
    canvas3d = el("canvas", { "aria-label": "The house in 3D: floors and lights", role: "img",
      class: "hm-canvas", style: { width: "100%", display: "block", borderRadius: "10px", cursor: "grab" } });
    view3d = canvas3d.view = new window.House3D(canvas3d, { // .view: for scripted checks
      onPick: (id, part) => { const t = target(id); ui.sel = id; ui.part = part; if (t && part === null) ui.floor = floorOfTarget(t); paint(); },
      onPlace: async (x, y) => {
        const at = { x: r2(x), y: r2(y) };
        if (ui.mode) return lineClick(at);
        if (!ui.sel) { toast("Pick a light first, from the list or by tapping it"); return; }
        const t = target(ui.sel);
        const part = ui.part !== null && t.item ? t.parts.find((q) => q.index === ui.part) : null;
        // A tap off something already placed lets go of it (dragging is how it moves); one not
        // placed yet goes where the tap is
        if (part) { if (part.placed) { ui.part = null; paint(); } else await placePart(ui.part, at); return; }
        if (t.item) { ui.sel = null; ui.part = null; paint(); return; }
        await placeItem({ ...at, floor: ui.floor });
      },
      onMove: async (id, part, x, y, done) => {
        const t = target(id);
        const at = { x: r2(x), y: r2(y) };
        if (part === null) { t.item.x = at.x; t.item.y = at.y; t.world.x = at.x; t.world.y = at.y; }
        else { const p = t.parts.find((q) => q.index === part); p.world.x = at.x; p.world.y = at.y; }
        view3d.setScene(scene3d());
        if (done) { if (part === null) await placeItem(at); else await placePart(part, at); }
      },
      onBlock: (id, ctrl) => {
        ui.opening = null; ui.yard = null; ui.yardPicks = []; ui.stair = null;
        if (ctrl && id) {
          // Ctrl (or ⌘) + tap: pick several blocks, to join them
          const now = ui.blockPicks && ui.blockPicks.length ? [...ui.blockPicks] : ui.block ? [ui.block] : [];
          const i = now.indexOf(id);
          if (i >= 0) now.splice(i, 1); else now.push(id);
          ui.blockPicks = now.length > 1 ? now : [];
          ui.block = now[now.length - 1] || null;
        } else { ui.block = id; ui.blockPicks = []; }
        paint();
      },
      onStair: (id) => { ui.stair = id; ui.block = null; ui.blockPicks = []; ui.opening = null; ui.yard = null; ui.yardPicks = []; paint(); },
      onStairMove: async (id, dx, dy, done, alt) => {
        const st = house.top && (house.top.stairs || []).find((q) => q.id === id);
        if (!st) return;
        if (!ui.stairBase || ui.stairBase.id !== id) ui.stairBase = { ...st };
        const b = ui.stairBase, sx = alt ? dx : L.snapLen(dx), sy = alt ? dy : L.snapLen(dy);
        const mv = (q) => { q.x0 = r3(b.x0 + sx); q.x1 = r3(b.x1 + sx); q.y0 = r3(b.y0 + sy); q.y1 = r3(b.y1 + sy); };
        mv(st);
        view3d.setScene(scene3d());
        if (done) { ui.stairBase = null; await saveSite((s) => { const q = s.stairs.find((x) => x.id === id); if (!q) return false; mv(q); }); }
      },
      onOpening: (id) => { ui.opening = id; ui.block = null; ui.yard = null; ui.yardPicks = []; paint(); },
      // a flat yard shape: tap to pick it; Ctrl (or ⌘) + tap to pick several, to merge them
      onYard: (id, ctrl) => {
        ui.block = null; ui.opening = null;
        if (ctrl) {
          const now = ui.yardPicks && ui.yardPicks.length ? [...ui.yardPicks] : ui.yard ? [ui.yard] : [];
          const i = now.indexOf(id);
          if (i >= 0) now.splice(i, 1); else now.push(id);
          ui.yardPicks = now.length > 1 ? now : [];
          ui.yard = now[now.length - 1] || null;
        } else { ui.yard = id; ui.yardPicks = []; }
        paint();
      },
      onYardMove: async (id, dx, dy, done, alt) => {
        const y = yardShape(id);
        if (!y) return;
        if (!ui.yardBase || ui.yardBase.id !== id) ui.yardBase = JSON.parse(JSON.stringify(y));
        const sx = alt ? dx : L.snapLen(dx), sy = alt ? dy : L.snapLen(dy);
        const mv = ([a, b]) => [r3(a + sx), r3(b + sy)];
        const shift = (q, o) => { q.pts = o.pts.map(mv); if (o.parts) q.parts = o.parts.map((pp) => pp.map(mv)); };
        shift(y, ui.yardBase);
        view3d.setScene(scene3d());
        if (done) { const base = ui.yardBase; ui.yardBase = null; await changeYard(id, (q) => shift(q, base)); }
      },
      onYardPoint: async (id, part, i, x, y, done, alt) => {
        const s = yardShape(id);
        if (!s) return;
        const at = alt ? [r3(x), r3(y)] : [r2(x), r2(y)];
        const set = (q) => { if (part < 0) q.pts[i] = at; else q.parts[part][i] = at; };
        set(s);
        view3d.setScene(scene3d());
        if (done) await changeYard(id, set);
      },
      // a window or door dragged along its wall: an inch at a time (Alt: free)
      onOpeningMove: async (id, dx, dz, done, alt) => {
        const o = house.massing && house.massing.openings.find((q) => q.id === id);
        if (!o) return;
        if (!ui.openBase || ui.openBase.id !== id) ui.openBase = { ...o };
        const b = ui.openBase;
        const sx = alt ? dx : L.snapLen(dx), sz = alt ? dz : L.snapLen(dz);
        Object.assign(o, { x0: b.x0 + sx, x1: b.x1 + sx, z0: b.z0 + sz, z1: b.z1 + sz });
        view3d.setScene(scene3d());
        if (done) { ui.openBase = null; await changeOpening(id, (q) => { q.x0 += sx; q.x1 += sx; q.z0 += sz; q.z1 += sz; }); }
      },
      onFace: async (id, face, delta, done, alt) => {
        const b = house.massing && house.massing.blocks.find((q) => q.id === id);
        if (!b) return;
        if (!ui.faceBase || ui.faceBase.id !== id || ui.faceBase.face !== face) {
          ui.faceBase = { ...b, face, links: touching(b, face).map((o) => ({ id: o.id, base: { ...o } })) };
        }
        const base = ui.faceBase;
        const { change, others } = faceEdit(base, face, delta, alt, alt ? [] : base.links);
        Object.assign(b, change);
        for (const o of others) Object.assign(house.massing.blocks.find((q) => q.id === o.id), o.change);
        view3d.setScene(scene3d());
        if (done) {
          ui.faceBase = null;
          for (const o of others) await changeBlock(o.id, o.change, true);
          await changeBlock(id, change);
          await carryPlan([{ base, change }, ...others.map((o) => ({ base: base.links.find((l) => l.id === o.id).base, change: o.change }))]);
        }
      },
      onBlockMove: async (id, dx, dy, dz, done, alt) => {
        const b = house.massing && house.massing.blocks.find((q) => q.id === id);
        if (!b) return;
        if (!b.behind) { if (done) toast("This block is drawn on the front photo: move it there, or drag its faces here"); return; }
        if (!ui.faceBase || ui.faceBase.id !== id) ui.faceBase = { ...b };
        const base = ui.faceBase;
        // joined to others: they all go together, and only bump into blocks outside the group
        if (!ui.groupBase || ui.groupBase.id !== id) ui.groupBase = { id, members: b.group ? house.massing.blocks.filter((q) => q.group === b.group && q.id !== id).map((q) => ({ ...q })) : [] };
        const skip = new Set([id, ...ui.groupBase.members.map((q) => q.id)]);
        const m = alt ? { dx, dy, dz } : unoverlap(base, snapMove(base, dx, dy, dz), skip);
        const change = moveChange(base, m);
        Object.assign(b, change);
        const moves = ui.groupBase.members.map((q) => ({ id: q.id, change: moveChange(q, m) }));
        for (const mm of moves) Object.assign(house.massing.blocks.find((q) => q.id === mm.id), mm.change);
        view3d.setScene(scene3d());
        if (done) {
          const members = ui.groupBase.members;
          ui.faceBase = null; ui.groupBase = null;
          for (const mm of moves) await changeBlock(mm.id, mm.change, true);
          await changeBlock(id, change);
          await carryPlan([{ base, change }, ...moves.map((mm) => ({ base: members.find((q) => q.id === mm.id), change: mm.change }))]);
        }
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
  // ---- house blocks in 3D (Shape) ----------------------------------------------------------------

  // A face moved out (delta > 0) or in, as the block's new values in house metres
  function faceChange(b, face, delta) {
    const y0 = b.y0 || 0;
    if (face === "x1") return { x1: b.x1 + delta };
    if (face === "x0") return { x0: b.x0 - delta };
    if (face === "z1") return { z1: b.z1 + delta };
    if (face === "z0") return { z0: b.z0 - delta };
    if (face === "depth") return { depth: Math.max(0.3, b.depth + delta) };
    if (face === "y0") return { y0: y0 - delta, depth: Math.max(0.3, b.depth + delta) };
    return {};
  }
  // A face that comes within 6" of another block's face lines up with it
  const SNAP_M = 0.1524;
  function snapTo(id, axis, v) {
    let best = null;
    for (const o of house.massing.blocks) {
      if (o.id === id) continue;
      const vals = axis === "x" ? [o.x0, o.x1] : axis === "y" ? [o.y0 || 0, (o.y0 || 0) + o.depth] : [o.z0, o.z1];
      for (const c of vals) if (Math.abs(c - v) <= SNAP_M && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
    }
    return best ?? v;
  }
  function snapChange(b, change) {
    const out = { ...change };
    if ("x0" in out) out.x0 = snapTo(b.id, "x", out.x0);
    if ("x1" in out) out.x1 = snapTo(b.id, "x", out.x1);
    if ("z0" in out) out.z0 = snapTo(b.id, "z", out.z0);
    if ("z1" in out) out.z1 = snapTo(b.id, "z", out.z1);
    const y0 = "y0" in out ? out.y0 : b.y0 || 0;
    if ("y0" in out) { const sy = snapTo(b.id, "y", out.y0); out.depth = Math.max(0.3, out.depth + (out.y0 - sy)); out.y0 = sy; }
    else if ("depth" in out) out.depth = Math.max(0.3, snapTo(b.id, "y", y0 + out.depth) - y0);
    return out;
  }
  // A whole block moved by m (dx, dy, dz) as new values
  function moveChange(b, m) {
    const change = {};
    if (m.dx) { change.x0 = b.x0 + m.dx; change.x1 = b.x1 + m.dx; }
    if (m.dy) change.y0 = (b.y0 || 0) + m.dy;
    if (m.dz) { change.z0 = b.z0 + m.dz; change.z1 = b.z1 + m.dz; }
    return change;
  }
  // Moving a whole block: whichever of its sides comes close to another block's lines up
  function snapMove(b, dx, dy, dz = 0) {
    const pick = (axis, lo, hi, d) => {
      const a = snapTo(b.id, axis, lo + d) - (lo + d), c = snapTo(b.id, axis, hi + d) - (hi + d);
      if (Math.abs(a) < 1e-9 && Math.abs(c) < 1e-9) return d;
      if (Math.abs(a) < 1e-9) return d + c;
      if (Math.abs(c) < 1e-9) return d + a;
      return d + (Math.abs(a) <= Math.abs(c) ? a : c);
    };
    const y0 = b.y0 || 0;
    return {
      dx: dx ? pick("x", b.x0, b.x1, dx) : 0,
      dy: dy ? pick("y", y0, y0 + b.depth, dy) : 0,
      dz: dz ? pick("z", b.z0, b.z1, dz) : 0,
    };
  }
  // ---- blocks meet face to face: no overlaps, and a shared face moves both blocks -------------

  const box = (b) => ({ x0: b.x0, x1: b.x1, y0: b.y0 || 0, y1: (b.y0 || 0) + b.depth, z0: b.z0, z1: b.z1 });
  const over = (a0, a1, b0, b1, m = 0.05) => Math.min(a1, b1) - Math.max(a0, b0) > m;
  // Which face of another block sits against this face: x1 meets their x0, the back (depth) their
  // front, and so on
  const FACING = { x1: ["x", "x1", "x0"], x0: ["x", "x0", "x1"], depth: ["y", "y1", "y0"], y0: ["y", "y0", "y1"], z1: ["z", "z1", "z0"], z0: ["z", "z0", "z1"] };
  function touching(b, face) {
    const [axis, mine, theirs] = FACING[face], A = box(b);
    const others = ["x", "y", "z"].filter((k) => k !== axis);
    return house.massing.blocks.filter((o) => {
      if (o.id === b.id) return false;
      const B = box(o);
      return Math.abs(B[theirs] - A[mine]) < 0.03 && others.every((k) => over(A[`${k}0`], A[`${k}1`], B[`${k}0`], B[`${k}1`]));
    });
  }
  // A face dragged or typed: the block's change, plus the blocks whose faces it shares (they move
  // with it, one growing as the other shrinks), and no further than the next block's face
  function faceEdit(base, face, delta, alt, links) {
    let change = alt ? faceChange(base, face, delta) : snapChange(base, faceChange(base, face, delta));
    const [axis, mine, theirs] = FACING[face];
    const A0 = box(base);
    const val = (c) => box({ ...base, ...c })[mine];
    let v = val(change);
    if (!alt) {
      // not into a block that isn't sharing this face
      const others = ["x", "y", "z"].filter((k) => k !== axis);
      const out = mine.endsWith("1") ? 1 : -1;
      for (const o of house.massing.blocks) {
        if (o.id === base.id || links.some((l) => l.id === o.id)) continue;
        const B = box(o);
        if (!others.every((k) => over(A0[`${k}0`], A0[`${k}1`], B[`${k}0`], B[`${k}1`]))) continue;
        const wall = B[theirs];
        if (out > 0 && wall >= A0[mine] - 0.03 && v > wall) v = wall;
        if (out < 0 && wall <= A0[mine] + 0.03 && v < wall) v = wall;
      }
      // a shared face can't squeeze its neighbour below a foot
      for (const l of links) { const B = box(l.base); if (out > 0) v = Math.min(v, B[`${axis}1`] - 0.3); else v = Math.max(v, B[`${axis}0`] + 0.3); }
      change = setFace(base, face, v);
    }
    const others = links.map((l) => ({ id: l.id, change: setFace(l.base, FACING[face][2] === "y0" ? "y0" : FACING[face][2] === "y1" ? "depth" : FACING[face][2], v) }));
    return { change, others };
  }
  // A face of a block moved to v (absolute), as a change
  function setFace(b, face, v) {
    const y0 = b.y0 || 0, y1 = y0 + b.depth;
    if (face === "x0") return { x0: v };
    if (face === "x1") return { x1: v };
    if (face === "z0") return { z0: v };
    if (face === "z1") return { z1: v };
    if (face === "y0") return { y0: v, depth: Math.max(0.3, y1 - v) };
    if (face === "depth") return { depth: Math.max(0.3, v - y0) };
    return {};
  }
  // A whole block moved: pushed back out of any block it would go into
  function unoverlap(b, m, skip = new Set([b.id])) {
    const out = { ...m };
    for (let k = 0; k < 4; k++) {
      const A = box({ ...b, ...moveChange(b, out) });
      let hit = null;
      for (const o of house.massing.blocks) {
        if (skip.has(o.id)) continue;
        const B = box(o);
        if (!["x", "y", "z"].every((a) => over(A[`${a}0`], A[`${a}1`], B[`${a}0`], B[`${a}1`], 0.01))) continue;
        // the least way out, along an axis it's moving on
        let best = null;
        for (const a of ["x", "y", "z"]) {
          if (!out[`d${a}`]) continue;
          const pen = out[`d${a}`] > 0 ? A[`${a}1`] - B[`${a}0`] : -(B[`${a}1`] - A[`${a}0`]);
          if (!best || Math.abs(pen) < Math.abs(best.pen)) best = { a, pen };
        }
        if (best) { hit = best; break; }
      }
      if (!hit) break;
      out[`d${hit.a}`] -= hit.pen;
    }
    return out;
  }
  async function changeBlock(id, change, quiet = false) {
    const ok = await run(async () => { house = await api(`api/house/blocks/${encodeURIComponent(id)}`, { method: "PUT", body: change }); return true; });
    if (quiet && ok) return;
    if (!ok) house = await api("api/house");
    if (facade) facade.load(house.facade); // keep the front photo's drawing in step
    paint();
  }
  async function splitBlock(id, frontDepth) {
    const ok = await run(async () => { house = await api(`api/house/blocks/${encodeURIComponent(id)}/split`, { method: "POST", body: { front_depth: frontDepth } }); return true; });
    if (ok) {
      if (facade) facade.load(house.facade);
      const blocks = house.massing.blocks;
      ui.block = blocks[blocks.length - 1].id; // the new back part
      toast("Split. The back part is picked: drag its top down, or set its level.");
    }
    paint();
  }
  async function addBlock(next) {
    const W = house.size.width, D = house.size.depth;
    // beside the picked block (flush to its right side), else behind the house
    const body = next
      ? { x0: next.x1, x1: next.x1 + 3, y0: next.y0 || 0, depth: next.depth, z0: next.z0, z1: next.z1, level: next.level || null }
      : { x0: W / 2 - 1.5, x1: W / 2 + 1.5, y0: D, depth: 3, z0: 0, z1: 2.7 };
    const ok = await run(async () => { house = await api("api/house/blocks", { method: "POST", body }); return true; });
    if (ok) {
      if (facade) facade.load(house.facade);
      const blocks = house.massing.blocks;
      ui.block = blocks[blocks.length - 1].id;
      toast("Added. Drag it to move it; drag its handles to size it. Its faces snap flush to other blocks.");
    }
    paint();
  }
  async function deleteBlock(b) {
    const ok = await run(async () => { house = await api(`api/house/blocks/${encodeURIComponent(b.id)}`, { method: "DELETE" }); return true; });
    if (ok) { if (facade) facade.load(house.facade); ui.block = null; }
    paint();
  }
  // Move a block by typed amounts: across (right), back (away from the street), up
  function moveByBox(b) {
    const v = { across: 0, back: 0, up: 0 };
    const box = (name, label) => el("label.field", el("span", label),
      el("input.input", { value: "0", inputmode: "decimal", style: { width: "92px" },
        on: { change: (e) => { const t = e.target.value.trim(); const neg = /^[-−]/.test(t); const n = L.parseLen(t.replace(/^[-−]/, "")); if (!Number.isFinite(n)) { toast("Not a length"); e.target.value = "0"; return; } v[name] = neg ? -n : n; } } }));
    return el("section", { "aria-label": "Move by", style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
      el("h3", "Move by"),
      el("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" } },
        box("across", "Across →"), box("back", "Back ↑"), box("up", "Up")),
      el("button.btn.small", { type: "button", on: { click: async () => { const base = { ...b }, change = moveChange(b, { dx: v.across, dy: v.back, dz: v.up }); await changeBlock(b.id, change); await carryPlan([{ base, change }]); } } }, "Move"),
      el("span.small.muted", "Less than 0 moves the other way (left, toward the street, down). In the view: drag the block across the ground, Shift+drag it up or down, or drag one of its arrows; hold Alt to stop snapping."));
  }
  // ---- joined blocks and stairs between their floors -------------------------------------------

  // The picked blocks as one shape: one outline, no walls between them, moved together; each
  // keeps its own floor
  async function joinBlocks(ids) {
    const blocks = ids.map((id) => house.massing.blocks.find((q) => q.id === id)).filter(Boolean);
    if (blocks.length < 2) return;
    const group = (blocks.find((q) => q.group) || {}).group || Math.random().toString(36).slice(2, 10);
    // everything already joined to any of them comes too
    const all = house.massing.blocks.filter((q) => blocks.includes(q) || (q.group && blocks.some((b) => b.group === q.group)));
    for (const q of all.slice(0, -1)) await changeBlock(q.id, { group }, true);
    await changeBlock(all[all.length - 1].id, { group });
    ui.blockPicks = []; ui.block = blocks[blocks.length - 1].id;
    toast("Joined. They move together now, and each keeps its own floor. Add stairs between them from the tool bar.");
  }
  async function unjoin(b) {
    const all = house.massing.blocks.filter((q) => q.group && q.group === b.group);
    for (const q of all.slice(0, -1)) await changeBlock(q.id, { group: null }, true);
    if (all.length) await changeBlock(all[all.length - 1].id, { group: null });
  }
  // Where stairs can lead from a block: the other blocks (their floors) and the levels
  function stairTargets(b) {
    const bl = house.massing.blocks.filter((q) => q.id !== b.id).map((q, i) => ({ key: `b:${q.id}`, label: q.name || `Block ${i + 1}`, z: q.z0, block: q }));
    const lv = house.floors.map((f) => ({ key: `l:${f.id}`, label: f.name, z: f.elevation, level: f.id }));
    return [...bl, ...lv];
  }
  function levelAt(z) { return [...house.floors].sort((a, c) => c.elevation - a.elevation).find((f) => f.elevation <= z + 0.05) || house.floors[0]; }
  // New stairs in the picked block, from its floor to the nearest floor below (a block it's joined
  // to first): sized from the drop, a step about 7 1/2" and a tread 11"
  async function addStairs(b) {
    if (!house.site) { toast("Set up the Top view first (its photo and scale): stairs are kept there"); return; }
    const mates = b.group ? house.massing.blocks.filter((q) => q.group === b.group && q.id !== b.id && Math.abs(q.z0 - b.z0) > 0.1) : [];
    const target = mates[0] ? { z: mates[0].z0, block: mates[0] } : (() => { const f = [...house.floors].sort((x, y) => y.elevation - x.elevation).find((q) => q.elevation < b.z0 - 0.1); return f ? { z: f.elevation, level: f.id } : null; })();
    if (!target) { toast("Nothing below this block's floor for stairs to go to"); return; }
    const rise = Math.abs(b.z0 - target.z), steps = Math.max(1, Math.round(rise / 0.19) - 1), run = steps * 0.2794, w = 0.9144;
    const y0 = b.y0 || 0;
    // toward the block it leads to, else toward the front
    let dir = "y-";
    if (target.block) {
      const tb = target.block, dxc = (tb.x0 + tb.x1) / 2 - (b.x0 + b.x1) / 2, dyc = ((tb.y0 || 0) + tb.depth / 2) - (y0 + b.depth / 2);
      dir = Math.abs(dxc) > Math.abs(dyc) ? (dxc > 0 ? "x+" : "x-") : (dyc > 0 ? "y+" : "y-");
    }
    const cx = (b.x0 + b.x1) / 2, cy = y0 + b.depth / 2;
    const along = dir[0] === "x";
    const st = {
      id: Math.random().toString(36).slice(2, 10), level: (b.level || levelAt(b.z0).id), to: target.level || null, dir,
      x0: r3(along ? cx - run / 2 : cx - w / 2), x1: r3(along ? cx + run / 2 : cx + w / 2), y0: r3(along ? cy - w / 2 : cy - run / 2), y1: r3(along ? cy + w / 2 : cy + run / 2),
      steps, z0: r3(b.z0), z1: r3(target.z), from_block: b.id, ...(target.block ? { to_block: target.block.id } : {}),
    };
    ui.block = null; ui.stair = st.id;
    await saveSite((s) => { s.stairs.push(st); });
    toast(`Added ${steps} steps down. Drag them where they are; set where they lead and their steps in the panel.`);
  }
  function stairPanel(st) {
    const fmt = L.fmtLen;
    const from = house.massing.blocks.find((q) => q.id === st.from_block);
    const fromZ = st.z0 ?? (floorsById().get(st.level) || {}).elevation ?? 0;
    const toZ = st.z1 ?? (floorsById().get(st.to) || {}).elevation ?? 0;
    const rise = Math.abs(toZ - fromZ);
    const along = st.dir[0];
    const run = along === "x" ? st.x1 - st.x0 : st.y1 - st.y0, width = along === "x" ? st.y1 - st.y0 : st.x1 - st.x0;
    const steps = st.steps || Math.max(1, Math.round(rise / 0.19) - 1), tread = run / steps, riser = st.riser || rise / (steps + 1);
    const edit = (fn) => saveSite((s) => { const q = s.stairs.find((x) => x.id === st.id); if (!q) return false; if (fn(q) === false) s.stairs = s.stairs.filter((x) => x.id !== st.id); });
    // the bottom stays: the run grows or shrinks from the other end
    const setRun = (q, n, tr) => { q.steps = n; const len = n * tr; if (q.dir[1] === "+") q[`${along}1`] = r3(q[`${along}0`] + len); else q[`${along}0`] = r3(q[`${along}1`] - len); };
    const targets = from ? stairTargets(from) : house.floors.map((f) => ({ key: `l:${f.id}`, label: f.name, z: f.elevation, level: f.id }));
    const cur = st.to_block ? `b:${st.to_block}` : st.to ? `l:${st.to}` : "";
    const len = (label, value, set) => el("label.field", el("span", label), el("input.input", { value: fmt(value), inputmode: "decimal",
      on: { change: (e) => { const v = L.parseLen(e.target.value); if (!(v > 0.02)) { toast("Give a length, like 7 1/2\""); e.target.value = fmt(value); return; } edit((q) => set(q, v)); } } }));
    return el("aside.card.accent.hm-insp", { "aria-label": "Picked stairs" },
      el("div", el("h2", "Stairs"), el("span.small.muted", `From ${from ? from.name || "a block" : (floorsById().get(st.level) || {}).name || "a level"} · ${fmt(rise)} ${toZ < fromZ ? "down" : "up"}`)),
      el("label.field", el("span", "They lead to"), el("select", { on: { change: (e) => {
        const t = targets.find((x) => x.key === e.target.value);
        if (t) edit((q) => { q.z1 = r3(t.z); if (t.block) { q.to_block = t.block.id; q.to = null; } else { delete q.to_block; q.to = t.level; } });
      } } }, targets.map((t) => el("option", { value: t.key, selected: t.key === cur ? "" : null }, t.label)))),
      el("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px" } },
        len("Width", width, (q, v) => { if (along === "x") q.y1 = r3(q.y0 + v); else q.x1 = r3(q.x0 + v); }),
        len("Tread depth", tread, (q, v) => setRun(q, steps, v)),
        len("Step height", riser, (q, v) => { q.riser = r3(v); }),
        el("label.field", el("span", "Steps"), el("input.input", { type: "number", min: 1, max: 60, value: steps,
          on: { change: (e) => { const n = Math.round(Number(e.target.value)); if (!(n >= 1 && n <= 60)) { toast("1 to 60 steps"); return; } edit((q) => setRun(q, n, tread)); } } }))),
      el("span.small.muted", "Steps: not counting the floor at the top. Drag the stairs in the view to move them."),
      el("div.row", { style: { gap: "8px", flexWrap: "wrap" } },
        el("button.btn", { type: "button", on: { click: () => { ui.stair = null; paint(); } } }, "Done"),
        el("button.btn", { type: "button", on: { click: () => edit((q) => { q.dir = { "x+": "x-", "x-": "x+", "y+": "y-", "y-": "y+" }[q.dir]; }) } }, "Turn round"),
        el("button.btn.danger", { type: "button", on: { click: () => { ui.stair = null; edit(() => false); } } }, "Delete")));
  }
  // A face moved by a typed amount: as dragging does (shared faces too, not into a block)
  async function typedFace(b, face, delta) {
    const links = touching(b, face).map((o) => ({ id: o.id, base: { ...o } }));
    const { change, others } = faceEdit({ ...b }, face, delta, true, links);
    for (const o of others) await changeBlock(o.id, o.change, true);
    await changeBlock(b.id, change);
    await carryPlan([{ base: { ...b }, change }, ...others.map((o) => ({ base: links.find((l) => l.id === o.id).base, change: o.change }))]);
  }
  // The Top view's plan follows the blocks: a block moved takes the walls, rooms and stairs inside
  // it on its levels along; a face moved stretches the walls that end against it
  async function carryPlan(edits) {
    if (!house.site) return;
    const jobs = edits.filter((e) => e.base).map(({ base, change }) => {
      const A = box(base), B = box({ ...base, ...change });
      const levels = new Set(house.floors.filter((f) => (base.level ? base.level === f.id : f.elevation >= A.z0 - 0.05 && f.elevation <= A.z1 - 0.3)).map((f) => f.id));
      return { A, B, levels };
    }).filter((j) => ["x0", "x1", "y0", "y1"].some((k) => Math.abs(j.A[k] - j.B[k]) > 1e-4));
    if (!jobs.length) return;
    await saveSite((s) => {
      let changed = false;
      for (const { A, B, levels } of jobs) {
        const dx = B.x0 - A.x0, dy = B.y0 - A.y0;
        const moved = Math.abs(B.x1 - A.x1 - dx) < 1e-4 && Math.abs(B.y1 - A.y1 - dy) < 1e-4;
        const inside = ([x, y]) => x >= A.x0 - 0.05 && x <= A.x1 + 0.05 && y >= A.y0 - 0.05 && y <= A.y1 + 0.05;
        const here = (q) => levels.has(q.level);
        if (moved) {
          const sh = ([x, y]) => [r3(x + dx), r3(y + dy)];
          for (const w of s.walls) if (here(w) && inside(w.a) && inside(w.b)) { w.a = sh(w.a); w.b = sh(w.b); changed = true; }
          for (const r of s.rooms) if (here(r) && inside(r.at)) { r.at = sh(r.at); changed = true; }
          for (const t of s.stairs) if (here(t) && inside([t.x0, t.y0]) && inside([t.x1, t.y1])) { t.x0 = r3(t.x0 + dx); t.x1 = r3(t.x1 + dx); t.y0 = r3(t.y0 + dy); t.y1 = r3(t.y1 + dy); changed = true; }
          continue;
        }
        // a face moved: wall ends on it (within an outside wall's thickness of it) go with it
        const NEAR = 0.35;
        for (const w of s.walls) {
          if (!here(w)) continue;
          for (const e of [w.a, w.b]) {
            if (e[1] >= A.y0 - 0.05 && e[1] <= A.y1 + 0.05) {
              if (A.x1 !== B.x1 && Math.abs(e[0] - A.x1) <= NEAR) { e[0] = r3(e[0] + B.x1 - A.x1); changed = true; }
              else if (A.x0 !== B.x0 && Math.abs(e[0] - A.x0) <= NEAR) { e[0] = r3(e[0] + B.x0 - A.x0); changed = true; }
            }
            if (e[0] >= A.x0 - 0.05 && e[0] <= A.x1 + 0.05) {
              if (A.y1 !== B.y1 && Math.abs(e[1] - A.y1) <= NEAR) { e[1] = r3(e[1] + B.y1 - A.y1); changed = true; }
              else if (A.y0 !== B.y0 && Math.abs(e[1] - A.y0) <= NEAR) { e[1] = r3(e[1] + B.y0 - A.y0); changed = true; }
            }
          }
        }
      }
      if (!changed) return false;
    });
  }
  function blockPanel(b) {
    const fmt = L.fmtLen;
    const faces = view3d ? view3d.blockFaces(b) : [];
    ui.moveFace = faces.some((f) => f.face === ui.moveFace) ? ui.moveFace : "depth";
    let amount = 0.3048;
    const amountInput = el("input.input", { value: fmt(amount), inputmode: "decimal", style: { width: "100px" },
      on: { change: (e) => { const v = L.parseLen(e.target.value); if (!(v > 0)) { toast("Give a length, like 2' 6\""); e.target.value = fmt(amount); return; } amount = v; e.target.value = fmt(v); } } });
    let front = Math.round((b.depth / 2) / 0.0254) * 0.0254;
    const frontInput = el("input.input", { value: fmt(front), inputmode: "decimal", style: { width: "100px" },
      on: { change: (e) => { const v = L.parseLen(e.target.value); if (!(v > 0.3 && v < b.depth - 0.3)) { toast(`Between 1 ft and ${fmt(b.depth - 0.3)}`); e.target.value = fmt(front); return; } front = v; } } });
    const mode = !b.offset ? "same" : b.offset > 0 ? "up" : "down";
    let off = Math.abs(b.offset || 0.6096);
    return el("aside.card.accent.hm-insp", { "aria-label": "Picked house block" },
      el("div", el("h2", b.name || "House block"), el("span.small.muted", b.behind ? "Behind another block (not on the front photo)" : "From the front photo")),
      b.group ? el("div.row", { style: { gap: "8px", alignItems: "center" } },
        el("span.small", `Joined with ${house.massing.blocks.filter((q) => q.group === b.group && q.id !== b.id).length} other block(s): they move together.`),
        el("button.btn.small", { type: "button", on: { click: () => unjoin(b) } }, "Unjoin")) : null,
      el("label.field", el("span", "Name"), el("input.input", { value: b.name || "", on: { change: (e) => changeBlock(b.id, { name: e.target.value }) } })),
      el("dl", { class: "fc-kv" }, el("dt", "Width"), el("dd", fmt(b.x1 - b.x0)), el("dt", "Front to back"), el("dd", fmt(b.depth)),
        el("dt", "Height"), el("dd", fmt(b.z1 - b.z0)), el("dt", "Top"), el("dd", `${fmt(b.z1)} up`)),
      el("section", { "aria-label": "Move a face", style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
        el("h3", "Move a face"),
        el("select.input", { on: { change: (e) => { ui.moveFace = e.target.value; } } }, faces.map((f) => el("option", { value: f.face, selected: f.face === ui.moveFace ? "" : null }, f.label))),
        el("div.row", { style: { gap: "8px" } }, amountInput,
          el("button.btn.small", { type: "button", on: { click: () => typedFace(b, ui.moveFace, amount) } }, "Out"),
          el("button.btn.small", { type: "button", on: { click: () => typedFace(b, ui.moveFace, -amount) } }, "In")),
        el("span.small.muted", b.behind ? "Or drag a yellow handle in the view." : "Or drag a yellow handle in the view. This block is drawn on the front photo, so it moves there.")),
      b.behind ? moveByBox(b) : null,
      el("section", { "aria-label": "Split", style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
        el("h3", "Split front to back"),
        el("label.field", el("span", "The front part is"), frontInput),
        el("button.btn.small", { type: "button", on: { click: () => splitBlock(b.id, front) } }, "Split"),
        el("span.small.muted", "For a part of the house where the back differs from the front, like a lower back entrance behind the front entry.")),
      el("section", { "aria-label": "Its level", style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
        el("label.field", el("span", "Part of"), el("select", { on: { change: (e) => changeBlock(b.id, { level: e.target.value || null }) } },
          el("option", { value: "" }, "Not set"), house.floors.map((f) => el("option", { value: f.id, selected: b.level === f.id ? "" : null }, f.name)))),
        b.level ? el("div.field", el("span", "Its floor"),
          el("div.seg", { role: "radiogroup", "aria-label": "Its floor" }, [["same", "Same as the level"], ["up", "Higher"], ["down", "Lower"]].map(([k, label]) =>
            el("button", { type: "button", role: "radio", "aria-checked": String(mode === k), on: { click: () => changeBlock(b.id, { offset: k === "same" ? 0 : (k === "up" ? 1 : -1) * off }) } }, label))),
          mode !== "same" ? el("input.input", { value: fmt(off), inputmode: "decimal", style: { width: "100px" },
            on: { change: (e) => { const v = L.parseLen(e.target.value); if (!(v >= 0)) return; off = v; changeBlock(b.id, { offset: (mode === "up" ? 1 : -1) * v }); } } }) : null) : null),
      el("div.row", { style: { gap: "8px", flexWrap: "wrap" } },
        el("button.btn", { type: "button", on: { click: () => { ui.block = null; paint(); } } }, "Done"),
        el("button.btn", { type: "button", on: { click: () => addBlock(b) } }, "Add a block beside it"),
        el("button.btn.danger", { type: "button", on: { click: () => deleteBlock(b) } }, "Delete")));
  }

  // How many fixtures to start with: a group, one per light in it; else two
  function startFixtures(t) {
    const fx = t.kind === "fixture" && (inventory.fixtures || []).find((f) => f.id === t.id);
    return Math.max(2, Math.min(50, fx ? fx.members.length : 2));
  }
  async function setFixtures(t, count) {
    await run(() => api(`api/house/items/${encodeURIComponent(t.id)}/fixtures`, { method: "PUT", body: { count } }));
    ui.part = count ? 0 : null;
    await reload();
    if (count) toast(`Now drag each fixture of ${t.name} to where it is`);
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
  // Things to check: an alert triangle in the top bar, with how many; a tap opens the list
  ui.checksOpen = false;
  function checksButton() {
    const list = [...(house.checks || []), ...(facade ? facade.checks() : [])];
    if (!list.length) return null;
    const warns = list.filter((c) => c.level === "warn").length;
    const TAB = { photo: ["photo", "Front photo"], top: ["top", "Top view"], floors: [null, "Floors & size"] };
    const go = (tab) => {
      ui.checksOpen = false;
      if (tab === "floors") { ui.settings = true; paint(); return; }
      ui.view = TAB[tab][0]; L.save("house.view", ui.view); paint();
    };
    const label = warns ? `${warns} thing${warns === 1 ? "" : "s"} to check` : `${list.length} note${list.length === 1 ? "" : "s"}`;
    const NS = "http://www.w3.org/2000/svg";
    const tri = document.createElementNS(NS, "svg");
    tri.setAttribute("viewBox", "0 0 24 24"); tri.setAttribute("width", "18"); tri.setAttribute("height", "18"); tri.setAttribute("aria-hidden", "true");
    tri.innerHTML = '<path d="M12 3L2 21h20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    const wrap = el("span.alert-wrap");
    wrap.append(
      el("button", { type: "button", class: `alert-btn${warns ? " warn" : ""}`, title: label, "aria-label": label, "aria-expanded": String(ui.checksOpen),
        on: { click: (e) => { e.stopPropagation(); ui.checksOpen = !ui.checksOpen; paint(); } } },
        tri, el("span.alert-n", String(warns || list.length))),
      ui.checksOpen ? el("div.alert-pop", { role: "dialog", "aria-label": "Things to check", on: { click: (e) => e.stopPropagation() } },
        el("b", label),
        list.map((c) => el("div.row", { style: { gap: "10px", alignItems: "flex-start", flexWrap: "nowrap" } },
          el("span", { "aria-hidden": "true", style: { width: "10px", height: "10px", borderRadius: "50%", marginTop: "6px", flex: "none", background: c.level === "warn" ? "var(--warn, #e0a030)" : "var(--info, #5aa9e6)" } }),
          el("span", { style: { flex: "1" } }, c.text),
          TAB[c.tab] ? el("button.btn.small", { type: "button", on: { click: () => go(c.tab) } }, "Show me") : null))) : "");
    return wrap;
  }
  // a tap anywhere else closes the list
  document.addEventListener("click", () => { if (ui.checksOpen) { ui.checksOpen = false; paint(); } });

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
    return el("div.hm-pane", { "aria-label": "Lights to place" },
      paneHead("Lights"),
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

  // ---- the solid view: each light's live colour and brightness, as a pool on its floor ---------

  let looks = new Map(); // light entity -> { brightness, rgb_color, color_temp_kelvin }
  async function refreshLooks() {
    try {
      const inv = await api("api/inventory");
      inventory = inv;
      looks = new Map(inv.lights.map((l) => [l.entity_id, l.look || {}]));
      if (ui.view === "3d" && ui.solid && view3d) view3d.setScene(scene3d());
    } catch { /* the next refresh tries again */ }
  }
  function glows() {
    const out = [];
    const members = new Map((inventory.fixtures || []).map((f) => [f.id, f.members || []]));
    for (const t of house.targets) {
      if (!t.world || !t.item || t.state !== "on") continue;
      const look = looks.get(t.id) || looks.get((members.get(t.id) || [])[0]) || {};
      const color = look.rgb_color ? `#${look.rgb_color.map((v) => v.toString(16).padStart(2, "0")).join("")}`
        : look.color_temp_kelvin ? L.colorHex({ kelvin: look.color_temp_kelvin }) : "#ffd28a";
      const level = look.brightness != null ? look.brightness / 255 : 0.8;
      if (level <= 0.01) continue;
      // the solid view is cut at the level shown: light on the floors under it isn't seen
      if (t.item.floor !== ui.floor && t.item.floor !== house.outside) continue;
      // several fixtures on one switch: each throws its own light
      const fz = floorZ(t.item.floor);
      const f = t.item.form;
      if (f) {
        // a bar or strip: light along its length, under it (down), out to its side, or a faint
        // bounce (up)
        const th = (f.rot || 0) * Math.PI / 180, ux = Math.cos(th), uy = -Math.sin(th);
        const off = f.face === "side" ? 0.9 : 0, sx = -Math.sin(th) * off, sy = -Math.cos(th) * off;
        const n = Math.max(1, Math.round(f.length / 0.6));
        for (let i = 0; i < n; i++) {
          const k = -f.length / 2 + (f.length * (i + 0.5)) / n;
          out.push({ x: t.world.x + ux * k + sx, y: t.world.y + uy * k + sy, z: t.world.z, floorZ: fz, floor: t.item.floor, color,
            level: level * (f.face === "up" ? 0.3 : 0.7), r: f.face === "up" ? 1.6 : 0.8 + 0.6 * level });
        }
        continue;
      }
      const fx = t.fixtures > 0 ? t.parts.filter((p) => p.world) : [];
      if (fx.length) { for (const p of fx) out.push({ x: p.world.x, y: p.world.y, z: p.world.z, floorZ: fz, floor: t.item.floor, color, level: level * 0.75, r: 0.7 + 0.9 * level }); continue; }
      out.push({ x: t.world.x, y: t.world.y, z: t.world.z, floorZ: fz, floor: t.item.floor, color, level });
    }
    return out;
  }

  // ---- dimensions: each block's size, inside (as a tape reads in the room) or overall ----------

  const INT_WALL = 0.0889 + 2 * 0.0127; // 2x4 with drywall both sides: 4 1/2"
  // A block's faces that another block's face meets (an inside wall between them), else outside
  function sharedFaces(b) {
    const out = { x0: false, x1: false, y0: false, y1: false };
    const by0 = b.y0 || 0, by1 = by0 + b.depth;
    for (const o of house.massing.blocks) {
      if (o === b) continue;
      const oy0 = o.y0 || 0, oy1 = oy0 + o.depth;
      const zOver = Math.min(b.z1, o.z1) - Math.max(b.z0, o.z0) > 0.3;
      const yOver = Math.min(by1, oy1) - Math.max(by0, oy0) > 0.3, xOver = Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0) > 0.3;
      if (!zOver) continue;
      if (yOver && Math.abs(o.x1 - b.x0) < 0.03) out.x0 = true;
      if (yOver && Math.abs(o.x0 - b.x1) < 0.03) out.x1 = true;
      if (xOver && Math.abs(o.y1 - by0) < 0.03) out.y0 = true;
      if (xOver && Math.abs(o.y0 - by1) < 0.03) out.y1 = true;
    }
    return out;
  }
  // Labels over each block: across × front to back, and its height. Inside takes off the walls:
  // half an inside wall where a block meets another, an outside wall where it doesn't.
  function blockDims() {
    const m = house.massing;
    if (!m) return [];
    const ext = (house.top && house.top.ext_thick) || 0.1835;
    const fmt = L.fmtLen;
    return m.blocks.map((b) => {
      const y0 = b.y0 || 0;
      let w = b.x1 - b.x0, d = b.depth;
      if (ui.dimsInside) {
        const sh = sharedFaces(b), t = (k) => (sh[k] ? INT_WALL / 2 : ext);
        w -= t("x0") + t("x1"); d -= t("y0") + t("y1");
      }
      return { at: { x: (b.x0 + b.x1) / 2, y: y0 + b.depth / 2, z: b.z1 }, top: true, text: `${fmt(w)} × ${fmt(d)}  ·  ${fmt(b.z1 - b.z0)} high` };
    });
  }

  // ---- flat yard shapes in 3D --------------------------------------------------------------------

  const AREA_KINDS = [["driveway", "Driveway"], ["patio", "Patio"], ["pool", "Pool"], ["bed", "Garden bed"], ["lawn", "Lawn"], ["other", "Other"]];
  function yardShape(id) { return house.top && house.top.yard.find((q) => q.id === id) || null; }
  // Change the top view's drawing (where the yard is kept) and save it
  async function saveSite(fn) {
    const s = JSON.parse(JSON.stringify(house.site));
    if (fn(s) === false) return;
    const ok = await run(async () => { house = await api("api/house/site", { method: "PUT", body: s }); return true; });
    if (!ok) house = await api("api/house");
    if (site) site.load(house.site);
    paint();
  }
  function changeYard(id, fn) {
    return saveSite((s) => { const y = s.yard.find((q) => q.id === id); if (!y) return false; if (fn(y) === false) s.yard = s.yard.filter((q) => q.id !== id); });
  }
  // A new path or area where the view is looking, picked so its corners can be dragged
  async function addYard(kind) {
    if (!house.site || !house.top) { toast("Set up the Top view first (its photo and scale): the yard is kept there"); return; }
    const c = canvas3d.getBoundingClientRect();
    const at = view3d.onPlane(c.width / 2, c.height * 0.6, 0) || { x: house.size.width / 2, y: -3 };
    // not under the house, where the house would hide it: out in front of it instead
    if (at.y > -1.6 && at.y < house.size.depth && at.x > -1.6 && at.x < house.size.width + 1.6) at.y = -3;
    const x = r2(at.x), y = r2(at.y);
    const id = Math.random().toString(36).slice(2, 10);
    const shape = kind === "path"
      ? { id, kind: "path", name: "", pts: [[r2(x - 1.524), y], [r2(x + 1.524), y]], width: 0.9144, smooth: false }
      : { id, kind: "patio", name: "", pts: [[r2(x - 1.524), r2(y - 1.524)], [r2(x + 1.524), r2(y - 1.524)], [r2(x + 1.524), r2(y + 1.524)], [r2(x - 1.524), r2(y + 1.524)]], smooth: false };
    ui.mode3d = "shape"; ui.block = null; ui.opening = null; ui.yard = id; ui.yardPicks = [];
    await saveSite((s) => { s.yard.push(shape); });
    toast(kind === "path" ? "Added a path. Drag it to move it, drag its ends to stretch it, and set its width in the panel." : "Added an area. Drag it to move it and its corners to shape it; pick what it is in the panel.");
  }
  // Two or more flat shapes as one. Paths whose ends meet join into one path (an L or a T turns
  // into one walkway); otherwise the others become parts of the first, drawn and moved with it.
  function mergeYard(ids) {
    return saveSite((s) => {
      const picked = ids.map((id) => s.yard.find((q) => q.id === id)).filter((q) => q && q.pts);
      if (picked.length < 2) return false;
      // whichever was picked first: with an area among them the result is an area (the first
      // area picked keeps its name and kind), and the paths become the strips they cover
      const area = picked.find((q) => q.kind !== "path");
      const list = area ? [area, ...picked.filter((q) => q !== area)] : picked;
      const [first, ...rest] = list;
      const tol = Math.max(0.3, first.width ?? 1.2);
      const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
      for (const o of rest) {
        const pieces = [o.pts, ...(o.parts || [])];
        if (first.kind === "path" && o.kind === "path" && !first.parts && !o.parts) {
          // end to end: one line through both
          const a = first.pts, b = o.pts;
          let line = null;
          const rb = [...b].reverse();
          if (near(a[a.length - 1], b[0])) line = joinLines(a, b);
          else if (near(a[a.length - 1], b[b.length - 1])) line = joinLines(a, rb);
          else if (near(a[0], b[b.length - 1])) line = joinLines(b, a);
          else if (near(a[0], b[0])) line = joinLines(rb, a);
          if (line) { first.pts = line; first.width = Math.max(first.width ?? 1.2, o.width ?? 1.2); continue; }
        }
        // a path merged into an area becomes an outline: the strip it covers
        const asFirst = (pts) => (first.kind !== "path" && o.kind === "path" ? strip(pts, (o.width ?? 1.2) / 2) : pts);
        first.parts = [...(first.parts || []), ...pieces.map(asFirst)];
      }
      const drop = new Set(rest.map((q) => q.id));
      s.yard = s.yard.filter((q) => !drop.has(q.id));
      ui.yard = first.id; ui.yardPicks = [];
    });
  }
  // Two path lines, the end of one by the start of the other, as one line: the corner where their
  // end segments' lines cross (an L meets square), else halfway between the two ends
  function joinLines(a, b) {
    const p = a[a.length - 2], q = a[a.length - 1], u = b[0], v = b[1];
    const d1 = [q[0] - p[0], q[1] - p[1]], d2 = [v[0] - u[0], v[1] - u[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    let corner = [(q[0] + u[0]) / 2, (q[1] + u[1]) / 2];
    if (Math.abs(den) > 1e-9) {
      const t = ((u[0] - p[0]) * d2[1] - (u[1] - p[1]) * d2[0]) / den;
      const x = [p[0] + d1[0] * t, p[1] + d1[1] * t];
      // only a crossing near where they meet (not far off for lines almost in line)
      if (Math.hypot(x[0] - q[0], x[1] - q[1]) < 3 && Math.hypot(x[0] - u[0], x[1] - u[1]) < 3) corner = x;
    }
    return [...a.slice(0, -1), corner.map(r3), ...b.slice(1)];
  }
  // A path line as the outline of the strip it covers
  function strip(line, half) {
    const left = [], right = [];
    line.forEach((p, i) => {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      left.push([r3(p[0] - (dy / l) * half), r3(p[1] + (dx / l) * half)]); right.push([r3(p[0] + (dy / l) * half), r3(p[1] - (dx / l) * half)]);
    });
    return [...left, ...right.reverse()];
  }
  // Undo a merge: each part its own shape again
  function splitYard(id) {
    return saveSite((s) => {
      const y = s.yard.find((q) => q.id === id);
      if (!y || !y.parts) return false;
      for (const pts of y.parts) s.yard.push({ ...y, id: Math.random().toString(36).slice(2, 10), pts, parts: undefined, name: "" });
      delete y.parts;
    });
  }
  function yardPanel(y) {
    const fmt = L.fmtLen;
    const isPath = y.kind === "path";
    const xs = [y.pts, ...(y.parts || [])].flat().map((q) => q[0]), ys = [y.pts, ...(y.parts || [])].flat().map((q) => q[1]);
    const W = Math.max(...xs) - Math.min(...xs), D = Math.max(...ys) - Math.min(...ys), x0 = Math.min(...xs), y0 = Math.min(...ys);
    const len = (label, value, set) => el("label.field", el("span", label),
      el("input.input", { value: fmt(value), inputmode: "decimal", on: { change: (e) => {
        const v = L.parseLen(e.target.value);
        if (!(v > 0.05)) { toast("Give a length, like 3' 6\""); e.target.value = fmt(value); return; }
        changeYard(y.id, (q) => set(q, v));
      } } }));
    // an area's size: stretch it from its front left corner
    const scale = (q, kx, ky) => { const f = ([a, b]) => [r3(x0 + (a - x0) * kx), r3(y0 + (b - y0) * ky)]; q.pts = q.pts.map(f); if (q.parts) q.parts = q.parts.map((pp) => pp.map(f)); };
    const runLen = isPath ? y.pts.reduce((a, q, i) => (i ? a + Math.hypot(q[0] - y.pts[i - 1][0], q[1] - y.pts[i - 1][1]) : 0), 0) : 0;
    return el("aside.card.accent.hm-insp", { "aria-label": "Picked yard shape" },
      el("div", el("h2", y.name || (isPath ? "Path" : (AREA_KINDS.find((k) => k[0] === y.kind) || [, "Area"])[1])),
        el("span.small.muted", y.parts ? `Made of ${y.parts.length + 1} pieces, merged` : "Drag it to move it; drag its white corners to shape it.")),
      el("label.field", el("span", "Name"), el("input.input", { value: y.name || "", placeholder: isPath ? "Front walk" : "Driveway", on: { change: (e) => changeYard(y.id, (q) => { q.name = e.target.value; }) } })),
      isPath ? null : el("label.field", el("span", "What it is"), el("select", { on: { change: (e) => changeYard(y.id, (q) => { q.kind = e.target.value; }) } },
        AREA_KINDS.map(([k, label]) => el("option", { value: k, selected: y.kind === k ? "" : null }, label)))),
      isPath ? el("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px" } },
        len("Width", y.width ?? 1.2, (q, v) => { q.width = r3(v); }),
        y.pts.length === 2 && !y.parts ? len("Length", runLen, (q, v) => {
          const [a, b] = q.pts, l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          q.pts = [a, [r3(a[0] + ((b[0] - a[0]) / l) * v), r3(a[1] + ((b[1] - a[1]) / l) * v)]];
        }) : el("div.field", el("span", "Length"), el("span.mono", fmt(runLen))))
        : el("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px" } },
          len("Across", W, (q, v) => scale(q, v / (W || 1), 1)), len("Front to back", D, (q, v) => scale(q, 1, v / (D || 1)))),
      y.parts ? null : el("label.check.small", el("input", { type: "checkbox", checked: !!y.smooth, on: { change: (e) => changeYard(y.id, (q) => { q.smooth = e.target.checked; }) } }), "Curved"),
      el("span.small.muted", "Ctrl+click another flat shape to pick both, then Merge: paths whose ends meet become one walkway; others become one shape."),
      el("div.row", { style: { gap: "8px", flexWrap: "wrap" } },
        el("button.btn", { type: "button", on: { click: () => { ui.yard = null; paint(); } } }, "Done"),
        y.parts ? el("button.btn", { type: "button", on: { click: () => splitYard(y.id) } }, "Split apart") : null,
        el("button.btn.danger", { type: "button", on: { click: () => { ui.yard = null; changeYard(y.id, () => false); } } }, "Delete")));
  }
  function yardManyPanel(ids) {
    const names = ids.map((id) => yardShape(id)).filter(Boolean).map((y) => y.name || y.kind);
    return el("aside.card.accent.hm-insp", { "aria-label": "Picked yard shapes" },
      el("h2", `${ids.length} picked`), el("span.small", names.join(", ")),
      el("span.small.muted", "Merge makes them one: paths whose ends meet become one walkway (an L), others one shape. An area keeps its name and kind (the first area picked); a path merged with an area becomes part of the area."),
      el("div.row", { style: { gap: "8px", flexWrap: "wrap" } },
        el("button.btn.primary", { type: "button", on: { click: () => mergeYard(ids) } }, "Merge"),
        el("button.btn", { type: "button", on: { click: () => { ui.yardPicks = []; paint(); } } }, "Cancel"),
        el("button.btn.danger", { type: "button", on: { click: () => { const drop = new Set(ids); ui.yard = null; ui.yardPicks = []; saveSite((s) => { s.yard = s.yard.filter((q) => !drop.has(q.id)); }); } } }, "Delete them")));
  }

  // A window or door, changed on the front photo's drawing (its own metres there; the same
  // distances as in 3D)
  async function changeOpening(id, fn) {
    const f = JSON.parse(JSON.stringify(house.facade));
    const o = (f.openings || []).find((q) => q.id === id);
    if (!o) return;
    if (fn(o) === false) f.openings = f.openings.filter((q) => q.id !== id);
    const ok = await run(async () => { house = await api("api/house/facade", { method: "PUT", body: f }); return true; });
    if (!ok) house = await api("api/house");
    if (facade) facade.load(house.facade);
    paint();
  }
  function openingPanel(o) {
    const fmt = L.fmtLen;
    const KIND = { window: "Window", door: "Door", garage: "Garage door" };
    const len = (label, value, set) => el("label.field", el("span", label),
      el("input.input", { value: fmt(value), inputmode: "decimal", on: { change: (e) => {
        const v = L.parseLen(e.target.value);
        if (!Number.isFinite(v)) { toast("Give a length, like 2' 6 1/2\""); e.target.value = fmt(value); return; }
        changeOpening(o.id, (q) => set(q, v));
      } } }));
    return el("aside.card.accent.hm-insp", { "aria-label": "Picked window or door" },
      el("div", el("h2", KIND[o.kind] || "Opening"), el("span.small.muted", "On the front wall of its block. Drag it along the wall in the view, an inch at a time (Alt: free), or type here.")),
      el("label.field", el("span", "Kind"), el("select", { on: { change: (e) => changeOpening(o.id, (q) => { q.kind = e.target.value; }) } },
        Object.entries(KIND).map(([k, label]) => el("option", { value: k, selected: o.kind === k ? "" : null }, label)))),
      el("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px" } },
        len("Width", o.x1 - o.x0, (q, v) => { if (v > 0.1) q.x1 = q.x0 + v; }),
        len("Height", o.z1 - o.z0, (q, v) => { if (v > 0.1) q.z1 = q.z0 + v; }),
        len("From the left of the house", o.x0, (q, v) => { const d = v - o.x0; q.x0 += d; q.x1 += d; }),
        len(o.kind === "window" ? "Sill above the ground" : "Bottom above the ground", o.z0, (q, v) => { const d = v - o.z0; q.z0 += d; q.z1 += d; })),
      el("div.row", { style: { gap: "8px", flexWrap: "wrap" } },
        el("button.btn", { type: "button", on: { click: () => { ui.opening = null; paint(); } } }, "Done"),
        el("button.btn.danger", { type: "button", on: { click: () => { ui.opening = null; changeOpening(o.id, () => false); } } }, "Delete")));
  }
  function inspector() {
    if (ui.view === "3d" && ui.mode3d === "shape" && ui.blockPicks && ui.blockPicks.length > 1) {
      const names = ui.blockPicks.map((id, i) => (house.massing.blocks.find((q) => q.id === id) || {}).name || `Block ${i + 1}`);
      return el("aside.card.accent.hm-insp", { "aria-label": "Picked blocks" }, el("h2", `${ui.blockPicks.length} blocks picked`), el("span.small", names.join(", ")),
        el("span.small.muted", "Join makes them one shape: one outline, no wall between them, moved together. Each keeps its own floor, so a landing a few steps down stays a few steps down."),
        el("div.row", { style: { gap: "8px" } }, el("button.btn.primary", { type: "button", on: { click: () => joinBlocks(ui.blockPicks) } }, "Join"),
          el("button.btn", { type: "button", on: { click: () => { ui.blockPicks = []; paint(); } } }, "Cancel")));
    }
    if (ui.view === "3d" && ui.mode3d === "shape" && ui.stair) {
      const st = house.top && (house.top.stairs || []).find((q) => q.id === ui.stair);
      if (st) return stairPanel(st);
    }
    if (ui.view === "3d" && ui.mode3d === "shape" && ui.yardPicks && ui.yardPicks.length > 1) return yardManyPanel(ui.yardPicks);
    if (ui.view === "3d" && ui.mode3d === "shape" && ui.yard) {
      const y = yardShape(ui.yard);
      if (y) return yardPanel(y);
    }
    if (ui.view === "3d" && ui.mode3d === "shape" && ui.opening) {
      const o = house.massing && house.massing.openings.find((q) => q.id === ui.opening);
      if (o) return openingPanel(o);
    }
    if (ui.view === "3d" && ui.mode3d === "shape") {
      const b = ui.block && house.massing && house.massing.blocks.find((q) => q.id === ui.block);
      return b ? blockPanel(b) : null;
    }
    const t = ui.sel && target(ui.sel);
    if (!t) return null;
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
    const multi = t.fixtures > 0;
    // a light whose parts aren't its own segments can be several fixtures on one switch
    // a light, or a group of lights (on the Lights page), whose parts aren't its own segments
    const canMulti = (t.kind === "light" || t.kind === "fixture") && item && (multi || !t.parts.length);
    const fixturesBox = canMulti ? el("section", { "aria-label": "Fixtures", style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
      el("label.check", el("input", { type: "checkbox", checked: multi, on: { change: (e) => setFixtures(t, e.target.checked ? startFixtures(t) : 0) } }),
        "Multiple fixtures on this switch"),
      multi ? el("label.field", el("span", "How many fixtures"),
        el("input.input", { type: "number", min: 2, max: 50, step: 1, value: t.fixtures, style: { width: "100px" },
          on: { change: (e) => { const n = Math.round(Number(e.target.value)); if (!(n >= 2 && n <= 50)) { toast("2 to 50 fixtures"); e.target.value = t.fixtures; return; } setFixtures(t, n); } } }))
        : el("span.small.muted", "For cans or other lights that one switch or dimmer turns on together: place each one where it is.")) : null;
    const parts = t.parts.length ? el("section", { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: multi ? "0" : "1px solid var(--line)", paddingTop: multi ? "0" : "12px" } },
      el("div.card-head", el("h3", multi ? `Fixtures (${t.parts.length})` : `Parts (${t.parts.length})`),
        el("button.btn.small", { type: "button", disabled: !item && false, "aria-pressed": String(!!ui.mode),
          on: { click: () => { ui.mode = ui.mode ? null : "line-start"; ui.lineStart = null; paint(); if (ui.mode) toast("In 3D, tap where the first one is"); } } },
          ui.mode ? "Cancel line" : "Lay out along a line")),
      el("span.small.muted", multi ? "Select a fixture, then tap where it is in 3D or the Top view, or drag it in 3D. The dashed line shows they're on one switch."
        : "Select a part, then tap where it goes in 3D or the Top view. Flash shows which one it is."),
      t.parts.map((p) => el("div.row", { style: { gap: "8px", padding: "6px 8px", borderRadius: "10px", flexWrap: "nowrap",
        background: ui.part === p.index ? "var(--accent-soft)" : "var(--card2)" } },
        el("button", { type: "button", "aria-pressed": String(ui.part === p.index), on: { click: () => { ui.part = ui.part === p.index ? null : p.index; paint(); } },
          style: { flex: "1", minWidth: "0", textAlign: "left", border: 0, background: "none", color: "var(--text)", cursor: "pointer", minHeight: "36px", display: "flex", alignItems: "center", gap: "8px" } },
          el("span", { style: { width: "8px", height: "8px", borderRadius: "50%", flex: "none", ...(p.placed ? { background: "var(--info)" } : { border: "2px solid var(--faint)" }) } }), p.label),
        multi ? null : el("button.btn.small", { type: "button", disabled: status?.read_only, on: { click: () => identify(p.index) } }, "Flash")))) : null;

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
      item && !(t.fixtures > 0) && !t.parts.length ? formPanel(t) : null,
      item ? beamPanel(t) : null,
      el("div.row", { style: { gap: "8px" } },
        el("button.btn.primary", { type: "button", disabled: status?.read_only, style: { flex: "1" }, on: { click: () => identify(undefined) } }, "Flash it"),
        item ? el("button.btn", { type: "button", on: { click: removeItem } }, "Remove") : null),
      fixturesBox,
      parts);
  }

  // ---- what a light looks like: a bulb, or a bar or strip with a length, lie and facing ---------

  async function setForm(t, form) {
    await run(async () => { house = await api(`api/house/items/${encodeURIComponent(t.id)}/form`, { method: "PUT", body: form }); });
    paint();
  }
  function formPanel(t) {
    const f = t.item.form || null;
    const kind = f ? f.form : "bulb";
    const send = (change) => setForm(t, { ...(f || { length: 1.0, rot: 0, face: "down" }), ...change });
    const lieText = (v) => { v = Math.round(v) % 180; return v === 0 ? "across" : v === 90 ? "front to back" : `${v}°`; };
    const lie = el("span.mono", lieText(f ? f.rot : 0));
    return el("section", { "aria-label": "What it looks like", style: { display: "flex", flexDirection: "column", gap: "10px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
      el("div.field", el("span", "What it looks like"),
        el("div.seg", { role: "radiogroup", "aria-label": "What it looks like" }, [["bulb", "Bulb"], ["bar", "Bar lamp"], ["strip", "Strip"]].map(([k, label]) =>
          el("button", { type: "button", role: "radio", "aria-checked": String(kind === k), on: { click: () => (k === "bulb" ? setForm(t, null) : send({ form: k, length: f ? f.length : k === "bar" ? 1.0 : 2.0 })) } }, label)))),
      f ? [
        el("label.field", el("span", "Length"), el("input.input", { value: L.fmtLen(f.length), inputmode: "decimal", style: { width: "120px" },
          on: { change: (e) => { const v = L.parseLen(e.target.value); if (!(v >= 0.05 && v <= 30)) { toast("2 in to 100 ft"); e.target.value = L.fmtLen(f.length); return; } send({ length: v }); } } })),
        el("label.field", el("span", "Lies", lie), el("input", { type: "range", min: 0, max: 179, step: 1, value: Math.round(f.rot) % 180,
          on: { input: (e) => { lie.textContent = lieText(Number(e.target.value)); }, change: (e) => send({ rot: Number(e.target.value) + (f.rot >= 180 ? 180 : 0) }) } })),
        el("div.field", el("span", "Shines"),
          el("div.seg", { role: "radiogroup", "aria-label": "Shines" }, [["down", "Down"], ["up", "Up"], ["side", "Sideways"]].map(([k, label]) =>
            el("button", { type: "button", role: "radio", "aria-checked": String(f.face === k), on: { click: () => send({ face: k }) } }, label)))),
        f.face === "side" ? el("button.btn.small", { type: "button", on: { click: () => send({ rot: (f.rot + 180) % 360 }) } }, "Shine the other way") : null,
      ] : el("span.small.muted", "For a light bar, a lamp with a long shade, or an LED strip: give its length, which way it lies, and which way it shines."));
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

  // ---- the tool bar, the rail and the panes -------------------------------------------------------

  const NS = "http://www.w3.org/2000/svg";
  function svgI(d, size = 20) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", String(size)); s.setAttribute("height", String(size)); s.setAttribute("aria-hidden", "true");
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "1.8");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.append(p);
    return s;
  }
  const I = {
    move: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3",
    raise: "M12 20V4M7 9l5-5 5 5M5 20h14",
    shape: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
    add: "M12 5v14M5 12h14",
    split: "M4 5h16v14H4zM12 5v14",
    aim: "M12 12l8-5v10zM4 12h8M4 9v6",
    home: "M3 11l9-8 9 8M5 10v10h14V10",
    front: "M4 5h16v14H4zM9 19v-6h6v6",
    top: "M4 12l8-6 8 6-8 6z",
    side: "M4 19V9l8-5 8 5v10z",
    bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z",
    levels: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
    rooms: "M4 4h16v16H4zM4 12h9M13 4v16",
    blocks: "M3 20V10h8v10M11 20V6h10v14M3 20h18",
    yard: "M12 3a5 5 0 0 0-5 5c0 3 5 9 5 9s5-6 5-9a5 5 0 0 0-5-5zM4 21h16",
    fold: "M15 6l-6 6 6 6",
    join: "M3 6h8v12H3zM13 6h8v12h-8zM11 12h2",
    stairs: "M4 20h4v-4h4v-4h4V8h4",
    dims: "M3 7v10M21 7v10M3 12h18M7 9l-4 3 4 3M17 9l4 3-4 3",
    solid: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
    path: "M4 20c4-2 4-6 8-8s4-6 8-8",
    area: "M4 8l6-4 10 4v10l-10 2-6-4z",
    merge: "M4 6h6v6H4zM14 12h6v6h-6zM10 9h2a2 2 0 0 1 2 2v1",
  };
  // One tool: an icon over a short name
  function tool(label, iconD, { pressed = null, disabled = false, title = null, click }) {
    return el("button.hm-tool", { type: "button", title: title || label, "aria-pressed": pressed === null ? null : String(pressed),
      disabled: disabled ? "" : null, on: { click } }, svgI(iconD), el("span", label));
  }
  function pickedBlock() { return ui.block && house.massing ? house.massing.blocks.find((q) => q.id === ui.block) || null : null; }
  function setMode3d(k) { ui.mode3d = k; if (k !== "shape") { ui.block = null; ui.opening = null; ui.yard = null; ui.yardPicks = []; ui.stair = null; ui.blockPicks = []; } ui.aiming = false; paint(); }
  // The 3D view's tools, in groups, with the level shown at the right
  function tools3d() {
    const b = ui.mode3d === "shape" ? pickedBlock() : null;
    const t = ui.sel && target(ui.sel);
    const canAim = !!(t && t.item && t.item.aim);
    const W = window.House3D;
    const grp = (...xs) => el("div.hm-grp", { role: "group" }, ...xs);
    return [
      grp(tool("Move", I.move, { pressed: ui.mode3d === "move", title: "Drag a light across its floor", click: () => setMode3d("move") }),
        tool("Raise", I.raise, { pressed: ui.mode3d === "raise", title: "Drag a light up or down", click: () => setMode3d("raise") }),
        tool("Shape", I.shape, { pressed: ui.mode3d === "shape", title: "Pick a house block and drag its faces", click: () => setMode3d("shape") })),
      grp(tool("Add block", I.add, { disabled: !house.massing, title: house.massing ? "Add a house block (beside the picked one)" : "Draw the house on the Front photo first",
        click: () => { ui.mode3d = "shape"; addBlock(b); } }),
        tool("Join", I.join, { disabled: !(ui.mode3d === "shape" && ui.blockPicks && ui.blockPicks.length > 1), title: "Ctrl+click two or more blocks, then join them into one shape", click: () => joinBlocks(ui.blockPicks) }),
        tool("Stairs", I.stairs, { disabled: !b, title: b ? "Add stairs in the picked block, down to the floor below it" : "Pick a block in Shape first", click: () => addStairs(b) }),
        tool("Split", I.split, { disabled: !b, title: b ? "Split the picked block front to back, in half (set where in the panel)" : "Pick a block in Shape first",
          click: () => splitBlock(b.id, Math.round((b.depth / 2) / 0.0254) * 0.0254) })),
      grp(tool("Add path", I.path, { title: "Add a path or walkway on the ground", click: () => addYard("path") }),
        tool("Add area", I.area, { title: "Add a driveway, patio or other flat area", click: () => addYard("area") }),
        tool("Merge", I.merge, { disabled: !(ui.mode3d === "shape" && ui.yardPicks && ui.yardPicks.length > 1), title: "Ctrl+click two flat shapes, then merge them into one", click: () => mergeYard(ui.yardPicks) })),
      grp(tool("Aim", I.aim, { pressed: !!ui.aiming, disabled: !canAim, title: canAim ? "Click what the picked light should point at" : "Pick a flood or spot light first",
        click: () => { ui.aiming = !ui.aiming; paint(); } })),
      grp(tool("Solid", I.solid, { pressed: !!ui.solid, title: "Solid walls and ground, lit by your lights as they are now", click: () => { ui.solid = !ui.solid; L.save("house.solid", ui.solid); if (ui.solid) refreshLooks(); paint(); } })),
      grp(tool("Dimensions", I.dims, { pressed: !!ui.dims, title: "Show each block's size", click: () => { ui.dims = !ui.dims; L.save("house.dims", ui.dims); paint(); } }),
        ui.dims ? el("div.seg", { role: "radiogroup", "aria-label": "Dimensions measured", style: { marginLeft: "4px" } },
          [[true, "Inside"], [false, "Overall"]].map(([v, label]) => el("button", { type: "button", role: "radio", "aria-checked": String(!!ui.dimsInside === v),
            title: v ? "As a tape reads inside the room: less the walls" : "To the outside faces", on: { click: () => { ui.dimsInside = v; L.save("house.dimsInside", v); paint(); } } }, label))) : null),
      grp(tool("Home", I.home, { click: () => view3d && view3d.animateTo(-0.55, 0.62, { x: 0, y: 0, z: 0 }) }),
        tool("Front", I.front, { title: "Look from the street", click: () => view3d && view3d.lookFrom({ x: 0, y: -1, z: 0 }) }),
        tool("Top", I.top, { title: "Look down from above", click: () => view3d && view3d.lookFrom({ x: 0, y: 0, z: 1 }) }),
        tool("Side", I.side, { title: "Look from the right side", click: () => view3d && view3d.lookFrom({ x: 1, y: 0, z: 0 }) })),
      W ? el("span.hm-fill") : null,
      el("div.chips", { role: "group", "aria-label": "Level shown" },
        [...house.floors.map((f) => [f.id, f.name]), [house.outside, "Outside"]].map(([id, name]) =>
          el("button.chip", { type: "button", "aria-pressed": String(ui.floor === id), on: { click: () => { ui.floor = id; paint(); } } }, name))),
    ];
  }

  const PANES = [
    ["lights", "Lights", I.bulb], ["levels", "Levels", I.levels], ["rooms", "Rooms", I.rooms],
    ["blocks", "House blocks", I.blocks], ["yard", "Yard", I.yard],
  ];
  function openPane(k) { ui.panel = ui.panel === k ? "" : k; L.save("house.panel", ui.panel); paint(); }
  function rail() {
    return el("nav.hm-rail", { "aria-label": "Panels" }, PANES.map(([k, label, d]) =>
      el("button", { type: "button", title: label, "aria-label": label, "aria-pressed": String(ui.panel === k), on: { click: () => openPane(k) } }, svgI(d, 22))));
  }
  function paneHead(title) {
    return el("div.hm-pane-head", el("h2", title),
      el("button.hm-fold", { type: "button", title: "Fold away", "aria-label": `Fold the ${title.toLowerCase()} away`, on: { click: () => openPane(ui.panel) } }, svgI(I.fold, 18)));
  }
  const rowBtn = (on, click, ...kids) => el("button.hm-row", { type: "button", "aria-pressed": String(!!on), on: { click } }, ...kids);
  function placedOn(id) {
    const here = house.targets.filter((t) => (floorsById().has(t.floor_id) ? t.floor_id : house.outside) === id);
    return here.length ? `${here.filter((t) => t.placed).length} of ${here.length} placed` : "";
  }
  function levelsPane() {
    return el("div.hm-pane", { "aria-label": "Levels" }, paneHead("Levels"),
      el("span.small.muted", "Your Home Assistant floors, top down. Tap one to show it in 3D and in the Top view."),
      [...house.floors].sort((a, b) => b.elevation - a.elevation).map((f) => rowBtn(ui.floor === f.id, () => { ui.floor = f.id; if (site) site.level = f.id; paint(); },
        el("span", { style: { flex: "1" } }, f.name), el("span.small.muted", placedOn(f.id)))),
      rowBtn(ui.floor === house.outside, () => { ui.floor = house.outside; if (site) site.level = house.outside; paint(); }, el("span", { style: { flex: "1" } }, "Outside"), el("span.small.muted", placedOn(house.outside))),
      el("button.btn.small", { type: "button", on: { click: () => { ui.settings = true; paint(); } } }, "Floors & size"));
  }
  // Rooms and yard shapes are drawn in the Top view: a tap there shows and picks one
  function showInTop(sel, level) {
    ui.view = "top"; L.save("house.view", "top");
    ensureSite();
    if (level) site.level = level;
    site.sel = sel;
    paint();
  }
  function roomsPane() {
    const rooms = (house.site && house.site.rooms) || [];
    const areas = new Map(inventory.areas.map((a) => [a.id, a.name]));
    const levels = [...house.floors].sort((a, b) => b.elevation - a.elevation).filter((f) => rooms.some((r) => r.level === f.id));
    return el("div.hm-pane", { "aria-label": "Rooms" }, paneHead("Rooms"),
      rooms.length ? levels.map((f) => el("div.hm-group", el("span.hm-glabel", f.name),
        rooms.filter((r) => r.level === f.id).map((r) => rowBtn(site && site.sel && site.sel.kind === "room" && site.sel.id === r.id && ui.view === "top",
          () => showInTop({ kind: "room", id: r.id }, r.level), el("span", { style: { flex: "1" } }, r.name || areas.get(r.area) || "Room")))))
        : el("p.small.muted", { style: { margin: 0 } }, "No rooms yet. In the Top view, draw the walls of a level, then use the Room tool to name each room."));
  }
  const YARD = { path: "Path", driveway: "Driveway", patio: "Patio", pool: "Pool", bed: "Garden bed", lawn: "Lawn", tree: "Tree", bush: "Bush" };
  function yardPane() {
    const yard = (house.site && house.site.yard) || [];
    return el("div.hm-pane", { "aria-label": "Yard" }, paneHead("Yard"),
      yard.length ? yard.map((y) => rowBtn(site && site.sel && site.sel.kind === "yard" && site.sel.id === y.id && ui.view === "top",
        () => showInTop({ kind: "yard", id: y.id }, house.outside), el("span", { style: { flex: "1" } }, y.name || YARD[y.kind] || "Yard shape")))
        : el("p.small.muted", { style: { margin: 0 } }, "No yard shapes yet. In the Top view, use the Yard tool to draw paths, the driveway, beds and trees."));
  }
  function blocksPane() {
    const blocks = (house.massing && house.massing.blocks) || [];
    const pick = (id) => { ui.view = "3d"; L.save("house.view", "3d"); ui.mode3d = "shape"; ui.block = id; paint(); };
    return el("div.hm-pane", { "aria-label": "House blocks" }, paneHead("House blocks"),
      blocks.length ? blocks.map((b, i) => rowBtn(ui.view === "3d" && ui.mode3d === "shape" && ui.block === b.id, () => pick(b.id),
        el("span", { style: { flex: "1" } }, b.name || `Block ${i + 1}`), el("span.small.muted", b.behind ? "added" : "photo")))
        : el("p.small.muted", { style: { margin: 0 } }, "The house's blocks come from the Front photo: draw the house there first."),
      house.massing ? el("button.btn.small", { type: "button", on: { click: () => { ui.view = "3d"; ui.mode3d = "shape"; addBlock(pickedBlock()); } } }, "Add a block") : null);
  }
  function leftPane() {
    return { lights: listPanel, levels: levelsPane, rooms: roomsPane, blocks: blocksPane, yard: yardPane }[ui.panel]?.() || null;
  }

  // ---- paint ----------------------------------------------------------------------------------

  let views = null;
  let listBox = null; // the open left pane (it scrolls)
  function repaintViews() {
    if (!views) return;
    if (ui.view === "3d") { view3d.mode = ui.mode3d; view3d.aimMode = !!ui.aiming; view3d.setScene(scene3d()); return; }
  }
  function paintList() {
    if (!listBox) return;
    const top = listBox.scrollTop;
    L.set(listBox, leftPane());
    listBox.scrollTop = top;
  }
  let inspBox = null; // the right panel
  function paintSide() {
    paintList();
    if (inspBox && ui.view === "3d") { const c = inspector(); L.set(inspBox, c); inspBox.hidden = !c; }
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
    const viewTabs = el("div.tabs", { role: "tablist", "aria-label": "View" },
      [["3d", "3D"], ["photo", "Front photo"], ["top", "Top view"]].map(([k, label]) => el("button", { type: "button", role: "tab", "aria-selected": String(ui.view === k),
        on: { click: () => { ui.view = k; L.save("house.view", k); paint(); } } }, label)));
    L.topExtra().replaceChildren(...[viewTabs, el("span.hm-fill"), checksButton(), el("span.small.muted", `${placed} of ${house.targets.length} placed`),
      el("button.btn.small", { type: "button", "aria-expanded": String(ui.settings), on: { click: () => { ui.settings = !ui.settings; paint(); } } }, "Floors & size")].filter(Boolean));
    views = {};
    const pane = leftPane();
    listBox = el("aside.hm-left", { hidden: pane ? null : "" }, pane);
    inspBox = el("aside.hm-right");
    let bar, stage;
    if (ui.view === "3d") {
      ensure3d();
      const t = ui.sel && target(ui.sel);
      const lineBanner = ui.mode ? el("div.banner", { style: { fontSize: "14px" } }, ui.mode === "line-start" ? "Tap where the first part is." : "Now tap where the last part is.") : null;
      const hint = ui.mode3d === "shape" && ui.yardPicks && ui.yardPicks.length > 1 ? "Ctrl+click more to add them, then Merge in the tool bar or the panel."
        : ui.mode3d === "shape" && ui.yard ? "Drag the shape to move it, its white corners to shape it (an inch at a time; Alt: free). Ctrl+click another to merge them."
        : ui.mode3d === "shape" && ui.opening ? "Drag the window or door along its wall, or type in the panel. Tap a house block to pick it instead."
        : ui.mode3d === "shape" ? (ui.block ? "Drag a yellow handle to move that face, or drag the block to move it (Shift+drag: up and down; Alt: no snapping). Or type amounts in the panel." : "Tap a house block, a window or door, or a path or driveway on the ground to pick it. Or add one from the tool bar.")
        : ui.aiming && t ? `Click what ${t.name} should point at: a wall, the ground, or a tree. Drag to turn the view first if you need to.`
        : !t ? "Pick a light: open Lights on the left, or tap one in the view."
        : !t.placed ? `Tap where ${t.name} is on the ${floorName(ui.floor)} floor.`
        : ui.mode3d === "raise" ? "Drag the picked light up or down."
        : "Drag the picked light to move it. Tap anywhere else to let go of it.";
      bar = tools3d();
      stage = [lineBanner, canvas3d, el("span.small.muted", hint)];
      const c = inspector();
      L.set(inspBox, c); inspBox.hidden = !c;
    } else {
      const ed = ui.view === "top" ? (ensureSite(), site) : (ensureFacade(), facade);
      // the editor's tools go in the tool bar, its options and panel on the right
      bar = [ed.toolbar];
      ed.toolbar.setAttribute("aria-orientation", "horizontal");
      stage = [ed.root];
      L.set(inspBox, ed.optionsBar, ed.inspEl);
    }
    L.set(page,
      settingsPanel(),
      el("div.hm-cad", { "aria-label": "House map" },
        el("div.hm-bar", { role: "toolbar", "aria-label": ui.view === "3d" ? "3D tools" : "Drawing tools" }, bar),
        el("div.hm-work",
          rail(), listBox,
          el("section.hm-stage", { "aria-label": { "3d": "The house in 3D", top: "The house from above", photo: "The front photo" }[ui.view] }, stage),
          inspBox)));
    repaintViews();
    if (ui.view === "photo") facade.paint();
    if (ui.view === "top") site.paint();
  }

  // Redraw once the status says which units HA uses (and whenever that changes)
  let shownUnits = null;
  onData((d) => {
    status = d.status;
    if (ui.solid && ui.view === "3d" && house) refreshLooks();
    if (house && L.units() !== shownUnits) { shownUnits = L.units(); if (!L.typing()) paint(); }
  });
  load().then(() => { paint(); start(15000); if (ui.solid) refreshLooks(); }).catch((e) => L.set(page, el("div.empty", `Couldn't load the house map: ${e.message}`)));
})();
