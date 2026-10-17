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
        id: t.id, label: t.name, x: t.world.x, y: t.world.y, z: t.world.z, floorZ: floorZ(t.item.floor), aim: t.item.aim || null, floor: t.item.floor, linked: t.fixtures > 0,
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
      onBlock: (id) => { ui.block = id; paint(); },
      onFace: async (id, face, delta, done, alt) => {
        const b = house.massing && house.massing.blocks.find((q) => q.id === id);
        if (!b) return;
        if (!ui.faceBase || ui.faceBase.id !== id) ui.faceBase = { ...b };
        const base = ui.faceBase;
        const change = alt ? faceChange(base, face, delta) : snapChange(base, faceChange(base, face, delta));
        Object.assign(b, change);
        view3d.setScene(scene3d());
        if (done) { ui.faceBase = null; await changeBlock(id, change); }
      },
      onBlockMove: async (id, dx, dy, dz, done, alt) => {
        const b = house.massing && house.massing.blocks.find((q) => q.id === id);
        if (!b) return;
        if (!b.behind) { if (done) toast("This block is drawn on the front photo: move it there, or drag its faces here"); return; }
        if (!ui.faceBase || ui.faceBase.id !== id) ui.faceBase = { ...b };
        const base = ui.faceBase;
        const m = alt ? { dx, dy, dz } : snapMove(base, dx, dy, dz);
        const change = moveChange(base, m);
        Object.assign(b, change);
        view3d.setScene(scene3d());
        if (done) { ui.faceBase = null; await changeBlock(id, change); }
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
  async function changeBlock(id, change) {
    const ok = await run(async () => { house = await api(`api/house/blocks/${encodeURIComponent(id)}`, { method: "PUT", body: change }); return true; });
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
      el("button.btn.small", { type: "button", on: { click: () => changeBlock(b.id, moveChange(b, { dx: v.across, dy: v.back, dz: v.up })) } }, "Move"),
      el("span.small.muted", "Less than 0 moves the other way (left, toward the street, down). In the view: drag the block across the ground, Shift+drag it up or down, or drag one of its arrows; hold Alt to stop snapping."));
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
      el("label.field", el("span", "Name"), el("input.input", { value: b.name || "", on: { change: (e) => changeBlock(b.id, { name: e.target.value }) } })),
      el("dl", { class: "fc-kv" }, el("dt", "Width"), el("dd", fmt(b.x1 - b.x0)), el("dt", "Front to back"), el("dd", fmt(b.depth)),
        el("dt", "Height"), el("dd", fmt(b.z1 - b.z0)), el("dt", "Top"), el("dd", `${fmt(b.z1)} up`)),
      el("section", { "aria-label": "Move a face", style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
        el("h3", "Move a face"),
        el("select.input", { on: { change: (e) => { ui.moveFace = e.target.value; } } }, faces.map((f) => el("option", { value: f.face, selected: f.face === ui.moveFace ? "" : null }, f.label))),
        el("div.row", { style: { gap: "8px" } }, amountInput,
          el("button.btn.small", { type: "button", on: { click: () => changeBlock(b.id, faceChange(b, ui.moveFace, amount)) } }, "Out"),
          el("button.btn.small", { type: "button", on: { click: () => changeBlock(b.id, faceChange(b, ui.moveFace, -amount)) } }, "In")),
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

  function inspector() {
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
    const canMulti = t.kind === "light" && item && (multi || !t.parts.length);
    const fixturesBox = canMulti ? el("section", { "aria-label": "Fixtures", style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "12px" } },
      el("label.check", el("input", { type: "checkbox", checked: multi, on: { change: (e) => setFixtures(t, e.target.checked ? 2 : 0) } }),
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
      item ? beamPanel(t) : null,
      el("div.row", { style: { gap: "8px" } },
        el("button.btn.primary", { type: "button", disabled: status?.read_only, style: { flex: "1" }, on: { click: () => identify(undefined) } }, "Flash it"),
        item ? el("button.btn", { type: "button", on: { click: removeItem } }, "Remove") : null),
      fixturesBox,
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
  };
  // One tool: an icon over a short name
  function tool(label, iconD, { pressed = null, disabled = false, title = null, click }) {
    return el("button.hm-tool", { type: "button", title: title || label, "aria-pressed": pressed === null ? null : String(pressed),
      disabled: disabled ? "" : null, on: { click } }, svgI(iconD), el("span", label));
  }
  function pickedBlock() { return ui.block && house.massing ? house.massing.blocks.find((q) => q.id === ui.block) || null : null; }
  function setMode3d(k) { ui.mode3d = k; if (k !== "shape") ui.block = null; ui.aiming = false; paint(); }
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
        tool("Split", I.split, { disabled: !b, title: b ? "Split the picked block front to back, in half (set where in the panel)" : "Pick a block in Shape first",
          click: () => splitBlock(b.id, Math.round((b.depth / 2) / 0.0254) * 0.0254) })),
      grp(tool("Aim", I.aim, { pressed: !!ui.aiming, disabled: !canAim, title: canAim ? "Click what the picked light should point at" : "Pick a flood or spot light first",
        click: () => { ui.aiming = !ui.aiming; paint(); } })),
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
  function levelsPane() {
    const fmt = L.fmtLen;
    return el("div.hm-pane", { "aria-label": "Levels" }, paneHead("Levels"),
      el("span.small.muted", "Your Home Assistant floors, bottom up from the ground outside. Tap one to show it in 3D and in the Top view."),
      [...house.floors].sort((a, b) => b.elevation - a.elevation).map((f) => rowBtn(ui.floor === f.id, () => { ui.floor = f.id; if (site) site.level = f.id; paint(); },
        el("span", { style: { flex: "1" } }, f.name), el("span.small.muted.mono", `${fmt(f.elevation)} · ${fmt(f.ceiling)}`))),
      rowBtn(ui.floor === house.outside, () => { ui.floor = house.outside; if (site) site.level = house.outside; paint(); }, el("span", { style: { flex: "1" } }, "Outside")),
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
      const hint = ui.mode3d === "shape" ? (ui.block ? "Drag a yellow handle to move that face, or drag the block to move it (Shift+drag: up and down; Alt: no snapping). Or type amounts in the panel." : "Tap a house block to pick it, or Add block in the tool bar.")
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
    if (house && L.units() !== shownUnits) { shownUnits = L.units(); if (!L.typing()) paint(); }
  });
  load().then(() => { paint(); start(15000); }).catch((e) => L.set(page, el("div.empty", `Couldn't load the house map: ${e.message}`)));
})();
