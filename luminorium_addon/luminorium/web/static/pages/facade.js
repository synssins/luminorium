// The front photo: a picture of the front of the house, measured from its front door. The user
// boxes the door (36" × 80" unless changed); its four corners fix the perspective, so everything
// drawn on the photo after that has real sizes. Drawing tools: the door, the ground line, house
// blocks (walls) with their roofs, windows and doors, floor lines (each one an HA floor's
// height), lights (placed where you tap), and a tape measure. Shapes are kept in facade metres
// from the door's bottom left corner: X across, Z up.
"use strict";

window.FacadeEditor = class FacadeEditor {
  // ctx: { house(), floors(), selection() -> {target, part}, place(X, Z, outside), saved(view), changed() }
  constructor(ctx) {
    this.ctx = ctx;
    this.doc = null;            // { door, ground, blocks, openings, lines }
    this.photo = null;          // { w, h }
    this.img = null;            // the loaded photo
    this.tool = "door";
    this.sel = null;            // { kind: "door"|"ground"|"block"|"opening"|"line", id }
    this.opts = { roof: "gable", opening: "window", floor: null, outside: false };
    this.undoStack = [];
    this.redoStack = [];
    this.view = { k: 1, x: 0, y: 0, fitted: false };
    this.pointers = new Map();
    this.drag = null;
    this.measure = null;
    this.hover = null;
    this.saveTimer = null;
    this.F2I = null; this.I2F = null;
    this.root = L.el("div.fc");
    this.build();
  }

  // ---- data ------------------------------------------------------------------------------------

  load(facade) {
    const f = facade || {};
    this.photo = f.photo || null;
    this.doc = {
      door: f.door || null, ground: f.ground || null,
      blocks: (f.blocks || []).map((b) => ({ ...b })), openings: (f.openings || []).map((o) => ({ ...o })),
      lines: (f.lines || []).map((l) => ({ ...l })),
    };
    this.solve();
    if (this.photo && (!this.img || this.img._for !== JSON.stringify(this.photo))) this.loadImage();
    if (!this.doc.door) this.tool = "door";
    this.paint();
  }

  loadImage() {
    const img = new Image();
    img._for = JSON.stringify(this.photo);
    img.onload = () => { this.img = img; this.view.fitted = false; this.paint(); };
    img.onerror = () => L.toast("Couldn't load the photo");
    img.src = `api/house/photo?t=${Date.now()}`;
  }

  snapshot() { return JSON.stringify(this.doc); }
  commit(before) {
    if (before === this.snapshot()) return;
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    this.solve();
    this.scheduleSave();
    this.paint();
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.doc = JSON.parse(this.undoStack.pop());
    this.afterHistory();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.doc = JSON.parse(this.redoStack.pop());
    this.afterHistory();
  }
  afterHistory() {
    if (this.sel && !this.shape(this.sel)) this.sel = null;
    this.solve(); this.scheduleSave(); this.paint();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveState("Saving…");
    this.saveTimer = setTimeout(() => this.save(), 600);
  }
  async save() {
    try {
      const view = await L.api("api/house/facade", { method: "PUT", body: this.doc });
      this.saveState("Saved");
      this.ctx.saved(view);
    } catch (e) {
      this.saveState("Not saved");
      L.toast(e.message);
    }
  }
  saveState(text) { if (this.saveEl) this.saveEl.textContent = text; }

  async upload(file) {
    if (!file) return;
    try {
      const bmp = await loadBitmap(file);
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.88));
      const r = await fetch(`api/house/photo?w=${w}&h=${h}`, { method: "PUT", body: blob, headers: { "Content-Type": "image/jpeg" } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `Upload failed (${r.status})`);
      const facade = await r.json();
      this.img = null;
      this.undoStack.length = 0; this.redoStack.length = 0;
      this.load(facade);
      this.ctx.changed();
      L.toast("Photo added. Now box the front door.");
    } catch (e) {
      L.toast(e.message || "Couldn't read that photo");
    }
  }

  async startOver() {
    if (!this.confirmClear) { this.confirmClear = true; this.paint(); return; }
    this.confirmClear = false;
    const view = await L.api("api/house/facade", { method: "DELETE" });
    this.img = null; this.sel = null; this.undoStack.length = 0;
    this.load(null);
    this.ctx.saved(view);
  }

  // ---- geometry --------------------------------------------------------------------------------

  // The perspective, from the door's four corners (image px: top left, top right, bottom right,
  // bottom left) and its real size
  solve() {
    this.F2I = this.I2F = null;
    const d = this.doc && this.doc.door;
    if (!d) return;
    const F = [[0, d.h], [d.w, d.h], [d.w, 0], [0, 0]];
    const H = homography(F, d.pts);
    if (!H) return;
    const Hi = invert3(H);
    if (!Hi) return;
    this.F2I = H; this.I2F = Hi;
    const c = applyH(H, [d.w / 2, d.h / 2], true);
    this.wSign = Math.sign(c[2]) || 1;
  }
  toImage(X, Z) {
    if (!this.F2I) return null;
    const p = applyH(this.F2I, [X, Z], true);
    if (Math.sign(p[2]) !== this.wSign || Math.abs(p[2]) < 1e-9) return null;
    return { x: p[0] / p[2], y: p[1] / p[2] };
  }
  toFacade(u, v) {
    if (!this.I2F) return null;
    const p = applyH(this.I2F, [u, v], true);
    if (Math.abs(p[2]) < 1e-12) return null;
    return { X: p[0] / p[2], Z: p[1] / p[2] };
  }
  // image px <-> canvas px
  i2s(p) { return p && { x: p.x * this.view.k + this.view.x, y: p.y * this.view.k + this.view.y }; }
  s2i(p) { return { x: (p.x - this.view.x) / this.view.k, y: (p.y - this.view.y) / this.view.k }; }
  f2s(X, Z) { return this.i2s(this.toImage(X, Z)); }
  s2f(p) { const i = this.s2i(p); return this.toFacade(i.x, i.y); }
  // metres per screen pixel near a screen point
  mpp(p) {
    const a = this.s2f(p), b = this.s2f({ x: p.x + 10, y: p.y });
    return a && b ? Math.hypot(a.X - b.X, a.Z - b.Z) / 10 : 0.01;
  }
  origin() {
    const ox = this.doc.blocks.length ? Math.min(...this.doc.blocks.map((b) => b.x0)) : 0;
    return { ox, gz: this.doc.ground ? this.doc.ground.z : 0 };
  }
  // the width the photo covers, in facade metres, for lines that run across it
  span() {
    const xs = [];
    for (const [u] of [[0], [this.photo.w]]) { const f = this.toFacade(u, this.photo.h * 0.6); if (f) xs.push(f.X); }
    const all = [...xs, 0, ...this.doc.blocks.flatMap((b) => [b.x0, b.x1])];
    return { x0: Math.min(...all) - 1, x1: Math.max(...all) + 1 };
  }

  // Snap a facade value to the edges already drawn, within a few screen pixels
  snap(v, axis, at, skip) {
    if (this.noSnap) return { v, hit: false };
    const tol = this.mpp(at) * 5;
    const cands = [];
    const d = this.doc;
    if (axis === "x") {
      cands.push(0, d.door ? d.door.w : 0);
      for (const b of d.blocks) if (b !== skip) cands.push(b.x0, b.x1);
      for (const o of d.openings) if (o !== skip) cands.push(o.x0, o.x1);
    } else {
      cands.push(0, d.door ? d.door.h : 0);
      if (d.ground) cands.push(d.ground.z);
      for (const b of d.blocks) if (b !== skip) cands.push(b.z0, b.z1);
      for (const o of d.openings) if (o !== skip) cands.push(o.z0, o.z1);
      for (const l of d.lines) if (l !== skip) cands.push(l.z);
    }
    let best = null;
    for (const c of cands) if (Math.abs(c - v) <= tol && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
    return best === null ? { v, hit: false } : { v: best, hit: true };
  }

  shape(sel) {
    if (!sel) return null;
    if (sel.kind === "door") return this.doc.door;
    if (sel.kind === "ground") return this.doc.ground;
    const list = { block: this.doc.blocks, opening: this.doc.openings, line: this.doc.lines }[sel.kind];
    return list ? list.find((s) => s.id === sel.id) || null : null;
  }

  // ---- the page parts --------------------------------------------------------------------------

  build() {
    const { el } = L;
    this.canvas = el("canvas", { role: "img", "aria-label": "The front photo with the drawing", tabindex: "0",
      style: { width: "100%", height: "100%", display: "block", touchAction: "none" } });
    this.ctx2d = this.canvas.getContext("2d");
    this.toolbar = el("div.fc-tools", { role: "toolbar", "aria-label": "Drawing tools", "aria-orientation": "vertical" });
    this.optionsBar = el("div.fc-opts");
    this.stepsEl = el("ol.fc-steps", { "aria-label": "Steps" });
    this.hintEl = el("div.fc-hint", { role: "status" });
    this.inspEl = el("div.fc-insp");
    this.saveEl = el("span.small.muted", "");
    this.fileInput = el("input", { type: "file", accept: "image/*", style: { display: "none" }, on: { change: (e) => { this.upload(e.target.files[0]); e.target.value = ""; } } });
    this.stage = el("div.fc-stage", this.canvas);
    this.empty = el("div.fc-empty",
      el("div", { style: { fontSize: "16px", fontWeight: "600" } }, "Start with a photo of the front of the house"),
      el("p.muted", { style: { margin: "6px 0 14px", maxWidth: "46ch" } },
        "Stand across the street and get the whole front in, straight on if you can. Then box the front door: it's a known size, so the rest of the house gets measured from it."),
      el("button.btn.primary", { type: "button", on: { click: () => this.fileInput.click() } }, "Choose a photo"));
    L.set(this.root,
      el("div.fc-head", this.stepsEl, el("div.row", { style: { gap: "8px" } }, this.saveEl,
        this.replaceBtn = el("button.btn.small", { type: "button", on: { click: () => this.fileInput.click() } }, "Replace photo"))),
      this.optionsBar,
      el("div.fc-body", this.toolbar, el("div.fc-main", this.stage, this.empty), this.inspEl),
      this.hintEl, this.fileInput);

    new ResizeObserver(() => this.render()).observe(this.stage);
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.down(e));
    c.addEventListener("pointermove", (e) => this.move(e));
    c.addEventListener("pointerup", (e) => this.up(e));
    c.addEventListener("pointercancel", (e) => this.up(e, true));
    c.addEventListener("pointerleave", () => { this.hover = null; this.render(); });
    c.addEventListener("wheel", (e) => { e.preventDefault(); this.zoomAt(this.local(e), Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    c.addEventListener("keydown", (e) => this.key(e));
    window.addEventListener("keydown", (e) => { if (e.key === " " && document.activeElement === c) { this.space = true; e.preventDefault(); } });
    window.addEventListener("keyup", (e) => { if (e.key === " ") this.space = false; if (e.key === "Alt") this.noSnap = false; });
  }

  ready() { return !!this.F2I; }

  TOOLS() {
    const needDoor = !this.ready();
    return [
      { id: "select", label: "Select", key: "V", icon: "M5 3l14 8-6 2-2 6z", off: needDoor },
      { id: "pan", label: "Pan", key: "H", icon: "M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L8 13" },
      { sep: true },
      { id: "door", label: "Front door", key: "D", icon: "M6 21V3h12v18M3 21h18M14 12h.01" },
      { id: "ground", label: "Ground line", key: "G", icon: "M3 17h18M5 21l2-4M10 21l2-4M15 21l2-4", off: needDoor },
      { id: "block", label: "House block", key: "B", icon: "M4 20V9h16v11zM4 20h16", off: needDoor },
      { id: "roof", label: "Roof", key: "R", icon: "M3 12l9-8 9 8M5 10v10h14V10", off: needDoor || !this.doc.blocks.length },
      { id: "opening", label: "Window or door", key: "N", icon: "M5 4h14v16H5zM12 4v16M5 12h14", off: needDoor },
      { id: "floor", label: "Floor line", key: "F", icon: "M3 8h18M3 16h18M7 8v8", off: needDoor },
      { sep: true },
      { id: "light", label: "Place a light", key: "L", icon: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z", off: needDoor },
      { id: "measure", label: "Measure", key: "M", icon: "M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2", off: needDoor },
    ];
  }

  setTool(id) {
    const t = this.TOOLS().find((x) => x.id === id);
    if (!t || t.off) return;
    this.tool = id;
    if (id !== "measure") this.measure = null;
    if (id === "floor" && !this.opts.floor) this.opts.floor = this.nextFloor();
    this.paint();
    this.canvas.focus({ preventScroll: true });
  }

  nextFloor() {
    const used = new Set(this.doc.lines.map((l) => l.floor));
    const floors = this.ctx.floors();
    return (floors.find((f) => !used.has(f.id)) || floors[0] || {}).id || null;
  }

  // The steps across the top, each with its tick, and a tap picks its tool
  steps() {
    const d = this.doc, has = !!this.photo;
    const lit = this.ctx.house().targets.some((t) => t.placed);
    return [
      { label: "Photo", done: has, tool: null, act: () => this.fileInput.click() },
      { label: "Front door", done: !!d.door, tool: "door" },
      { label: "Ground", done: !!d.ground, tool: "ground" },
      { label: "House blocks", done: d.blocks.length > 0, tool: "block" },
      { label: "Roofs", done: d.blocks.some((b) => b.roof !== "flat"), tool: "roof" },
      { label: "Floors", done: d.lines.some((l) => l.floor), tool: "floor" },
      { label: "Lights", done: lit, tool: "light" },
    ];
  }

  hint() {
    if (!this.photo) return "";
    if (!this.img) return "Loading the photo…";
    const fmt = L.fmtLen;
    const d = this.doc;
    switch (this.tool) {
      case "door": return d.door ? "Drag the door's corners onto the door frame's corners (zoom in for the best fit). Drag a new box to start again." : `Drag a box around the front door, from one corner of its frame to the other. It's taken as ${fmt(this.doorSize().w)} × ${fmt(this.doorSize().h)}.`;
      case "ground": return "Tap where the wall meets the ground (or the driveway), anywhere along the front.";
      case "block": return "Drag a box over each part of the house: from the ground to where the roof starts, wall edge to wall edge. Split levels and garages are their own blocks.";
      case "roof": return this.opts.roof === "gable" ? "Tap the top of a roof's point (the gable facing the street)." : "Tap the roof's ridge, the line along the top, above its block.";
      case "opening": return "Drag a box over a window, door or garage door.";
      case "floor": {
        const f = this.ctx.floors().find((x) => x.id === this.opts.floor);
        return `Drag along where the ${f ? f.name : "chosen"} floor is (a window sill is often about 3 ft above it). Pick the floor above first.`;
      }
      case "light": {
        const s = this.ctx.selection();
        if (!s.target) return "Pick a light from the list, then tap where it is on the photo.";
        return `Tap where ${s.target.name}${s.part !== null ? ` · ${s.target.parts.find((p) => p.index === s.part)?.label || "part"}` : ""} is.`;
      }
      case "measure": return this.measure ? `${fmt(this.measure.len)} · drag again to measure something else` : "Drag from one point to another to measure it.";
      case "pan": return "Drag to move the photo. Scroll or pinch to zoom.";
      default: return "Tap a shape to pick it; drag it or its handles. Delete removes it. Hold Alt to stop snapping.";
    }
  }

  doorSize() { return this.doc.door ? { w: this.doc.door.w, h: this.doc.door.h } : { w: this.pendingDoor?.w ?? 0.9144, h: this.pendingDoor?.h ?? 2.032 }; }

  paint() {
    if (!this.doc) return;
    const { el } = L;
    const has = !!this.photo;
    this.empty.style.display = has ? "none" : "";
    this.stage.style.display = has ? "" : "none";
    this.replaceBtn.style.display = has ? "" : "none";
    // steps
    L.set(this.stepsEl, ...this.steps().map((s, i) => el("li", el("button", { type: "button", class: `fc-step${s.done ? " done" : ""}${s.tool && s.tool === this.tool ? " on" : ""}`,
      disabled: !has && i > 0 ? "" : null, on: { click: () => (s.act ? s.act() : this.setTool(s.tool)) } },
    el("span.n", s.done ? "✓" : String(i + 1)), s.label))));
    // tools
    L.set(this.toolbar, ...this.TOOLS().map((t) => t.sep ? el("span.fc-sep") :
      el("button", { type: "button", class: "fc-tool", title: `${t.label} (${t.key})`, "aria-label": t.label, "aria-pressed": String(this.tool === t.id),
        disabled: t.off || !has ? "" : null, on: { click: () => this.setTool(t.id) } }, svgIcon(t.icon), el("span.fc-tl", t.label))),
    el("span.fc-sep"),
    el("button", { type: "button", class: "fc-tool", title: "Undo (Ctrl+Z)", "aria-label": "Undo", disabled: this.undoStack.length ? null : "", on: { click: () => this.undo() } }, svgIcon("M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"), el("span.fc-tl", "Undo")),
    el("button", { type: "button", class: "fc-tool", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo", disabled: this.redoStack.length ? null : "", on: { click: () => this.redo() } }, svgIcon("M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"), el("span.fc-tl", "Redo")),
    el("button", { type: "button", class: "fc-tool", title: "Fit the photo", "aria-label": "Fit the photo", disabled: has ? null : "", on: { click: () => { this.view.fitted = false; this.render(); } } }, svgIcon("M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"), el("span.fc-tl", "Fit")));
    this.paintOptions();
    this.paintInspector();
    this.hintEl.textContent = this.hint();
    this.render();
  }

  paintOptions() {
    const { el } = L;
    const bits = [];
    const lenField = (label, value, set) => el("label.fc-o", el("span", label),
      el("input.input", { value: L.fmtLen(value), inputmode: "decimal", style: { width: "92px" },
        on: { change: (e) => { const v = L.parseLen(e.target.value); if (!(v >= 0.3 && v <= 6)) { L.toast("Give a size like 36\" or 3' 0\""); e.target.value = L.fmtLen(value); return; } set(v); } } }));
    if (this.tool === "door") {
      const sz = this.doorSize();
      const setSize = (k, v) => {
        if (this.doc.door) { const b = this.snapshot(); this.doc.door[k] = v; this.commit(b); }
        else { this.pendingDoor = { ...sz, [k]: v }; this.paint(); }
      };
      bits.push(el("span.fc-olabel", "Door size"), lenField("Width", sz.w, (v) => setSize("w", v)), lenField("Height", sz.h, (v) => setSize("h", v)),
        el("button.btn.small", { type: "button", on: { click: () => { setSize("w", 0.9144); setSize("h", 2.032); } } }, "Standard 36\" × 80\""));
    } else if (this.tool === "roof") {
      bits.push(el("span.fc-olabel", "Roof shape"), el("div.seg", { role: "radiogroup", "aria-label": "Roof shape" },
        [["gable", "Point faces the street"], ["ridge", "Ridge along the front"]].map(([k, label]) =>
          el("button", { type: "button", role: "radio", "aria-checked": String(this.opts.roof === k), on: { click: () => { this.opts.roof = k; this.paint(); } } }, label))));
    } else if (this.tool === "opening") {
      bits.push(el("span.fc-olabel", "Drawing a"), el("div.seg", { role: "radiogroup", "aria-label": "Opening" },
        [["window", "Window"], ["door", "Door"], ["garage", "Garage door"]].map(([k, label]) =>
          el("button", { type: "button", role: "radio", "aria-checked": String(this.opts.opening === k), on: { click: () => { this.opts.opening = k; this.paint(); } } }, label))));
    } else if (this.tool === "floor") {
      const floors = this.ctx.floors();
      const used = new Map(this.doc.lines.filter((l) => l.floor).map((l) => [l.floor, l]));
      bits.push(el("span.fc-olabel", "Floor"), el("div.chips", floors.map((f) =>
        el("button.chip", { type: "button", "aria-pressed": String(this.opts.floor === f.id), on: { click: () => { this.opts.floor = f.id; this.paint(); } } },
          f.name, used.has(f.id) ? el("span.n", "✓") : null))));
    } else if (this.tool === "light") {
      const s = this.ctx.selection();
      bits.push(el("span.fc-olabel", s.target ? s.target.name : "No light picked"),
        el("div.seg", { role: "radiogroup", "aria-label": "Where the light is" },
          [[false, "Inside, by the window"], [true, "Outside, on the wall"]].map(([k, label]) =>
            el("button", { type: "button", role: "radio", "aria-checked": String(this.opts.outside === k), on: { click: () => { this.opts.outside = k; this.paint(); } } }, label))));
    } else if (this.tool === "measure" && this.measure) {
      bits.push(el("span.fc-olabel", "Measured"), el("strong", L.fmtLen(this.measure.len)),
        el("span.muted.small", `across ${L.fmtLen(Math.abs(this.measure.dx))}, up ${L.fmtLen(Math.abs(this.measure.dz))}`));
    }
    if (this.ready() && this.tool !== "door") {
      const o = this.origin();
      const W = this.doc.blocks.length ? Math.max(...this.doc.blocks.map((b) => b.x1)) - o.ox : null;
      bits.push(el("span", { style: { flex: "1" } }), W ? el("span.small.muted", `House ${L.fmtLen(W)} wide`) : null);
    }
    if (!bits.length) {
      const t = this.TOOLS().find((x) => x.id === this.tool);
      if (t) bits.push(el("span.fc-olabel", `${t.label} · ${t.key}`));
    }
    L.set(this.optionsBar, ...bits);
    this.optionsBar.style.display = this.photo ? "" : "none";
  }

  paintInspector() {
    const { el } = L;
    const s = this.shape(this.sel);
    const o = this.ready() ? this.origin() : { ox: 0, gz: 0 };
    const fmt = L.fmtLen;
    const del = el("button.btn.small.danger", { type: "button", on: { click: () => this.remove() } }, "Delete");
    const field = (label, input) => el("label.field", el("span", label), input);
    const lenInput = (value, set, optional) => el("input.input", { value: value === undefined || value === null ? "" : fmt(value), placeholder: optional || "", inputmode: "decimal",
      on: { change: (e) => { const t = e.target.value.trim(); if (!t && optional) return set(null); const v = L.parseLen(t); if (!Number.isFinite(v)) { L.toast("Not a length"); return; } set(v); } } });
    const edit = (fn) => { const b = this.snapshot(); fn(); this.commit(b); };
    let body = null;
    if (!this.photo) body = null;
    else if (!s) {
      const d = this.doc;
      body = el("div.fc-sum",
        el("h3", "On the photo"),
        el("dl.fc-kv",
          el("dt", "Door"), el("dd", d.door ? `${fmt(d.door.w)} × ${fmt(d.door.h)}` : "not marked"),
          el("dt", "Door sill"), el("dd", d.ground ? `${fmt(-d.ground.z)} above the ground` : "taken as the ground"),
          el("dt", "Blocks"), el("dd", String(d.blocks.length)),
          el("dt", "Windows, doors"), el("dd", String(d.openings.length)),
          el("dt", "Floor lines"), el("dd", String(d.lines.filter((l) => l.floor).length))),
        el("p.small.muted", "Tap a shape with Select to change it. Blocks set the house width, and floor lines set each floor's height and span on the house map."),
        this.confirmClear
          ? el("div.row", { style: { gap: "8px" } }, el("button.btn.small.danger", { type: "button", on: { click: () => this.startOver() } }, "Yes, remove it all"),
            el("button.btn.small", { type: "button", on: { click: () => { this.confirmClear = false; this.paint(); } } }, "Keep it"))
          : el("button.btn.small", { type: "button", on: { click: () => this.startOver() } }, "Remove the photo and drawing"));
    } else if (this.sel.kind === "block") {
      body = el("div.fc-sum", el("h3", s.name || "House block"),
        field("Name", el("input.input", { value: s.name || "", on: { change: (e) => edit(() => { s.name = e.target.value.slice(0, 60); }) } })),
        el("dl.fc-kv", el("dt", "Width"), el("dd", fmt(s.x1 - s.x0)), el("dt", "Wall height"), el("dd", fmt(s.z1 - s.z0)),
          el("dt", "From the ground"), el("dd", fmt(s.z0 - o.gz, { signed: true })),
          s.roof !== "flat" ? [el("dt", "Roof top"), el("dd", fmt(s.peak_z - o.gz))] : null),
        field("Roof", el("select", { on: { change: (e) => edit(() => { s.roof = e.target.value; if (s.roof !== "flat") { s.peak_z ??= s.z1 + 1.5; s.peak_x ??= (s.x0 + s.x1) / 2; } }) } },
          [["flat", "Flat, or none seen"], ["gable", "Point faces the street"], ["ridge", "Ridge along the front"]].map(([k, label]) => el("option", { value: k, selected: s.roof === k ? "" : null }, label)))),
        field("Depth, front to back", lenInput(s.depth, (v) => edit(() => { if (v === null) delete s.depth; else s.depth = v; }), `${fmt(this.ctx.house().size.depth)} (the house)`)),
        field("Set back from the front", lenInput(s.y0, (v) => edit(() => { if (v === null) delete s.y0; else s.y0 = v; }), "0")),
        del);
    } else if (this.sel.kind === "opening") {
      body = el("div.fc-sum", el("h3", { window: "Window", door: "Door", garage: "Garage door" }[s.kind]),
        field("Kind", el("select", { on: { change: (e) => edit(() => { s.kind = e.target.value; }) } },
          [["window", "Window"], ["door", "Door"], ["garage", "Garage door"]].map(([k, label]) => el("option", { value: k, selected: s.kind === k ? "" : null }, label)))),
        el("dl.fc-kv", el("dt", "Size"), el("dd", `${fmt(s.x1 - s.x0)} × ${fmt(s.z1 - s.z0)}`),
          el("dt", "Sill above the ground"), el("dd", fmt(s.z0 - o.gz))), del);
    } else if (this.sel.kind === "line") {
      const floors = this.ctx.floors();
      body = el("div.fc-sum", el("h3", "Floor line"),
        field("Floor", el("select", { on: { change: (e) => edit(() => { s.floor = e.target.value || null; }) } },
          el("option", { value: "" }, "Not set"),
          floors.map((f) => el("option", { value: f.id, selected: s.floor === f.id ? "" : null }, f.name)))),
        el("dl.fc-kv", el("dt", "Height above the ground"), el("dd", fmt(s.z - o.gz, { signed: true })), el("dt", "Spans"), el("dd", fmt(s.x1 - s.x0))),
        el("p.small.muted", "The floor's height and the part of the house it covers come from this line."), del);
    } else if (this.sel.kind === "door") {
      body = el("div.fc-sum", el("h3", "Front door"),
        el("p.small.muted", "Its corners set the scale and the perspective for everything else. Change the door size with the Front door tool."),
        el("dl.fc-kv", el("dt", "Size"), el("dd", `${fmt(s.w)} × ${fmt(s.h)}`)));
    } else if (this.sel.kind === "ground") {
      body = el("div.fc-sum", el("h3", "Ground line"), el("dl.fc-kv", el("dt", "Door sill above it"), el("dd", fmt(-s.z))), del);
    }
    L.set(this.inspEl, body);
    this.inspEl.style.display = body ? "" : "none";
  }

  remove() {
    if (!this.sel || this.sel.kind === "door") return;
    const b = this.snapshot();
    if (this.sel.kind === "ground") this.doc.ground = null;
    else {
      const key = { block: "blocks", opening: "openings", line: "lines" }[this.sel.kind];
      this.doc[key] = this.doc[key].filter((x) => x.id !== this.sel.id);
    }
    this.sel = null;
    this.commit(b);
  }

  // ---- drawing ---------------------------------------------------------------------------------

  fit() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    if (!this.img || !W || !H) return;
    const k = Math.min(W / this.photo.w, H / this.photo.h) * 0.96;
    this.view = { k, x: (W - this.photo.w * k) / 2, y: (H - this.photo.h * k) / 2, fitted: true };
  }

  zoomAt(p, factor) {
    const i = this.s2i(p);
    const k = Math.min(20, Math.max(0.05, this.view.k * factor));
    this.view.k = k; this.view.x = p.x - i.x * k; this.view.y = p.y - i.y * k;
    this.render();
  }

  render() {
    const c = this.canvas, ctx = this.ctx2d;
    if (!this.doc || !this.photo) return;
    const dpr = window.devicePixelRatio || 1;
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    if (!this.view.fitted) this.fit();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = colors();
    ctx.fillStyle = col.field; ctx.fillRect(0, 0, W, H);
    if (!this.img) return;
    ctx.save();
    ctx.translate(this.view.x, this.view.y); ctx.scale(this.view.k, this.view.k);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.img, 0, 0);
    ctx.restore();
    // dim the photo a touch so the drawing reads
    ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(0, 0, W, H);
    this.drawShapes(ctx, col);
    this.drawLoupe(ctx, col, W);
  }

  // A facade polygon on screen; null if part of it is behind the camera
  fpoly(pts) {
    const out = pts.map(([X, Z]) => this.f2s(X, Z));
    return out.some((p) => !p) ? null : out;
  }
  path(ctx, pts, close = true) {
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (close) ctx.closePath();
  }

  drawShapes(ctx, col) {
    const d = this.doc;
    const isSel = (kind, id) => this.sel && this.sel.kind === kind && (id === undefined || this.sel.id === id);
    const BLOCK = "#5aa9e6", OPEN = "#9ad0f5", LINE = "#f0b429", GROUND = "#7bc47f", DOOR = "#ff8a3d";
    if (this.ready()) {
      const span = this.span();
      // blocks: wall and roof
      for (const b of d.blocks) {
        const sel = isSel("block", b.id);
        const wall = this.fpoly([[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]]);
        if (wall) {
          this.path(ctx, wall); ctx.fillStyle = hexA(BLOCK, sel ? 0.28 : 0.14); ctx.fill();
          ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = BLOCK; ctx.stroke();
          const lab = this.f2s(b.x0, b.z1);
          if (lab) label(ctx, b.name || "Block", lab.x + 6, lab.y + 16, BLOCK, col);
        }
        if (b.roof === "gable") {
          const roof = this.fpoly([[b.x0, b.z1], [b.peak_x, b.peak_z], [b.x1, b.z1]]);
          if (roof) { this.path(ctx, roof); ctx.fillStyle = hexA(BLOCK, 0.1); ctx.fill(); ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]); }
        } else if (b.roof === "ridge") {
          const roof = this.fpoly([[b.x0, b.z1], [b.x1, b.z1], [b.x1, b.peak_z], [b.x0, b.peak_z]]);
          if (roof) { this.path(ctx, roof); ctx.fillStyle = hexA(BLOCK, 0.1); ctx.fill(); ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]); }
        }
        if (sel) this.handles(ctx, this.blockHandles(b), BLOCK);
      }
      for (const o of d.openings) {
        const sel = isSel("opening", o.id);
        const q = this.fpoly([[o.x0, o.z0], [o.x1, o.z0], [o.x1, o.z1], [o.x0, o.z1]]);
        if (!q) continue;
        this.path(ctx, q); ctx.fillStyle = hexA(OPEN, sel ? 0.35 : 0.18); ctx.fill();
        ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = OPEN; ctx.stroke();
        if (o.kind !== "window") { const c = this.f2s((o.x0 + o.x1) / 2, o.z1); if (c) label(ctx, o.kind === "garage" ? "Garage" : "Door", c.x, c.y - 6, OPEN, col, "center"); }
        if (sel) this.handles(ctx, this.rectHandles(o), OPEN);
      }
      // the ground
      const gz = d.ground ? d.ground.z : null;
      if (gz !== null) {
        const g = this.fpoly([[span.x0 - 20, gz], [span.x1 + 20, gz]]) || this.fpoly([[span.x0, gz], [span.x1, gz]]);
        if (g) {
          ctx.lineWidth = isSel("ground") ? 3 : 2; ctx.strokeStyle = GROUND; ctx.setLineDash([10, 6]);
          this.path(ctx, g, false); ctx.stroke(); ctx.setLineDash([]);
          label(ctx, "Ground", g[0].x + 8, g[0].y - 8, GROUND, col);
        }
      }
      // floor lines
      const floors = new Map(this.ctx.floors().map((f) => [f.id, f]));
      const o0 = this.origin();
      for (const l of d.lines) {
        const sel = isSel("line", l.id);
        const q = this.fpoly([[l.x0, l.z], [l.x1, l.z]]);
        if (!q) continue;
        ctx.lineWidth = sel ? 4 : 3; ctx.strokeStyle = LINE; this.path(ctx, q, false); ctx.stroke();
        const f = floors.get(l.floor);
        label(ctx, `${f ? f.name : "Floor?"}  ${L.fmtLen(l.z - o0.gz, { signed: true })}`, q[0].x + 6, q[0].y - 8, LINE, col);
        if (sel) this.handles(ctx, [{ id: "a", s: q[0] }, { id: "b", s: q[1] }], LINE);
      }
      // placed lights near the front, and the light being placed
      this.drawLights(ctx, col);
      // a scale grid under the pointer while drawing? No: a scale bar
      this.scaleBar(ctx, col);
    }
    // the door, always on top
    if (d.door) {
      const pts = d.door.pts.map(([u, v]) => this.i2s({ x: u, y: v }));
      this.path(ctx, pts); ctx.fillStyle = hexA(DOOR, 0.12); ctx.fill();
      ctx.lineWidth = isSel("door") || this.tool === "door" ? 2.5 : 2; ctx.strokeStyle = DOOR; ctx.stroke();
      if (this.tool === "door" || isSel("door")) this.handles(ctx, pts.map((s, i) => ({ id: i, s })), DOOR, true);
      label(ctx, `Door ${L.fmtLen(d.door.w)} × ${L.fmtLen(d.door.h)}`, pts[0].x, pts[0].y - 8, DOOR, col);
    }
    // what's being drawn
    const dr = this.drag;
    if (dr && dr.kind === "draw") {
      ctx.lineWidth = 2; ctx.strokeStyle = col.text; ctx.setLineDash([5, 4]);
      if (dr.tool === "door") {
        const a = dr.start, b = dr.cur;
        ctx.strokeStyle = DOOR; ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      } else if (dr.rect) {
        const r = dr.rect;
        const q = this.fpoly([[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]]);
        if (q) {
          ctx.strokeStyle = dr.tool === "block" ? BLOCK : OPEN; this.path(ctx, q); ctx.stroke();
          const c = this.f2s((r.x0 + r.x1) / 2, Math.max(r.z0, r.z1));
          if (c) label(ctx, `${L.fmtLen(Math.abs(r.x1 - r.x0))} × ${L.fmtLen(Math.abs(r.z1 - r.z0))}`, c.x, c.y - 8, col.text, col, "center");
        }
      } else if (dr.line) {
        const q = this.fpoly([[dr.line.x0, dr.line.z], [dr.line.x1, dr.line.z]]);
        if (q) { ctx.strokeStyle = LINE; ctx.lineWidth = 3; this.path(ctx, q, false); ctx.stroke(); }
      }
      ctx.setLineDash([]);
    }
    if (this.measure) {
      const m = this.measure;
      const a = this.f2s(m.a.X, m.a.Z), b = this.f2s(m.b.X, m.b.Z);
      if (a && b) {
        ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill(); }
        label(ctx, L.fmtLen(m.len), (a.x + b.x) / 2, (a.y + b.y) / 2 - 10, "#ffffff", col, "center");
      }
    }
    // the cursor's height above the ground, while a drawing tool is on
    if (this.hover && this.ready() && ["ground", "block", "opening", "floor", "light", "roof"].includes(this.tool) && !(dr && dr.kind === "pan")) {
      const f = this.s2f(this.hover);
      if (f) {
        const o = this.origin();
        ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        const q = this.fpoly([[f.X - 3, f.Z], [f.X + 3, f.Z]]);
        if (q) { this.path(ctx, q, false); ctx.stroke(); }
        ctx.setLineDash([]);
        label(ctx, `${L.fmtLen(f.Z - o.gz, { signed: true })} up`, this.hover.x + 14, this.hover.y - 12, col.text, col);
      }
    }
  }

  drawLights(ctx, col) {
    const house = this.ctx.house();
    const o = this.origin();
    const s = this.ctx.selection();
    const dot = (wx, wy, wz, sel, on, name) => {
      if (Math.abs(wy) > 1.5) return; // only lights on or by the front wall show on the photo
      const p = this.f2s(wx + o.ox, wz + o.gz);
      if (!p) return;
      const r = sel ? 8 : 6;
      if (on || sel) { const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3); g.addColorStop(0, sel ? "rgba(255,138,61,.55)" : "rgba(245,194,90,.55)"); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = sel ? "#ff8a3d" : on ? "#f5c25a" : "#cfd6de"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#111"; ctx.stroke();
      if (sel) label(ctx, name, p.x, p.y - r - 6, col.text, col, "center");
    };
    for (const t of house.targets) {
      if (!t.world) continue;
      const sel = s.target && s.target.id === t.id;
      for (const p of t.parts) if (p.world) dot(p.world.x, p.world.y, p.world.z, sel && s.part === p.index, false, sel && s.part === p.index ? p.label : "");
      dot(t.world.x, t.world.y, t.world.z, sel && s.part === null, t.state === "on", t.name);
    }
  }

  // A bar a round length long, so the scale can be checked by eye
  scaleBar(ctx, col) {
    const H = this.stage.clientHeight;
    const at = { x: 24, y: H - 26 };
    const m = this.mpp(at);
    if (!m) return;
    const unit = L.units() === "imperial" ? L.FT : 1;
    const steps = [1, 2, 5, 10, 20, 50];
    const len = (steps.find((n) => (n * unit) / m >= 60) || 50) * unit;
    const px = len / m;
    if (!isFinite(px) || px > 400) return;
    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(at.x - 8, at.y - 18, px + 16, 30);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(at.x, at.y - 4); ctx.lineTo(at.x, at.y + 4); ctx.moveTo(at.x, at.y); ctx.lineTo(at.x + px, at.y); ctx.moveTo(at.x + px, at.y - 4); ctx.lineTo(at.x + px, at.y + 4); ctx.stroke();
    ctx.font = `500 11px ${getComputedStyle(document.body).fontFamily}`; ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    ctx.fillText(`${L.fmtLen(len)} (at this spot)`, at.x, at.y - 7);
  }

  handles(ctx, hs, color, big) {
    for (const h of hs) {
      if (!h.s) continue;
      const r = big ? 7 : 6;
      ctx.beginPath(); ctx.rect(h.s.x - r, h.s.y - r, r * 2, r * 2);
      ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
    }
  }
  rectHandles(r) {
    return [["x0", "z0"], ["x1", "z0"], ["x1", "z1"], ["x0", "z1"]].map(([kx, kz]) => ({ id: `${kx}${kz}`, kx, kz, s: this.f2s(r[kx], r[kz]) }));
  }
  blockHandles(b) {
    const hs = this.rectHandles(b);
    if (b.roof === "gable") hs.push({ id: "peak", s: this.f2s(b.peak_x, b.peak_z) });
    if (b.roof === "ridge") hs.push({ id: "peak", s: this.f2s((b.x0 + b.x1) / 2, b.peak_z) });
    return hs;
  }

  // A magnifier by the pointer while placing something exactly
  drawLoupe(ctx, col, W) {
    const dr = this.drag;
    if (!dr || !this.img || !dr.cur || !["handle", "draw", "measure"].includes(dr.kind) || dr.tool === "light") return;
    const p = dr.cur;
    const R = 62, zoom = 3;
    const cx = p.x < W / 2 ? W - R - 14 : R + 14, cy = R + 14;
    const i = this.s2i(p);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = col.field; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const k = this.view.k * zoom;
    ctx.translate(cx - i.x * k, cy - i.y * k); ctx.scale(k, k);
    ctx.drawImage(this.img, 0, 0);
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.strokeStyle = "#ff8a3d"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke();
  }

  // ---- input -----------------------------------------------------------------------------------

  local(e) { const b = this.canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }

  key(e) {
    if (e.target !== this.canvas) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); this.redo(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.remove(); return; }
    if (e.key === "Escape") { this.sel = null; this.drag = null; this.measure = null; this.paint(); return; }
    if (e.key === "Alt") { this.noSnap = true; return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = this.TOOLS().find((x) => x.key && x.key.toLowerCase() === k);
    if (t) { e.preventDefault(); this.setTool(t.id); }
  }

  // Which shape (or handle) is under a screen point
  hitTest(p) {
    const near = (s, r = 11) => s && Math.hypot(s.x - p.x, s.y - p.y) <= r;
    const d = this.doc;
    // handles of the picked shape first
    const s = this.shape(this.sel);
    if (s && this.sel.kind === "block") for (const h of this.blockHandles(s)) if (near(h.s)) return { ...this.sel, handle: h };
    if (s && this.sel.kind === "opening") for (const h of this.rectHandles(s)) if (near(h.s)) return { ...this.sel, handle: h };
    if (s && this.sel.kind === "line") for (const [id, X] of [["a", s.x0], ["b", s.x1]]) if (near(this.f2s(X, s.z))) return { ...this.sel, handle: { id } };
    if (d.door) for (let i = 0; i < 4; i++) if (near(this.i2s({ x: d.door.pts[i][0], y: d.door.pts[i][1] }), 12)) return { kind: "door", handle: { id: i } };
    if (!this.ready()) return null;
    const f = this.s2f(p);
    if (!f) return null;
    const tol = this.mpp(p) * 8;
    for (const l of d.lines) if (Math.abs(f.Z - l.z) <= tol && f.X >= l.x0 - tol && f.X <= l.x1 + tol) return { kind: "line", id: l.id };
    const inside = (r) => f.X >= r.x0 && f.X <= r.x1 && f.Z >= r.z0 && f.Z <= r.z1;
    const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);
    const op = d.openings.filter(inside).sort((a, b) => area(a) - area(b))[0];
    if (op) return { kind: "opening", id: op.id };
    if (d.door && insidePoly(this.s2i(p), d.door.pts)) return { kind: "door" };
    const inRoof = (b) => b.roof !== "flat" && f.X >= b.x0 && f.X <= b.x1 && f.Z >= b.z1 && f.Z <= b.peak_z;
    const bl = d.blocks.filter((b) => inside(b) || inRoof(b)).sort((a, b) => area(a) - area(b))[0];
    if (bl) return { kind: "block", id: bl.id };
    if (d.ground && Math.abs(f.Z - d.ground.z) <= tol) return { kind: "ground" };
    return null;
  }

  down(e) {
    if (!this.img) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (e.altKey) this.noSnap = true;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...this.view } };
      return;
    }
    if (this.tool === "pan" || this.space || e.button === 1 || e.button === 2) {
      this.drag = { kind: "pan", start: p, view: { ...this.view } };
      return;
    }
    const before = this.snapshot();
    // the door's corners can be dragged with the door tool or Select
    if (this.tool === "door" || this.tool === "select") {
      const hit = this.hitTest(p);
      if (hit && hit.kind === "door" && hit.handle) { this.drag = { kind: "handle", hit, before, start: p, cur: p }; this.sel = { kind: "door" }; return; }
      if (this.tool === "door") { this.drag = { kind: "draw", tool: "door", start: p, cur: p, before }; return; }
      if (hit) {
        this.sel = { kind: hit.kind, id: hit.id };
        this.drag = hit.handle ? { kind: "handle", hit, before, start: p, cur: p } : { kind: "moveShape", hit, before, start: p, f0: this.s2f(p), orig: JSON.parse(JSON.stringify(this.shape(this.sel))) };
        this.paint();
        return;
      }
      this.sel = null; this.paint();
      this.drag = { kind: "pan", start: p, view: { ...this.view } };
      return;
    }
    const f = this.s2f(p);
    if (!f) return;
    if (this.tool === "measure") { this.measure = null; this.drag = { kind: "measure", a: f, start: p, cur: p }; return; }
    if (this.tool === "block" || this.tool === "opening") {
      const sx = this.snap(f.X, "x", p), sz = this.snap(f.Z, "z", p);
      this.drag = { kind: "draw", tool: this.tool, start: p, cur: p, a: { X: sx.v, Z: sz.v }, before };
      return;
    }
    if (this.tool === "floor") {
      const sz = this.snap(f.Z, "z", p);
      this.drag = { kind: "draw", tool: "floor", start: p, cur: p, a: { X: f.X, Z: sz.v }, before };
      return;
    }
    // ground, roof and light act on the tap (on release)
    this.drag = { kind: "tap", tool: this.tool, start: p, cur: p, before };
  }

  move(e) {
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    this.hover = p;
    const d = this.drag;
    if (!d) { if (this.ready() && this.tool !== "pan") this.render(); return; }
    d.cur = p;
    if (d.kind === "pinch" && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const k = Math.min(20, Math.max(0.05, d.view.k * (Math.hypot(a.x - b.x, a.y - b.y) / d.dist)));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ix = (d.mid.x - d.view.x) / d.view.k, iy = (d.mid.y - d.view.y) / d.view.k;
      this.view = { k, x: mid.x - ix * k, y: mid.y - iy * k, fitted: true };
      this.render();
      return;
    }
    if (d.kind === "pan") {
      this.view = { ...d.view, x: d.view.x + p.x - d.start.x, y: d.view.y + p.y - d.start.y, fitted: true };
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 4) d.moved = true;
      this.render();
      return;
    }
    if (d.kind === "handle") { this.dragHandle(d, p); this.render(); return; }
    if (d.kind === "moveShape") { this.dragShape(d, p); this.render(); return; }
    if (d.kind === "measure") {
      const b = this.s2f(p);
      if (b) this.measure = { a: d.a, b, dx: b.X - d.a.X, dz: b.Z - d.a.Z, len: Math.hypot(b.X - d.a.X, b.Z - d.a.Z) };
      this.render(); this.hintEl.textContent = this.hint();
      return;
    }
    if (d.kind === "draw" && d.tool !== "door") {
      const f = this.s2f(p);
      if (!f) return;
      if (d.tool === "floor") {
        d.line = { x0: Math.min(d.a.X, f.X), x1: Math.max(d.a.X, f.X), z: d.a.Z };
      } else {
        const sx = this.snap(f.X, "x", p), sz = this.snap(f.Z, "z", p);
        d.rect = { x0: Math.min(d.a.X, sx.v), x1: Math.max(d.a.X, sx.v), z0: Math.min(d.a.Z, sz.v), z1: Math.max(d.a.Z, sz.v) };
      }
    }
    this.render();
  }

  dragHandle(d, p) {
    const h = d.hit.handle;
    if (d.hit.kind === "door") {
      const i = this.s2i(p);
      this.doc.door.pts[h.id] = [round1(i.x), round1(i.y)];
      this.solve();
      return;
    }
    const s = this.shape(d.hit);
    const f = this.s2f(p);
    if (!s || !f) return;
    if (d.hit.kind === "line") { if (h.id === "a") s.x0 = f.X; else s.x1 = f.X; return; }
    if (h.id === "peak") {
      s.peak_z = Math.max(s.z1 + 0.05, f.Z);
      if (s.roof === "gable") s.peak_x = Math.min(s.x1, Math.max(s.x0, f.X));
      return;
    }
    s[h.kx] = this.snap(f.X, "x", p, s).v;
    s[h.kz] = this.snap(f.Z, "z", p, s).v;
  }

  dragShape(d, p) {
    const f = this.s2f(p);
    if (!f || !d.f0) return;
    if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 3) d.moved = true;
    if (!d.moved) return;
    const s = this.shape(d.hit), o = d.orig;
    let dx = f.X - d.f0.X, dz = f.Z - d.f0.Z;
    if (d.hit.kind === "ground") { s.z = this.snap(o.z + dz, "z", p, s).v; return; }
    if (d.hit.kind === "line") { s.z = this.snap(o.z + dz, "z", p, s).v; s.x0 = o.x0 + dx; s.x1 = o.x1 + dx; return; }
    if (d.hit.kind === "door") return;
    // snap whichever edge is nearest something
    const sx = this.snap(o.x0 + dx, "x", p, s), sx1 = this.snap(o.x1 + dx, "x", p, s);
    if (sx.hit) dx = sx.v - o.x0; else if (sx1.hit) dx = sx1.v - o.x1;
    const sz = this.snap(o.z0 + dz, "z", p, s), sz1 = this.snap(o.z1 + dz, "z", p, s);
    if (sz.hit) dz = sz.v - o.z0; else if (sz1.hit) dz = sz1.v - o.z1;
    s.x0 = o.x0 + dx; s.x1 = o.x1 + dx; s.z0 = o.z0 + dz; s.z1 = o.z1 + dz;
    if (o.peak_x !== undefined) { s.peak_x = o.peak_x + dx; s.peak_z = o.peak_z + dz; }
  }

  up(e, cancel = false) {
    this.pointers.delete(e.pointerId);
    this.noSnap = false;
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pinch") { if (this.pointers.size === 0) this.drag = null; return; }
    this.drag = null;
    if (cancel) { if (d.before) { this.doc = JSON.parse(d.before); this.solve(); } this.render(); return; }
    const p = this.local(e);
    const tapped = Math.hypot(p.x - d.start.x, p.y - d.start.y) < 6;
    if (d.kind === "pan") return;
    if (d.kind === "measure") { this.paint(); return; }
    if (d.kind === "handle" || d.kind === "moveShape") {
      this.tidy(this.shape(d.hit));
      this.commit(d.before);
      return;
    }
    if (d.kind === "draw" && d.tool === "door") {
      if (tapped) { this.render(); return; }
      const a = this.s2i(d.start), b = this.s2i(p);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const sz = this.doorSize();
      this.doc.door = { pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([u, v]) => [round1(u), round1(v)]), w: sz.w, h: sz.h };
      this.pendingDoor = null;
      this.sel = { kind: "door" };
      this.commit(d.before);
      L.toast("Now drag each corner exactly onto the door frame's corners");
      return;
    }
    if (d.kind === "draw" && d.rect) {
      const r = d.rect;
      if (r.x1 - r.x0 < 0.1 || r.z1 - r.z0 < 0.1) { this.render(); return; }
      const id = uid();
      if (d.tool === "block") {
        // a block that starts near the ground starts on it
        const gz = this.doc.ground ? this.doc.ground.z : null;
        if (gz !== null && Math.abs(r.z0 - gz) < 0.3) r.z0 = gz;
        this.doc.blocks.push({ id, name: `Block ${this.doc.blocks.length + 1}`, ...r, roof: "flat" });
        this.sel = { kind: "block", id };
      } else {
        this.doc.openings.push({ id, kind: this.opts.opening, ...r });
        this.sel = { kind: "opening", id };
      }
      this.commit(d.before);
      return;
    }
    if (d.kind === "draw" && d.tool === "floor") {
      const f = this.s2f(p);
      let line = d.line;
      if (!line || line.x1 - line.x0 < 0.3) {
        // a tap: run the line across the block it's on, else the house
        const X = f ? f.X : d.a.X;
        const b = this.doc.blocks.find((q) => X >= q.x0 && X <= q.x1);
        const o = this.origin();
        const W = this.doc.blocks.length ? Math.max(...this.doc.blocks.map((q) => q.x1)) : o.ox + this.ctx.house().size.width;
        line = b ? { x0: b.x0, x1: b.x1, z: d.a.Z } : { x0: o.ox, x1: W, z: d.a.Z };
      }
      const id = uid();
      const floor = this.opts.floor;
      // one line per floor: drawing it again moves it
      this.doc.lines = this.doc.lines.filter((l) => !floor || l.floor !== floor);
      this.doc.lines.push({ id, floor, ...line });
      this.sel = { kind: "line", id };
      this.opts.floor = this.nextFloor();
      this.commit(d.before);
      return;
    }
    if (d.kind === "tap" && tapped) {
      const f = this.s2f(p);
      if (!f) return;
      if (d.tool === "ground") {
        this.doc.ground = { z: f.Z };
        this.sel = { kind: "ground" };
        this.commit(d.before);
        if (!this.doc.blocks.length) this.setTool("block");
        return;
      }
      if (d.tool === "roof") {
        const b = this.doc.blocks.filter((q) => f.X >= q.x0 - 0.3 && f.X <= q.x1 + 0.3)
          .sort((a, c) => Math.abs(f.Z - a.z1) - Math.abs(f.Z - c.z1))[0];
        if (!b) { L.toast("Tap above one of the house blocks"); return; }
        b.roof = this.opts.roof;
        b.peak_z = Math.max(b.z1 + 0.1, f.Z);
        b.peak_x = Math.min(b.x1, Math.max(b.x0, f.X));
        this.sel = { kind: "block", id: b.id };
        this.commit(d.before);
        return;
      }
      if (d.tool === "light") {
        if (!this.ctx.selection().target) { L.toast("Pick a light from the list first"); return; }
        const o = this.origin();
        this.ctx.place(f.X - o.ox, f.Z - o.gz, this.opts.outside);
      }
    }
    this.render();
  }

  // keep rectangles the right way round after a drag
  tidy(s) {
    if (!s || s.x0 === undefined) return;
    if (s.x0 > s.x1) [s.x0, s.x1] = [s.x1, s.x0];
    if (s.z0 !== undefined && s.z0 > s.z1) [s.z0, s.z1] = [s.z1, s.z0];
    if (s.peak_z !== undefined) { s.peak_z = Math.max(s.peak_z, s.z1 + 0.05); s.peak_x = Math.min(s.x1, Math.max(s.x0, s.peak_x)); }
  }
};

// ---- helpers -----------------------------------------------------------------------------------

function uid() { return Math.random().toString(36).slice(2, 10); }
function round1(v) { return Math.round(v * 10) / 10; }

// The 3×3 homography taking four src points to four dst points (direct linear transform)
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h ? [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]] : null;
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function applyH(H, [x, y], raw) {
  const u = H[0][0] * x + H[0][1] * y + H[0][2], v = H[1][0] * x + H[1][1] * y + H[1][2], w = H[2][0] * x + H[2][1] * y + H[2][2];
  return raw ? [u, v, w] : [u / w, v / w];
}
function invert3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
function insidePoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (_) { /* fall back */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("That file isn't a photo this browser can read")); img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { field: v("--field") || "#111", text: "#ffffff", bg: "#000" };
}
function label(ctx, text, x, y, color, col, align = "left") {
  if (!text) return;
  ctx.font = `600 12px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textAlign = align; ctx.textBaseline = "alphabetic";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}
function hexA(color, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
function svgIcon(d) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p);
  return svg;
}
