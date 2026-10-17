// House map: place every light in 3D by hand. Plan from above (across, back) and a side view from
// the street (height). Floors come from HA; the house is a box of your size; no floorplan needed.
"use strict";

(function () {
  const { el, icon, api, run, toast, onData, start } = L;
  const page = document.getElementById("page");
  const SVG = "http://www.w3.org/2000/svg";
  const params = new URLSearchParams(location.search);

  const ui = {
    sel: params.get("select") || null, // target id
    part: null,                         // selected part index of the selected target
    floor: null,                        // floor shown in the plan
    mode: null,                         // null | "line-start" | "line-end"
    lineStart: null,
    search: "",
    settings: false,
    drag: null,
    view: L.store("house.view", "3d"), // "3d" | "flat"
    mode3d: "move",                     // "move" | "raise" in the 3D view
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

  // ---- geometry ----------------------------------------------------------------------------

  function bounds() {
    const W = house.size.width, D = house.size.depth;
    return { x0: -6, x1: W + 6, y0: -12, y1: D + 3 };
  }
  function zBounds() {
    const tops = house.floors.map((f) => f.elevation + f.ceiling);
    const bottoms = house.floors.map((f) => f.elevation);
    return { z0: Math.min(-1, ...bottoms) - 0.6, z1: Math.max(4, ...tops) + 0.8 };
  }
  function svgPoint(svg, evt) {
    const p = svg.createSVGPoint();
    p.x = evt.clientX; p.y = evt.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }
  function s(tag, attrs, ...kids) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) n.setAttribute(k, v);
    for (const k of kids.flat()) if (k) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  const r2 = (v) => L.snapLen(v); // a whole inch, or 5 cm

  // ---- plan view (from above) -----------------------------------------------------------------

  function planView() {
    const b = bounds(), W = house.size.width, D = house.size.depth;
    const vb = `${b.x0} ${-b.y1} ${b.x1 - b.x0} ${b.y1 - b.y0}`; // y flipped: svg y = -y
    const svg = s("svg", { viewBox: vb, role: "img", "aria-label": `Plan from above, ${floorName(ui.floor)}`,
      style: "width:100%;height:auto;display:block;touch-action:none;background:var(--field);border-radius:10px;cursor:crosshair" });
    const grid = s("g", { stroke: "var(--line)", "stroke-width": 0.03 });
    // Grid lines every foot (heavier every 5 ft), or every metre (heavier every 5 m)
    const step = L.units() === "imperial" ? L.FT : 1;
    for (let i = Math.ceil(b.x0 / step); i * step <= b.x1; i++) grid.append(s("line", { x1: i * step, y1: -b.y1, x2: i * step, y2: -b.y0, "stroke-width": i % 5 ? 0.02 : 0.05 }));
    for (let i = Math.ceil(b.y0 / step); i * step <= b.y1; i++) grid.append(s("line", { x1: b.x0, y1: -i * step, x2: b.x1, y2: -i * step, "stroke-width": i % 5 ? 0.02 : 0.05 }));
    svg.append(grid);
    // the house, and which part of it this floor covers
    svg.append(s("rect", { x: 0, y: -D, width: W, height: D, fill: "var(--card2)", stroke: "var(--faint)", "stroke-width": 0.08, rx: 0.1 }));
    const f = floorsById().get(ui.floor);
    if (f) {
      const x0 = f.x0 ?? 0, x1 = f.x1 ?? W;
      svg.append(s("rect", { x: x0, y: -D, width: Math.max(0, x1 - x0), height: D, fill: "var(--accent)", "fill-opacity": 0.08,
        stroke: "var(--accent)", "stroke-opacity": 0.5, "stroke-width": 0.05, "stroke-dasharray": "0.3 0.2" }));
    }
    svg.append(s("text", { x: 0.2, y: -D + 0.7, "font-size": 0.55, fill: "var(--muted)" }, `${floorName(ui.floor)} · ${L.fmtLen(W)} × ${L.fmtLen(D)}`));
    svg.append(s("text", { x: b.x1 - 0.3, y: -b.y0 - 0.4, "font-size": 0.55, fill: "var(--faint)", "text-anchor": "end" }, "Street ↓"));
    svg.append(s("text", { x: b.x0 + 0.3, y: -b.y0 - 0.4, "font-size": 0.55, fill: "var(--faint)" }, "Yard"));

    // pins
    for (const t of house.targets) {
      if (!t.item) continue;
      const here = t.item.floor === ui.floor || t.item.floor === house.outside;
      const sel = t.id === ui.sel;
      const g = s("g", { opacity: here || sel ? 1 : 0.3, style: "cursor:pointer" });
      for (const p of t.parts) {
        if (!p.world) continue;
        const psel = sel && ui.part === p.index;
        g.append(s("circle", { cx: p.world.x, cy: -p.world.y, r: psel ? 0.28 : 0.16, fill: psel ? "var(--accent)" : "var(--info)", stroke: "var(--bg)", "stroke-width": 0.05,
          "data-part": p.index, "data-target": t.id }));
      }
      g.append(s("circle", { cx: t.item.x, cy: -t.item.y, r: sel ? 0.42 : 0.3, fill: sel ? "var(--accent)" : t.state === "on" ? "#c99a3a" : "var(--faint)",
        stroke: sel ? "var(--on-accent)" : "var(--bg)", "stroke-width": 0.07, "data-target": t.id }));
      if (sel) g.append(s("circle", { cx: t.item.x, cy: -t.item.y, r: 0.75, fill: "none", stroke: "var(--accent)", "stroke-opacity": 0.5, "stroke-width": 0.08 }));
      if (here || sel) g.append(s("text", { x: t.item.x, y: -t.item.y - 0.6, "font-size": 0.45, "text-anchor": "middle", fill: "var(--text)",
        "paint-order": "stroke", stroke: "var(--field)", "stroke-width": 0.15 }, t.name));
      svg.append(g);
    }
    if (ui.mode === "line-end" && ui.lineStart) {
      svg.append(s("circle", { cx: ui.lineStart.x, cy: -ui.lineStart.y, r: 0.25, fill: "var(--info)" }));
    }

    svg.addEventListener("pointerdown", (e) => planDown(svg, e));
    svg.addEventListener("pointermove", (e) => planMove(svg, e));
    svg.addEventListener("pointerup", (e) => planUp(svg, e));
    return svg;
  }

  function planDown(svg, e) {
    const p = svgPoint(svg, e);
    const tid = e.target.getAttribute && e.target.getAttribute("data-target");
    const part = e.target.getAttribute && e.target.getAttribute("data-part");
    if (ui.mode) return; // line clicks are handled on pointerup
    if (tid) {
      if (tid !== ui.sel || (part !== null && Number(part) !== ui.part)) {
        ui.sel = tid; ui.part = part !== null ? Number(part) : null;
        paint();
        return;
      }
      ui.drag = { kind: part !== null ? "part" : "item", start: p, moved: false };
      svg.setPointerCapture(e.pointerId);
    }
  }
  function planMove(svg, e) {
    if (!ui.drag) return;
    const p = svgPoint(svg, e);
    ui.drag.moved = true;
    ui.drag.at = { x: r2(p.x), y: r2(-p.y) };
    const t = target(ui.sel);
    if (ui.drag.kind === "item" && t.item) { t.item.x = ui.drag.at.x; t.item.y = ui.drag.at.y; }
    if (ui.drag.kind === "part") { const pp = t.parts.find((x) => x.index === ui.part); if (pp && pp.world) { pp.world.x = ui.drag.at.x; pp.world.y = ui.drag.at.y; } }
    repaintViews();
  }
  async function planUp(svg, e) {
    const p = svgPoint(svg, e);
    const at = { x: r2(p.x), y: r2(-p.y) };
    if (ui.drag) {
      const d = ui.drag;
      ui.drag = null;
      if (!d.moved) return;
      if (d.kind === "item") await placeItem({ x: d.at.x, y: d.at.y });
      else await placePart(ui.part, d.at);
      return;
    }
    if (ui.mode) { await lineClick(at); return; }
    const tid = e.target.getAttribute && e.target.getAttribute("data-target");
    if (tid || !ui.sel) return;
    // A click on empty ground: place the selected light (or part) here
    if (ui.part !== null && target(ui.sel)?.item) await placePart(ui.part, at);
    else await placeItem(at);
  }

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
        id: t.id, label: t.name, x: t.world.x, y: t.world.y, z: t.world.z, floorZ: floorZ(t.item.floor),
        on: t.state === "on", sel, dim: !here && !sel,
        parts: t.parts.filter((p) => p.world).map((p) => ({ index: p.index, x: p.world.x, y: p.world.y, z: p.world.z, sel: sel && ui.part === p.index })),
      };
    });
    return {
      W: house.size.width, D: house.size.depth,
      zMin: Math.min(0, ...bottoms), zMax: Math.max(2.5, ...tops),
      floors: house.floors.map((f) => ({ ...f, active: f.id === ui.floor, label: L.fmtLen(f.elevation, { signed: true }) })),
      lights, grid: L.units() === "imperial" ? L.FT : 1,
      placeZ: floorZ(ui.floor), selPart: ui.part, labels: false,
    };
  }
  function ensure3d() {
    if (view3d) return;
    canvas3d = el("canvas", { "aria-label": "The house in 3D: floors and lights", role: "img",
      style: { width: "100%", aspectRatio: "4 / 3", maxHeight: "72vh", display: "block", borderRadius: "10px", cursor: "grab" } });
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
      onRaise: async (id, h, done) => {
        const t = target(id);
        const hh = Math.min(ceilingOf(t.item.floor), r2(h));
        t.item.h = hh; t.world.z = floorZ(t.item.floor) + hh;
        view3d.setScene(scene3d());
        if (done) await placeItem({ h: hh });
      },
    });
  }

  // ---- side view (from the street) ------------------------------------------------------------

  function sideView() {
    const b = bounds(), z = zBounds(), W = house.size.width;
    const svg = s("svg", { viewBox: `${b.x0} ${-z.z1} ${b.x1 - b.x0} ${z.z1 - z.z0}`, role: "img", "aria-label": "Side view from the street: floors and heights",
      style: "width:100%;height:auto;display:block;touch-action:none;background:var(--field);border-radius:10px" });
    svg.append(s("rect", { x: b.x0, y: 0, width: b.x1 - b.x0, height: -z.z0, fill: "var(--ok-soft)" }));
    svg.append(s("line", { x1: b.x0, y1: 0, x2: b.x1, y2: 0, stroke: "var(--ok)", "stroke-width": 0.05 }));
    svg.append(s("text", { x: b.x1 - 0.3, y: 0.55, "font-size": 0.4, fill: "var(--ok-text)", "text-anchor": "end" }, "Ground"));
    for (const f of house.floors) {
      const x0 = f.x0 ?? 0, x1 = f.x1 ?? W, active = f.id === ui.floor;
      svg.append(s("rect", { x: x0, y: -(f.elevation + f.ceiling), width: Math.max(0, x1 - x0), height: f.ceiling,
        fill: active ? "var(--accent)" : "var(--card2)", "fill-opacity": active ? 0.1 : 0.7,
        stroke: active ? "var(--accent)" : "var(--line2)", "stroke-width": 0.04 }));
      svg.append(s("text", { x: x0 + 0.2, y: -(f.elevation + f.ceiling) + 0.45, "font-size": 0.35, fill: active ? "var(--accent)" : "var(--muted)" },
        `${f.name}  ${L.fmtLen(f.elevation, { signed: true })}`));
    }
    for (const t of house.targets) {
      if (!t.world) continue;
      const sel = t.id === ui.sel;
      const here = t.item.floor === ui.floor || t.item.floor === house.outside;
      for (const p of t.parts) if (p.world) svg.append(s("circle", { cx: p.world.x, cy: -p.world.z, r: 0.1, fill: "var(--info)", opacity: here || sel ? 1 : 0.3 }));
      svg.append(s("circle", { cx: t.world.x, cy: -t.world.z, r: sel ? 0.28 : 0.18, fill: sel ? "var(--accent)" : "var(--faint)",
        opacity: here || sel ? 1 : 0.3, "data-target": t.id, style: "cursor:ns-resize" }));
      if (sel) {
        const fz = floorZ(t.item.floor);
        svg.append(s("line", { x1: t.world.x, y1: -fz, x2: t.world.x, y2: -t.world.z, stroke: "var(--accent)", "stroke-width": 0.05, "stroke-dasharray": "0.15 0.1" }));
        svg.append(s("text", { x: t.world.x + 0.3, y: -(fz + t.item.h / 2), "font-size": 0.35, fill: "var(--accent)" }, `${L.fmtLen(t.item.h)} above the floor`));
      }
    }
    let dragging = false;
    svg.addEventListener("pointerdown", (e) => {
      const tid = e.target.getAttribute && e.target.getAttribute("data-target");
      if (tid && tid !== ui.sel) { ui.sel = tid; ui.part = null; paint(); return; }
      if (tid === ui.sel) { dragging = true; svg.setPointerCapture(e.pointerId); }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const t = target(ui.sel);
      const zz = -svgPoint(svg, e).y;
      t.item.h = Math.max(0, Math.min(ceilingOf(t.item.floor), r2(zz - floorZ(t.item.floor))));
      t.world.z = floorZ(t.item.floor) + t.item.h;
      repaintViews();
    });
    svg.addEventListener("pointerup", async () => {
      if (!dragging) return;
      dragging = false;
      await placeItem({ h: target(ui.sel).item.h });
    });
    return svg;
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
      order.map((k) => el("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
        el("span.small", { style: { padding: "8px 4px 2px", fontWeight: "600", letterSpacing: ".6px", textTransform: "uppercase", color: "var(--muted)" } }, floorName(k)),
        groups.get(k).map((t) => {
          const sel = t.id === ui.sel;
          return el("button", { type: "button", "aria-pressed": String(sel), on: { click: () => { ui.sel = t.id; ui.part = null; ui.floor = floorOfTarget(t); paint(); } },
            style: { display: "flex", alignItems: "center", gap: "10px", minHeight: "44px", padding: "4px 10px", borderRadius: "10px", textAlign: "left",
              border: `1px solid ${sel ? "var(--accent)" : "transparent"}`, background: sel ? "var(--accent-soft)" : "transparent", color: "var(--text)", cursor: "pointer" } },
            el("span", { style: { width: "10px", height: "10px", borderRadius: "50%", flex: "none", ...(t.placed ? { background: "var(--ok)" } : { border: "2px solid var(--faint)" }) } }),
            el("span", { style: { flex: "1", minWidth: "0", display: "flex", flexDirection: "column" } },
              el("span", t.name), el("span.small.muted", [areas.get(t.area_id), t.kind === "fixture" ? "fixture" : null, t.parts.length ? `${t.parts.length} parts` : null].filter(Boolean).join(" · "))));
        }))));
  }

  function inspector() {
    const t = ui.sel && target(ui.sel);
    if (!t) return el("aside.card.hm-insp",
      el("h2", "Pick a light"), el("p.muted", { style: { margin: 0 } }, "Choose one on the left, then tap where it is in the plan. Drag it to fine-tune, and drag it up or down in the view from the street."));
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
          on: { click: () => { ui.mode = ui.mode ? null : "line-start"; ui.lineStart = null; paint(); if (ui.mode) toast("Tap where the first one is in the plan"); } } },
          ui.mode ? "Cancel line" : "Lay out along a line")),
      el("span.small.muted", "Select a part, then tap the plan to put it there. Flash shows which one it is."),
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
      item ? null : el("div.banner", { style: { fontSize: "14px" } }, "Tap the plan where this light is to place it."),
      el("div.row", { style: { gap: "8px" } },
        el("button.btn.primary", { type: "button", disabled: status?.read_only, style: { flex: "1" }, on: { click: () => identify(undefined) } }, "Flash it"),
        item ? el("button.btn", { type: "button", on: { click: removeItem } }, "Remove") : null),
      parts);
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
    if (ui.view === "3d") { view3d.mode = ui.mode3d; view3d.setScene(scene3d()); return; }
    views.plan.replaceChildren(planView());
    views.side.replaceChildren(sideView());
  }
  function paintList() { if (listBox) listBox.replaceWith(listBox = listPanel()); }

  function paint() {
    if (!house || !inventory) return;
    const placed = house.targets.filter((t) => t.placed).length;
    const extra = L.topExtra();
    extra.replaceChildren(el("span.small.muted", `${placed} of ${house.targets.length} placed`),
      el("button.btn.small", { type: "button", "aria-expanded": String(ui.settings), on: { click: () => { ui.settings = !ui.settings; paint(); } } }, "Floors & size"));
    const floorTabs = el("div.chips", { role: "group", "aria-label": "Floor shown" },
      [...house.floors.map((f) => [f.id, f.name]), [house.outside, "Outside"]].map(([id, name]) =>
        el("button.chip", { type: "button", "aria-pressed": String(ui.floor === id), on: { click: () => { ui.floor = id; paint(); } } }, name)));
    views = { plan: el("div"), side: el("div") };
    listBox = listPanel();
    const lineBanner = ui.mode ? el("div.banner", { style: { fontSize: "14px" } }, ui.mode === "line-start" ? "Tap where the first part is." : "Now tap where the last part is.") : null;
    const viewTabs = el("div.tabs", { role: "tablist", "aria-label": "View" },
      [["3d", "3D"], ["flat", "Plan & side"]].map(([k, label]) => el("button", { type: "button", role: "tab", "aria-selected": String(ui.view === k),
        on: { click: () => { ui.view = k; L.save("house.view", k); paint(); } } }, label)));
    let main;
    if (ui.view === "3d") {
      ensure3d();
      const t = ui.sel && target(ui.sel);
      const hint = !t ? "Pick a light from the list, or tap one."
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
    } else {
      main = [
        el("section.card", { "aria-label": "From above", style: { padding: "14px 16px" } },
          el("div.card-head", el("h2", "From above"), floorTabs), lineBanner, views.plan),
        el("section.card", { "aria-label": "From the street", style: { padding: "14px 16px" } },
          el("div.card-head", el("h2", "From the street"), el("span.small.muted", "Drag the selected light up or down")),
          views.side)];
    }
    L.set(page,
      settingsPanel(),
      el("div.hm",
        listBox,
        el("div.hm-views", viewTabs, main),
        inspector()));
    repaintViews();
  }

  // Redraw once the status says which units HA uses (and whenever that changes)
  let shownUnits = null;
  onData((d) => {
    status = d.status;
    if (house && L.units() !== shownUnits) { shownUnits = L.units(); if (!L.typing()) paint(); }
  });
  load().then(() => { paint(); start(15000); }).catch((e) => L.set(page, el("div.empty", `Couldn't load the house map: ${e.message}`)));
})();
