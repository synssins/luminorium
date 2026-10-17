// The front photo: a picture of the front of the house, measured from its front door. The user
// boxes the door (36" × 80" unless changed); its four corners fix the perspective, so everything
// drawn on the photo after that has real sizes. Drawing tools: the door, the ground line, house
// blocks (walls), roofs (any outline, any number), windows and doors, floor lines (each one an
// HA floor's height), lights (placed where you tap), and a tape measure. Shapes are kept in facade metres
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
    this.opts = { back: "ridge", opening: "window", floor: null, outside: "inside", lineAt: L.store("house.lineAt", "floor") };
    this.roofDraft = null;      // the roof outline being drawn: [[X, Z], ...]
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
      roofs: (f.roofs || []).map((r) => ({ ...r, pts: r.pts.map((p) => [...p]) })),
      edges: (f.edges || []).map((e) => ({ ...e, pts: e.pts.map((p) => [...p]) })),
      floor_depth: f.floor_depth ?? 0.3048,
      eave: f.eave ?? EAVE_M,
    };
    this.edgeDraft = null;
    this.roofDraft = null;
    this.solve();
    this.derive();
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
    this.solve();
    this.derive();
    if (before === this.snapshot()) { this.paint(); return; }
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
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

  // The camera, from the door's four corners (image px: top left, top right, bottom right,
  // bottom left) and its real size.
  //
  // House coordinates here: X across (from the door's left edge), Z up (from the door's sill),
  // Y back from the front wall (0), into the house. The door sits `recess` behind the front wall.
  // The door's homography gives the camera up to its focal length; the focal length comes from
  // the door's perspective when that's strong enough to measure, else from a typical phone lens
  // (65° across). Then any plane parallel to the front wall (Y = a set-back or an overhang) and
  // the ground (Z = the ground) can be mapped to the photo and back.
  solve() {
    this.F2I = this.I2F = null;
    this.cam = null;
    this.planes = new Map();
    const d = this.doc && this.doc.door;
    if (!d || !this.photo) return;
    const F = [[0, d.h], [d.w, d.h], [d.w, 0], [0, 0]];
    let H = homography(F, d.pts);
    if (!H) return;
    // scale it so points in front of the camera have w > 0
    if (applyH(H, [d.w / 2, d.h / 2], true)[2] < 0) H = H.map((row) => row.map((v) => -v));
    const cam = solveCamera(H, this.photo.w, this.photo.h);
    if (!cam) return;
    this.cam = { ...cam, recess: d.recess || 0 };
    this.cam.pos = { ...cam.pos, Y: cam.pos.Y + this.cam.recess }; // from the front wall
    const front = this.plane(0);
    if (!front) return;
    this.F2I = front.H; this.I2F = front.Hi;
  }
  // The homography (and its inverse) for the plane Y = y, parallel to the front wall
  plane(y) {
    const key = Math.round(y * 1000);
    let pl = this.planes.get(key);
    if (pl) return pl;
    const c = this.cam;
    if (!c) return null;
    const k = y - c.recess;
    const H = [
      [c.H[0][0], c.H[0][1], c.H[0][2] + k * c.Kn[0]],
      [c.H[1][0], c.H[1][1], c.H[1][2] + k * c.Kn[1]],
      [c.H[2][0], c.H[2][1], c.H[2][2] + k * c.Kn[2]],
    ];
    const Hi = invert3(H);
    if (!Hi) return null;
    pl = { H, Hi };
    this.planes.set(key, pl);
    return pl;
  }
  toImage(X, Z, Y = 0) {
    const pl = this.plane(Y);
    if (!pl) return null;
    const p = applyH(pl.H, [X, Z], true);
    if (p[2] <= 1e-9) return null; // behind the camera
    return { x: p[0] / p[2], y: p[1] / p[2] };
  }
  toFacade(u, v, Y = 0) {
    const pl = this.plane(Y);
    if (!pl) return null;
    const p = applyH(pl.Hi, [u, v], true);
    if (Math.abs(p[2]) < 1e-12) return null;
    return { X: p[0] / p[2], Z: p[1] / p[2] };
  }
  // Where an image point lands on the level ground at height z: {X, Y} (Y: how far back)
  onGround(u, v, z) {
    const c = this.cam;
    if (!c) return null;
    const M = [
      [c.H[0][0], c.Kn[0], z * c.H[0][1] + c.H[0][2] - c.recess * c.Kn[0]],
      [c.H[1][0], c.Kn[1], z * c.H[1][1] + c.H[1][2] - c.recess * c.Kn[1]],
      [c.H[2][0], c.Kn[2], z * c.H[2][1] + c.H[2][2] - c.recess * c.Kn[2]],
    ];
    const Mi = invert3(M);
    if (!Mi) return null;
    const p = applyH(Mi, [u, v], true);
    if (Math.abs(p[2]) < 1e-12) return null;
    const X = p[0] / p[2], Y = p[1] / p[2];
    // only in front of the camera, and not absurdly far
    if (!(Y > c.pos.Y) || Math.abs(Y) > 200) return null;
    return { X, Y };
  }
  // Worked out from the drawing after each change: where the ground is (from the ground line's
  // two ends), the footprint along the front (each point of the ground line, on the ground), and
  // the front faces of blocks that follow the ground line.
  derive() {
    const g = this.doc.ground;
    if (!this.cam || !g || !g.pts || g.pts.length < 2) return;
    const ends = [g.pts[0], g.pts[g.pts.length - 1]].map(([u, v]) => this.toFacade(u, v, 0));
    if (ends.some((e) => !e)) return;
    g.z = round3((ends[0].Z + ends[1].Z) / 2);
    const foot = g.pts.map(([u, v]) => this.onGround(u, v, g.z));
    g.footprint = foot.every(Boolean) ? foot.map((q) => [round3(q.X), round3(q.Y)]) : null;
    const auto = this.doc.blocks.filter((b) => b.face === "auto");
    if (!auto.length || !g.footprint) return;
    this.keepOnPhoto(() => {
      for (const b of auto) b.y0 = round3(this.footY((b.x0 + b.x1) / 2) ?? 0);
    }, [...auto, ...this.doc.openings.filter((o) => auto.some((b) => inRect(o, b))), ...this.doc.lines.filter((l) => auto.some((b) => inRect({ x0: l.x0, x1: l.x1, z0: l.z, z1: l.z }, b)))]);
  }
  // What the front photo itself says to check (the server checks the rest)
  checks() {
    const out = [];
    const d = this.doc;
    if (!d || !this.cam || !d.door) return out;
    const fmt = L.fmtLen;
    const px = Math.hypot(d.door.pts[1][0] - d.door.pts[0][0], d.door.pts[1][1] - d.door.pts[0][1]);
    if (px < 40) out.push({ level: "info", tab: "photo", text: `The door is only ${Math.round(px)} pixels wide in the photo, so measurements are rough. Zoom in when fitting its corners, or use a closer photo.` });
    const xs = d.blocks.flatMap((b) => [b.x0, b.x1]);
    const mid = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : d.door.w / 2;
    const away = -this.cam.pos.Y;
    if (away > 0 && Math.abs(this.cam.pos.X - mid) > 0.7 * away) out.push({ level: "warn", tab: "photo", text: "The front photo was taken from well off to the side, so the far end of the house measures less reliably. A photo from straight across the street is best." });
    const g = d.ground;
    if (g && g.pts && g.pts.length >= 2) {
      const ends = [g.pts[0], g.pts[g.pts.length - 1]].map(([u, v]) => this.toFacade(u, v, 0));
      if (ends.every(Boolean) && Math.abs(ends[0].Z - ends[1].Z) > 0.3) out.push({ level: "warn", tab: "photo", text: `The ground line's ends are ${fmt(Math.abs(ends[0].Z - ends[1].Z))} apart in height. Either the yard slopes along the front, or one end is off.` });
    }
    return out;
  }

  // How far back the footprint is at X (along the ground line), or null
  footY(X) {
    const f = this.doc.ground && this.doc.ground.footprint;
    if (!f || f.length < 2) return null;
    const pts = [...f].sort((a, b) => a[0] - b[0]);
    if (X <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (X <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return x1 === x0 ? y1 : y0 + ((X - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return pts[pts.length - 1][1];
  }
  // The roofline: from the left end of the roof edges to the right end, overlaps counted once
  roofline() {
    const xs = this.doc.edges.flatMap((e) => e.pts.map((q) => q[0]));
    return xs.length ? { x0: Math.min(...xs), x1: Math.max(...xs), w: Math.max(...xs) - Math.min(...xs) } : null;
  }

  // The plane a shape is drawn on (its Y)
  planeOf(kind, s) {
    if (!s) return 0;
    if (kind === "block" || kind === "roof") return s.y0 || 0;
    if (kind === "edge") return -(this.doc.eave ?? EAVE_M);
    if (kind === "opening" || kind === "line") {
      const X = kind === "opening" ? (s.x0 + s.x1) / 2 : (s.x0 + s.x1) / 2;
      const Z = kind === "opening" ? (s.z0 + s.z1) / 2 : s.z;
      const b = this.doc.blocks.find((q) => X >= q.x0 && X <= q.x1 && Z >= q.z0 - 0.05 && Z <= q.z1 + 0.05);
      return b ? b.y0 || 0 : 0;
    }
    return 0;
  }
  // Keep every shape where it is on the photo while fn() changes the camera or a shape's plane
  keepOnPhoto(fn, only = null) {
    const pts = [];
    const add = (kind, s, get, set) => { if (!only || only.includes(s)) pts.push({ kind, s, img: get().map(([X, Z]) => this.toImage(X, Z, this.planeOf(kind, s))), set }); };
    for (const b of this.doc.blocks) add("block", b, () => [[b.x0, b.z0], [b.x1, b.z1]], (q) => { [[b.x0, b.z0], [b.x1, b.z1]] = q; });
    for (const o of this.doc.openings) add("opening", o, () => [[o.x0, o.z0], [o.x1, o.z1]], (q) => { [[o.x0, o.z0], [o.x1, o.z1]] = q; });
    for (const l of this.doc.lines) add("line", l, () => [[l.x0, l.z], [l.x1, l.z]], (q) => { l.x0 = q[0][0]; l.x1 = q[1][0]; l.z = (q[0][1] + q[1][1]) / 2; });
    for (const r of this.doc.roofs) add("roof", r, () => r.pts, (q) => { r.pts = q; });
    for (const e of this.doc.edges) add("edge", e, () => e.pts, (q) => { e.pts = q; });
    fn();
    this.solve();
    for (const p of pts) {
      if (p.img.some((q) => !q)) continue;
      const Y = this.planeOf(p.kind, p.s);
      const back = p.img.map((q) => this.toFacade(q.x, q.y, Y));
      if (back.some((q) => !q)) continue;
      p.set(back.map((q) => [q.X, q.Z]));
    }
    this.solve();
  }
  // image px <-> canvas px
  i2s(p) { return p && { x: p.x * this.view.k + this.view.x, y: p.y * this.view.k + this.view.y }; }
  s2i(p) { return { x: (p.x - this.view.x) / this.view.k, y: (p.y - this.view.y) / this.view.k }; }
  f2s(X, Z, Y = 0) { return this.i2s(this.toImage(X, Z, Y)); }
  s2f(p, Y = 0) { const i = this.s2i(p); return this.toFacade(i.x, i.y, Y); }
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
      for (const r of d.roofs) if (r !== skip) cands.push(...r.pts.map((q) => q[0]));
    } else {
      cands.push(0, d.door ? d.door.h : 0);
      if (d.ground) cands.push(d.ground.z);
      for (const b of d.blocks) if (b !== skip) cands.push(b.z0, b.z1);
      for (const o of d.openings) if (o !== skip) cands.push(o.z0, o.z1);
      for (const l of d.lines) if (l !== skip) cands.push(l.z);
      for (const r of d.roofs) if (r !== skip) cands.push(...r.pts.map((q) => q[1]));
    }
    let best = null;
    for (const c of cands) if (Math.abs(c - v) <= tol && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
    return best === null ? { v, hit: false } : { v: best, hit: true };
  }

  shape(sel) {
    if (!sel) return null;
    if (sel.kind === "door") return this.doc.door;
    if (sel.kind === "ground") return this.doc.ground;
    const list = { block: this.doc.blocks, opening: this.doc.openings, line: this.doc.lines, roof: this.doc.roofs, edge: this.doc.edges }[sel.kind];
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
    c.addEventListener("dblclick", (e) => this.dblclick(e));
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
      { id: "roof", label: "Roof outline", key: "R", icon: "M3 12l9-8 9 8M5 10v10h14V10", off: needDoor },
      { id: "edge", label: "Roof edge line", key: "E", icon: "M2 9l7-2 6 2 7-2M4 15h16", off: needDoor },
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
    if (id !== "roof") this.roofDraft = null;
    if (id !== "edge") this.edgeDraft = null;
    if (id !== "ground") this.groundDraft = null;
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
      { label: "Roofs", done: d.roofs.length > 0, tool: "roof" },
      { label: "Roof edges", done: d.edges.length > 0, tool: "edge" },
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
      case "ground": {
        const g = d.ground;
        if (this.groundDraft) return "Now tap where the wall meets the ground at the other end of the house.";
        if (!g || !g.pts) return "Tap where the wall meets the ground at one end of the house, then at the other end.";
        return "Where the front steps in or out, tap the ground line to add a bend, and drag it onto the corner in the photo. Drag the ends to tilt the line. Alt-click a bend to take it out.";
      }
      case "edge": return this.edgeDraft
        ? `${this.edgeDraft.length} point${this.edgeDraft.length === 1 ? "" : "s"}. Tap along the edge; tap the last point again (or press Enter) to finish.`
        : "Trace the bottom edge of each roof, from one end to the other. Draw one line for each roof level. Only the distance across from end to end counts.";
      case "block": return "Drag a box over each part of the house: from the ground to where the roof starts, wall edge to wall edge. Split levels, garages and the entry are their own blocks.";
      case "roof": return this.roofDraft
        ? `${this.roofDraft.length} corner${this.roofDraft.length === 1 ? "" : "s"}. Tap the next one; tap the first again (or press Enter) to finish. Backspace takes the last one back, Esc stops.`
        : "Tap each corner of a roof as you see it (eaves, peaks, breaks), all the way round. Draw as many roofs as the house has: the porch overhang and a dormer are roofs of their own.";
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
    const eaveField = () => lenField("Eaves stick out", this.doc.eave, (v) => {
      const b = this.snapshot();
      this.keepOnPhoto(() => { this.doc.eave = v; }, this.doc.edges);
      this.commit(b);
    }, 0, 2);
    const lenField = (label, value, set, lo = 0.3, hi = 6, after = null) => el("label.fc-o", el("span", label),
      el("input.input", { value: L.fmtLen(value), inputmode: "decimal", style: { width: "92px" },
        on: { change: (e) => { const v = L.parseLen(e.target.value); if (!(v >= lo && v <= hi)) { L.toast(`Give a size from ${L.fmtLen(lo)} to ${L.fmtLen(hi)}`); e.target.value = L.fmtLen(value); return; } set(v); } } }),
      after ? el("span", after) : null);
    if (this.tool === "door") {
      const sz = this.doorSize();
      const setSize = (k, v) => {
        if (this.doc.door) { const b = this.snapshot(); this.doc.door[k] = v; this.commit(b); }
        else { this.pendingDoor = { ...sz, [k]: v }; this.paint(); }
      };
      bits.push(el("span.fc-olabel", "Door size"), lenField("Width", sz.w, (v) => setSize("w", v)), lenField("Height", sz.h, (v) => setSize("h", v)),
        el("button.btn.small", { type: "button", on: { click: () => { setSize("w", 0.9144); setSize("h", 2.032); } } }, "Standard 36\" × 80\""));
      if (this.doc.door) bits.push(lenField("Set back into the wall by", this.doc.door.recess || 0, (v) => {
        const b = this.snapshot();
        this.keepOnPhoto(() => { this.doc.door.recess = v; });
        this.commit(b);
      }, 0, 5));
    } else if (this.tool === "edge") {
      const rl = this.roofline();
      bits.push(eaveField(), rl ? el("span.small", `Roofline ${L.fmtLen(rl.w)} across`) : null);
      if (this.edgeDraft) bits.push(
        el("button.btn.small.primary", { type: "button", disabled: this.edgeDraft.length < 2 ? "" : null, on: { click: () => this.finishEdge() } }, "Finish"),
        el("button.btn.small", { type: "button", on: { click: () => { this.edgeDraft = null; this.paint(); } } }, "Cancel"));
    } else if (this.tool === "roof") {
      bits.push(eaveField(), el("span.fc-olabel", "Goes back"), el("div.seg", { role: "radiogroup", "aria-label": "How the roof goes back" },
        ROOF_BACKS.map(([k, label]) =>
          el("button", { type: "button", role: "radio", "aria-checked": String(this.opts.back === k), on: { click: () => { this.opts.back = k; this.paint(); } } }, label))));
      if (this.roofDraft) bits.push(
        el("button.btn.small.primary", { type: "button", disabled: this.roofDraft.length < 3 ? "" : null, on: { click: () => this.finishRoof() } }, "Finish"),
        el("button.btn.small", { type: "button", on: { click: () => { this.roofDraft = null; this.paint(); } } }, "Cancel"));
    } else if (this.tool === "opening") {
      bits.push(el("span.fc-olabel", "Drawing a"), el("div.seg", { role: "radiogroup", "aria-label": "Opening" },
        [["window", "Window"], ["door", "Door"], ["garage", "Garage door"]].map(([k, label]) =>
          el("button", { type: "button", role: "radio", "aria-checked": String(this.opts.opening === k), on: { click: () => { this.opts.opening = k; this.paint(); } } }, label))));
    } else if (this.tool === "floor") {
      const floors = this.ctx.floors();
      const used = new Map(this.doc.lines.filter((l) => l.floor).map((l) => [l.floor, l]));
      bits.push(el("span.fc-olabel", "Floor"), el("div.chips", floors.map((f) =>
        el("button.chip", { type: "button", "aria-pressed": String(this.opts.floor === f.id), on: { click: () => { this.opts.floor = f.id; this.paint(); } } },
          f.name, used.has(f.id) ? el("span.n", "✓") : null))),
      el("span.fc-olabel", "The line is"), el("div.seg", { role: "radiogroup", "aria-label": "What the line marks" },
        LINE_AT.map(([k, label]) => el("button", { type: "button", role: "radio", "aria-checked": String(this.opts.lineAt === k),
          on: { click: () => { this.opts.lineAt = k; L.save("house.lineAt", k); this.paint(); } } }, label))),
      lenField("Floors are", this.doc.floor_depth, (v) => { const b = this.snapshot(); this.doc.floor_depth = v; this.commit(b); }, 0, 1, "thick"));
    } else if (this.tool === "light") {
      const s = this.ctx.selection();
      bits.push(el("span.fc-olabel", s.target ? s.target.name : "No light picked"),
        el("div.seg", { role: "radiogroup", "aria-label": "Where the light is" },
          [["inside", "Inside, by the window"], ["wall", "Outside, on the wall"], ["eave", "Under the eaves"]].map(([k, label]) =>
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
          el("dt", "Roofs"), el("dd", String(d.roofs.length)),
          this.roofline() ? [el("dt", "Roofline"), el("dd", `${fmt(this.roofline().w)} across`)] : null,
          this.cam ? [el("dt", "Photo taken from"), el("dd", `${fmt(-this.cam.pos.Y)} away, ${fmt(this.cam.pos.Z - (d.ground ? d.ground.z : 0))} up`)] : null,
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
        el("dl.fc-kv", el("dt", "Width"), el("dd", fmt(s.x1 - s.x0)), el("dt", "Wall height"), el("dd", fmt(s.z1 - s.z0 + (s.below || 0))),
          el("dt", "Bottom"), el("dd", s.below ? `${fmt(s.below)} in the ground` : fmt(s.z0 - o.gz, { signed: true }))),
        this.faceFields(s, edit, lenInput, field),
        field("Part of", el("select", { on: { change: (e) => edit(() => { if (e.target.value) s.level = e.target.value; else { delete s.level; delete s.floor; delete s.offset; } }) } },
          el("option", { value: "" }, "Not set"),
          this.ctx.floors().map((f) => el("option", { value: f.id, selected: s.level === f.id ? "" : null }, f.name)))),
        s.level ? this.offsetFields(s, edit, lenInput, field) : null,
        s.level ? el("label.check.small", el("input", { type: "checkbox", checked: s.floor === s.level, on: { change: (e) => edit(() => { if (e.target.checked) s.floor = s.level; else delete s.floor; }) } }),
          "Its bottom is that level's floor") : null,
        field("Goes into the ground by", lenInput(s.below, (v) => edit(() => { if (!v) delete s.below; else s.below = Math.min(10, v); }), "0 (a basement: how deep)")),
        field("Depth, front to back", lenInput(s.depth, (v) => edit(() => { if (v === null) delete s.depth; else s.depth = v; }), `${fmt(this.ctx.house().size.depth)} (the house)`)),
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
        field("The line is", el("select", { on: { change: (e) => edit(() => { s.at = e.target.value; }) } },
          LINE_AT.map(([k, label]) => el("option", { value: k, selected: (s.at || "floor") === k ? "" : null }, label)))),
        el("dl.fc-kv", el("dt", "The line"), el("dd", `${fmt(s.z - o.gz, { signed: true })} up`),
          el("dt", "The floor"), el("dd", `${fmt(this.floorZ(s) - o.gz, { signed: true })} up`), el("dt", "Spans"), el("dd", fmt(s.x1 - s.x0))),
        el("p.small.muted", `The floor's height and the part of the house it covers come from this line. The ceiling under it is ${fmt(this.doc.floor_depth)} lower (Floors are … thick, with the Floor line tool).`), del);
    } else if (this.sel.kind === "edge") {
      const xs = s.pts.map((q) => q[0]);
      body = el("div.fc-sum", el("h3", "Roof edge line"),
        el("dl.fc-kv", el("dt", "Across"), el("dd", fmt(Math.max(...xs) - Math.min(...xs))), el("dt", "Points"), el("dd", String(s.pts.length)),
          this.roofline() ? [el("dt", "Whole roofline"), el("dd", fmt(this.roofline().w))] : null),
        el("p.small.muted", "Only the distance across counts; where roof edges overlap it's counted once. Drag a point to move it, Alt-click to take it out."), del);
    } else if (this.sel.kind === "roof") {
      const depth = this.ctx.house().size.depth;
      const zs = s.pts.map((q) => q[1]);
      body = el("div.fc-sum", el("h3", s.name || "Roof"),
        field("Name", el("input.input", { value: s.name || "", on: { change: (e) => edit(() => { s.name = e.target.value.slice(0, 60); }) } })),
        field("Goes back", el("select", { on: { change: (e) => edit(() => { s.back = e.target.value; }) } },
          ROOF_BACKS.map(([k, label]) => el("option", { value: k, selected: s.back === k ? "" : null }, label)))),
        el("p.small.muted", ROOF_HELP[s.back]),
        field("Depth, front to back", lenInput(s.depth, (v) => edit(() => { if (v === null) delete s.depth; else s.depth = v; }), `${fmt(depth)} (the house)`)),
        s.back === "ridge" ? field("The ridge is this far back", lenInput(s.ridge_y, (v) => edit(() => { if (v === null) delete s.ridge_y; else s.ridge_y = v; }), `${fmt((s.depth ?? depth) / 2)} (halfway)`)) : null,
        field("Set back (less than 0: sticks out toward the street)", lenInput(s.y0, (v) => edit(() => { if (v === null) delete s.y0; else s.y0 = v; }), "0")),
        el("dl.fc-kv", el("dt", "Corners"), el("dd", String(s.pts.length)),
          el("dt", "Eaves"), el("dd", `${fmt(Math.min(...zs) - o.gz)} up`), el("dt", "Top"), el("dd", `${fmt(Math.max(...zs) - o.gz)} up`)),
        el("p.small.muted", "Drag a corner to move it. Double-click an edge to add a corner; Alt-click a corner to take it out."),
        del);
    } else if (this.sel.kind === "door") {
      body = el("div.fc-sum", el("h3", "Front door"),
        el("p.small.muted", "Its corners set the scale and the perspective for everything else. Change the door size with the Front door tool."),
        el("dl.fc-kv", el("dt", "Size"), el("dd", `${fmt(s.w)} × ${fmt(s.h)}`)));
    } else if (this.sel.kind === "ground") {
      const foot = s.footprint || [];
      const ys = foot.map((q) => q[1]);
      body = el("div.fc-sum", el("h3", "Ground line"),
        el("dl.fc-kv", el("dt", "Door sill above it"), el("dd", fmt(-s.z)),
          s.pts ? [el("dt", "Bends"), el("dd", String(Math.max(0, s.pts.length - 2)))] : null,
          ys.length ? [el("dt", "Front steps in by up to"), el("dd", fmt(Math.max(0, Math.max(...ys) - Math.min(...ys))))] : null),
        el("p.small.muted", "Blocks set to Follows the ground line take their front from it."), del);
    }
    L.set(this.inspEl, body);
    this.inspEl.style.display = body ? "" : "none";
  }

  remove() {
    if (!this.sel || this.sel.kind === "door") return;
    const b = this.snapshot();
    if (this.sel.kind === "ground") this.doc.ground = null;
    else {
      const key = { block: "blocks", opening: "openings", line: "lines", roof: "roofs", edge: "edges" }[this.sel.kind];
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
  fpoly(pts, Y = 0) {
    const out = pts.map(([X, Z]) => this.f2s(X, Z, Y));
    return out.some((p) => !p) ? null : out;
  }
  path(ctx, pts, close = true) {
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (close) ctx.closePath();
  }

  drawShapes(ctx, col) {
    const d = this.doc;
    const isSel = (kind, id) => this.sel && this.sel.kind === kind && (id === undefined || this.sel.id === id);
    const BLOCK = "#5aa9e6", OPEN = "#9ad0f5", LINE = "#f0b429", GROUND = "#7bc47f", DOOR = "#ff8a3d", ROOF = "#c58cf0", EDGE = "#ff5d6c";
    if (this.ready()) {
      const span = this.span();
      // blocks: wall and roof
      for (const b of d.blocks) {
        const sel = isSel("block", b.id);
        const by = b.y0 || 0;
        const wall = this.fpoly([[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]], by);
        if (wall) {
          this.path(ctx, wall); ctx.fillStyle = hexA(BLOCK, sel ? 0.28 : 0.14); ctx.fill();
          ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = BLOCK; ctx.stroke();
          const lab = this.f2s(b.x0, b.z1, by);
          const face = b.y0 ? (b.y0 < 0 ? ` · sticks out ${L.fmtLen(-b.y0)}` : ` · set back ${L.fmtLen(b.y0)}`) : "";
          if (lab) label(ctx, `${b.name || "Block"}${face}`, lab.x + 6, lab.y + 16, BLOCK, col);
        }
        if (b.below) {
          // the part in the ground (a basement), dashed below its bottom
          const under = this.fpoly([[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z0 - b.below], [b.x0, b.z0 - b.below]], by);
          if (under) {
            this.path(ctx, under); ctx.fillStyle = hexA(BLOCK, 0.08); ctx.fill();
            ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = BLOCK; ctx.stroke(); ctx.setLineDash([]);
            label(ctx, `${L.fmtLen(b.below)} in the ground`, under[3].x + 6, under[3].y - 6, BLOCK, col);
          }
        }
        if (sel) this.handles(ctx, this.rectHandles(b, by), BLOCK);
      }
      // roofs: their outlines
      for (const r of d.roofs) {
        const sel = isSel("roof", r.id);
        const q = this.fpoly(r.pts, r.y0 || 0);
        if (!q) continue;
        this.path(ctx, q); ctx.fillStyle = hexA(ROOF, sel ? 0.3 : 0.16); ctx.fill();
        ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = ROOF; ctx.setLineDash(sel ? [] : [6, 4]); ctx.stroke(); ctx.setLineDash([]);
        const top = q.reduce((a, b) => (b.y < a.y ? b : a));
        label(ctx, r.name || "Roof", top.x, top.y - 8, ROOF, col, "center");
        if (sel) this.handles(ctx, q.map((p, i) => ({ id: i, s: p })), ROOF);
      }
      for (const o of d.openings) {
        const sel = isSel("opening", o.id);
        const oy = this.planeOf("opening", o);
        const q = this.fpoly([[o.x0, o.z0], [o.x1, o.z0], [o.x1, o.z1], [o.x0, o.z1]], oy);
        if (!q) continue;
        this.path(ctx, q); ctx.fillStyle = hexA(OPEN, sel ? 0.35 : 0.18); ctx.fill();
        ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = OPEN; ctx.stroke();
        if (o.kind !== "window") { const c = this.f2s((o.x0 + o.x1) / 2, o.z1, oy); if (c) label(ctx, o.kind === "garage" ? "Garage" : "Door", c.x, c.y - 6, OPEN, col, "center"); }
        if (sel) this.handles(ctx, this.rectHandles(o, oy), OPEN);
      }
      // roof edge lines
      for (const e of d.edges) {
        const sel = isSel("edge", e.id);
        const q = this.fpoly(e.pts, this.planeOf("edge", e));
        if (!q) continue;
        ctx.lineWidth = sel ? 3.5 : 2.5; ctx.strokeStyle = EDGE; this.path(ctx, q, false); ctx.stroke();
        if (sel) this.handles(ctx, q.map((p, i) => ({ id: i, s: p })), EDGE);
      }
      const rl = this.roofline();
      if (rl && d.edges.length) {
        const ey = this.planeOf("edge");
        const topZ = Math.max(...d.edges.flatMap((e) => e.pts.map((q) => q[1]))) + 0.4;
        const a = this.f2s(rl.x0, topZ, ey), b = this.f2s(rl.x1, topZ, ey);
        if (a && b) {
          ctx.strokeStyle = EDGE; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
          label(ctx, `Roofline ${L.fmtLen(rl.w)}`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 6, EDGE, col, "center");
        }
      }
      // the ground: a traced line with bends, or (from before) a level line
      const g = d.ground;
      if (g && g.pts && g.pts.length >= 2) {
        const q = g.pts.map(([u, v]) => this.i2s({ x: u, y: v }));
        ctx.lineWidth = isSel("ground") || this.tool === "ground" ? 3 : 2; ctx.strokeStyle = GROUND; ctx.setLineDash([10, 6]);
        this.path(ctx, q, false); ctx.stroke(); ctx.setLineDash([]);
        label(ctx, "Ground", q[0].x + 8, q[0].y - 8, GROUND, col);
        if (isSel("ground") || this.tool === "ground") this.handles(ctx, q.map((p, i) => ({ id: i, s: p })), GROUND, true);
        // how far back each bend is
        if (g.footprint) g.footprint.forEach(([, Y], i) => { if (i > 0 && i < q.length - 1 && Math.abs(Y) > 0.05) label(ctx, Y > 0 ? `${L.fmtLen(Y)} back` : `${L.fmtLen(-Y)} out`, q[i].x, q[i].y + 18, GROUND, col, "center"); });
      }
      if (this.groundDraft) {
        const a = this.i2s({ x: this.groundDraft[0], y: this.groundDraft[1] });
        ctx.beginPath(); ctx.arc(a.x, a.y, 6, 0, Math.PI * 2); ctx.fillStyle = GROUND; ctx.fill();
        if (this.hover) { ctx.strokeStyle = GROUND; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(this.hover.x, this.hover.y); ctx.stroke(); ctx.setLineDash([]); }
      }
      const gz = g && !g.pts ? g.z : null;
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
        const q = this.fpoly([[l.x0, l.z], [l.x1, l.z]], this.planeOf("line", l));
        if (!q) continue;
        ctx.lineWidth = sel ? 4 : 3; ctx.strokeStyle = LINE; this.path(ctx, q, false); ctx.stroke();
        const f = floors.get(l.floor);
        const under = l.at === "below" ? " (ceiling under it)" : "";
        label(ctx, `${f ? f.name : "Floor?"}  ${L.fmtLen(this.floorZ(l) - o0.gz, { signed: true })}${under}`, q[0].x + 6, q[0].y - 8, LINE, col);
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
    if (this.roofDraft && this.roofDraft.length) {
      const pts = this.roofDraft.map(([X, Z]) => this.f2s(X, Z));
      if (!pts.some((q) => !q)) {
        const hov = this.hover && this.tool === "roof" ? this.snapPoint(this.hover) : null;
        const hs = hov ? this.f2s(hov.X, hov.Z) : null;
        ctx.lineWidth = 2; ctx.strokeStyle = ROOF;
        this.path(ctx, hs ? [...pts, hs] : pts, false); ctx.stroke();
        if (hs && pts.length > 1) { ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(hs.x, hs.y); ctx.lineTo(pts[0].x, pts[0].y); ctx.stroke(); ctx.setLineDash([]); }
        this.handles(ctx, pts.map((p, i) => ({ id: i, s: p })), ROOF, false);
        // the first corner: tap it to close the outline
        ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 11, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
      }
    }
    if (this.edgeDraft && this.edgeDraft.length) {
      const ey = this.planeOf("edge");
      const pts = this.edgeDraft.map(([X, Z]) => this.f2s(X, Z, ey));
      if (!pts.some((q) => !q)) {
        ctx.lineWidth = 2.5; ctx.strokeStyle = "#ff5d6c";
        this.path(ctx, this.hover ? [...pts, this.hover] : pts, false); ctx.stroke();
        this.handles(ctx, pts.map((p, i) => ({ id: i, s: p })), "#ff5d6c", false);
        const last = pts[pts.length - 1];
        ctx.beginPath(); ctx.arc(last.x, last.y, 11, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
      }
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
  rectHandles(r, Y = 0) {
    return [["x0", "z0"], ["x1", "z0"], ["x1", "z1"], ["x0", "z1"]].map(([kx, kz]) => ({ id: `${kx}${kz}`, kx, kz, s: this.f2s(r[kx], r[kz], Y) }));
  }

  // Front face and floor height of a block, as the inspector shows them
  faceFields(s, edit, lenInput, field) {
    const { el } = L;
    const mode = s.face || (s.y0 ? (s.y0 < 0 ? "out" : "back") : "line");
    const setFace = (m, d) => edit(() => this.keepOnPhoto(() => {
      s.face = m;
      if (m === "line") s.y0 = 0;
      else if (m === "out") s.y0 = -Math.abs(d ?? (s.y0 || 0.3048));
      else if (m === "back") s.y0 = Math.abs(d ?? (s.y0 || 0.3048));
      else s.y0 = round3(this.footY((s.x0 + s.x1) / 2) ?? 0);
    }, [s, ...this.doc.openings.filter((o) => inRect(o, s))]));
    const hasBends = this.doc.ground && this.doc.ground.pts && this.doc.ground.pts.length > 2;
    const options = [["line", "In line"], ["out", "Sticks out"], ["back", "Set back"], ...(hasBends || mode === "auto" ? [["auto", "Follows the ground line"]] : [])];
    return el("div.field", el("span", "Its front wall"),
      el("div.seg", { role: "radiogroup", "aria-label": "Its front wall" }, options.map(([k, label]) =>
        el("button", { type: "button", role: "radio", "aria-checked": String(mode === k), on: { click: () => setFace(k) } }, label))),
      mode === "out" || mode === "back" ? lenInput(Math.abs(s.y0 || 0), (v) => setFace(mode, v ?? 0), "how far") : null,
      el("span.small.muted", mode === "line" ? "In line with the main front wall."
        : mode === "auto" ? `${L.fmtLen(Math.abs(s.y0 || 0))} ${(s.y0 || 0) < 0 ? "out" : "back"}, from the ground line.`
          : mode === "out" ? "Closer to the street than the main front wall, like an overhang." : "Further back than the main front wall, like a recessed entry."));
  }
  offsetFields(s, edit, lenInput, field) {
    const { el } = L;
    const mode = !s.offset ? "same" : s.offset > 0 ? "up" : "down";
    const set = (m, d) => edit(() => { if (m === "same") delete s.offset; else s.offset = (m === "up" ? 1 : -1) * Math.abs(d ?? (s.offset || 0.6096)); });
    return el("div.field", el("span", "Its floor"),
      el("div.seg", { role: "radiogroup", "aria-label": "Its floor" }, [["same", "Same as the level"], ["up", "Higher"], ["down", "Lower"]].map(([k, label]) =>
        el("button", { type: "button", role: "radio", "aria-checked": String(mode === k), on: { click: () => set(k) } }, label))),
      mode !== "same" ? lenInput(Math.abs(s.offset), (v) => set(mode, v ?? 0), "by how much") : null,
      el("span.small.muted", "A space inside the level with its own floor, like a landing or a storage room over the entry."));
  }

  finishEdge() {
    const pts = this.edgeDraft;
    if (!pts || pts.length < 2) return;
    const before = this.snapshot();
    const id = uid();
    this.doc.edges.push({ id, pts: pts.map(([X, Z]) => [X, Z]) });
    this.edgeDraft = null;
    this.sel = { kind: "edge", id };
    this.commit(before);
  }
  // where a floor line puts its floor: on the line, or the floor's thickness above it
  floorZ(line) { return line.z + (line.at === "below" ? this.doc.floor_depth : 0); }

  // a roof corner under the pointer, snapped to the edges and corners already drawn
  snapPoint(p) {
    const f = this.s2f(p);
    if (!f) return null;
    return { X: this.snap(f.X, "x", p).v, Z: this.snap(f.Z, "z", p).v };
  }

  finishRoof() {
    const pts = this.roofDraft;
    if (!pts || pts.length < 3) return;
    const before = this.snapshot();
    const id = uid();
    this.doc.roofs.push({ id, name: `Roof ${this.doc.roofs.length + 1}`, pts: pts.map(([X, Z]) => [X, Z]), back: this.opts.back });
    this.roofDraft = null;
    this.sel = { kind: "roof", id };
    this.commit(before);
  }

  // Double-click an edge of the picked roof to add a corner there (or a roof edge line, a point)
  dblclick(e) {
    const s = this.shape(this.sel);
    if (s && this.sel.kind === "edge" && this.tool === "select") {
      const p = this.local(e), Y = this.planeOf("edge", s);
      const at = this.nearPolyline(p, s.pts.map(([X, Z]) => this.f2s(X, Z, Y)), 10);
      const f = this.s2f(p, Y);
      if (!at || !f) return;
      const before = this.snapshot();
      s.pts.splice(at.i + 1, 0, [f.X, f.Z]);
      this.commit(before);
      return;
    }
    if (!s || this.sel.kind !== "roof" || this.tool !== "select") return;
    const p = this.local(e);
    const q = s.pts.map(([X, Z]) => this.f2s(X, Z, s.y0 || 0));
    let best = null;
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      if (!a || !b) continue;
      const d = distToSegment(p, a, b);
      if (d < 10 && (!best || d < best.d)) best = { i, d };
    }
    if (!best) return;
    const f = this.s2f(p);
    if (!f) return;
    const before = this.snapshot();
    s.pts.splice(best.i + 1, 0, [f.X, f.Z]);
    this.commit(before);
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
    if (this.roofDraft) {
      if (e.key === "Enter") { e.preventDefault(); this.finishRoof(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); this.roofDraft = this.roofDraft.slice(0, -1); if (!this.roofDraft.length) this.roofDraft = null; this.paint(); return; }
      if (e.key === "Escape") { this.roofDraft = null; this.paint(); return; }
    }
    if (this.edgeDraft) {
      if (e.key === "Enter") { e.preventDefault(); this.finishEdge(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); this.edgeDraft = this.edgeDraft.slice(0, -1); if (!this.edgeDraft.length) this.edgeDraft = null; this.paint(); return; }
      if (e.key === "Escape") { this.edgeDraft = null; this.paint(); return; }
    }
    if (this.groundDraft && e.key === "Escape") { this.groundDraft = null; this.paint(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.remove(); return; }
    if (e.key === "Escape") { this.sel = null; this.drag = null; this.measure = null; this.paint(); return; }
    if (e.key === "Alt") { this.noSnap = true; return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = this.TOOLS().find((x) => x.key && x.key.toLowerCase() === k);
    if (t) { e.preventDefault(); this.setTool(t.id); }
  }

  // Which shape (or handle) is under a screen point. Each shape is tested on its own plane.
  hitTest(p) {
    const near = (q, r = 11) => q && Math.hypot(q.x - p.x, q.y - p.y) <= r;
    const d = this.doc;
    // handles of the picked shape first
    const s = this.shape(this.sel);
    const k = this.sel && this.sel.kind;
    if (s && k === "block") for (const h of this.rectHandles(s, s.y0 || 0)) if (near(h.s)) return { ...this.sel, handle: h };
    if (s && (k === "roof" || k === "edge")) {
      const Y = this.planeOf(k, s);
      for (let i = 0; i < s.pts.length; i++) if (near(this.f2s(s.pts[i][0], s.pts[i][1], Y))) return { ...this.sel, handle: { id: i } };
    }
    if (s && k === "opening") for (const h of this.rectHandles(s, this.planeOf("opening", s))) if (near(h.s)) return { ...this.sel, handle: h };
    if (s && k === "line") for (const [id, X] of [["a", s.x0], ["b", s.x1]]) if (near(this.f2s(X, s.z, this.planeOf("line", s)))) return { ...this.sel, handle: { id } };
    const g = d.ground;
    if (g && g.pts && (k === "ground" || this.tool === "ground")) {
      for (let i = 0; i < g.pts.length; i++) if (near(this.i2s({ x: g.pts[i][0], y: g.pts[i][1] }), 12)) return { kind: "ground", handle: { id: i } };
    }
    if (d.door) for (let i = 0; i < 4; i++) if (near(this.i2s({ x: d.door.pts[i][0], y: d.door.pts[i][1] }), 12)) return { kind: "door", handle: { id: i } };
    if (!this.ready()) return null;
    const f0 = this.s2f(p);
    if (!f0) return null;
    const tol = this.mpp(p) * 8;
    for (const l of d.lines) {
      const f = this.s2f(p, this.planeOf("line", l)) || f0;
      if (Math.abs(f.Z - l.z) <= tol && f.X >= l.x0 - tol && f.X <= l.x1 + tol) return { kind: "line", id: l.id };
    }
    for (const e of d.edges) if (this.nearPolyline(p, e.pts.map(([X, Z]) => this.f2s(X, Z, this.planeOf("edge", e))), 8) !== null) return { kind: "edge", id: e.id };
    const insideOn = (r, Y) => { const f = this.s2f(p, Y); return f && f.X >= r.x0 && f.X <= r.x1 && f.Z >= r.z0 && f.Z <= r.z1; };
    const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);
    const op = d.openings.filter((o) => insideOn(o, this.planeOf("opening", o))).sort((a, b) => area(a) - area(b))[0];
    if (op) return { kind: "opening", id: op.id };
    if (d.door && insidePoly(this.s2i(p), d.door.pts)) return { kind: "door" };
    const roof = d.roofs.filter((r) => { const f = this.s2f(p, r.y0 || 0); return f && insidePoly({ x: f.X, y: f.Z }, r.pts); })
      .sort((a, b) => polyArea(a.pts) - polyArea(b.pts))[0];
    if (roof) return { kind: "roof", id: roof.id };
    const bl = d.blocks.filter((b) => insideOn(b, b.y0 || 0)).sort((a, b) => area(a) - area(b))[0];
    if (bl) return { kind: "block", id: bl.id };
    if (g && g.pts && this.nearPolyline(p, g.pts.map(([u, v]) => this.i2s({ x: u, y: v })), 8) !== null) return { kind: "ground" };
    if (g && !g.pts && Math.abs(f0.Z - g.z) <= tol) return { kind: "ground" };
    return null;
  }

  // The segment of a screen polyline within r px of p: {i, t} (t along segment i), or null
  nearPolyline(p, q, r) {
    if (q.some((x) => !x)) return null;
    let best = null;
    for (let i = 0; i + 1 < q.length; i++) {
      const a = q[i], b = q[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      const dist = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (dist <= r && (!best || dist < best.dist)) best = { i, t, dist };
    }
    return best;
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
    // The ground line's points can be dragged with the ground tool too
    if (this.tool === "ground" && this.doc.ground && this.doc.ground.pts) {
      const hit = this.hitTest(p);
      if (hit && hit.kind === "ground" && hit.handle) {
        if (e.altKey) { this.removePoint(hit, before); return; }
        this.sel = { kind: "ground" };
        this.drag = { kind: "handle", hit, before, start: p, cur: p };
        return;
      }
    }
    if (this.tool === "door" || this.tool === "select") {
      const hit = this.hitTest(p);
      if (hit && hit.kind === "door" && hit.handle) { this.drag = { kind: "handle", hit, before, start: p, cur: p }; this.sel = { kind: "door" }; return; }
      if (this.tool === "door") { this.drag = { kind: "draw", tool: "door", start: p, cur: p, before }; return; }
      if (hit && hit.handle && e.altKey && ["roof", "edge", "ground"].includes(hit.kind)) { this.removePoint(hit, before); return; }
      if (hit) {
        this.sel = { kind: hit.kind, id: hit.id };
        const Y = this.planeOf(hit.kind, this.shape(this.sel));
        this.drag = hit.handle ? { kind: "handle", hit, before, start: p, cur: p } : { kind: "moveShape", hit, before, start: p, plane: Y, f0: this.s2f(p, Y), i0: this.s2i(p), orig: JSON.parse(JSON.stringify(this.shape(this.sel))) };
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

  // Take a point out of a roof outline, a roof edge line, or a bend out of the ground line
  removePoint(hit, before) {
    const sh = this.shape(hit);
    if (hit.kind === "ground") {
      if (hit.handle.id === 0 || hit.handle.id === sh.pts.length - 1) { L.toast("The ends of the ground line stay; drag them instead"); return; }
      sh.pts.splice(hit.handle.id, 1);
    } else {
      const least = hit.kind === "roof" ? 3 : 2;
      if (sh.pts.length <= least) { L.toast(hit.kind === "roof" ? "A roof needs at least three corners" : "A line needs two points"); return; }
      sh.pts.splice(hit.handle.id, 1);
    }
    this.commit(before);
  }

  dragHandle(d, p) {
    const h = d.hit.handle;
    if (d.hit.kind === "door") {
      const i = this.s2i(p);
      this.doc.door.pts[h.id] = [round1(i.x), round1(i.y)];
      this.solve();
      return;
    }
    if (d.hit.kind === "ground") {
      const i = this.s2i(p);
      this.doc.ground.pts[h.id] = [round1(i.x), round1(i.y)];
      return;
    }
    const s = this.shape(d.hit);
    const f = this.s2f(p, this.planeOf(d.hit.kind, s));
    if (!s || !f) return;
    if (d.hit.kind === "line") { if (h.id === "a") s.x0 = f.X; else s.x1 = f.X; return; }
    if (d.hit.kind === "roof" || d.hit.kind === "edge") { s.pts[h.id] = [this.snap(f.X, "x", p, s).v, this.snap(f.Z, "z", p, s).v]; return; }
    s[h.kx] = this.snap(f.X, "x", p, s).v;
    s[h.kz] = this.snap(f.Z, "z", p, s).v;
  }

  dragShape(d, p) {
    if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 3) d.moved = true;
    if (!d.moved) return;
    const s = this.shape(d.hit), o = d.orig;
    if (d.hit.kind === "ground" && o.pts) {
      const i = this.s2i(p);
      s.pts = o.pts.map(([u, v]) => [round1(u + i.x - d.i0.x), round1(v + i.y - d.i0.y)]);
      return;
    }
    const f = this.s2f(p, d.plane || 0);
    if (!f || !d.f0) return;
    let dx = f.X - d.f0.X, dz = f.Z - d.f0.Z;
    if (d.hit.kind === "ground") { s.z = this.snap(o.z + dz, "z", p, s).v; return; }
    if (d.hit.kind === "edge") { s.pts = o.pts.map(([X, Z]) => [X + dx, Z + dz]); return; }
    if (d.hit.kind === "line") { s.z = this.snap(o.z + dz, "z", p, s).v; s.x0 = o.x0 + dx; s.x1 = o.x1 + dx; return; }
    if (d.hit.kind === "door") return;
    if (d.hit.kind === "roof") { s.pts = o.pts.map(([X, Z]) => [X + dx, Z + dz]); return; }
    // snap whichever edge is nearest something
    const sx = this.snap(o.x0 + dx, "x", p, s), sx1 = this.snap(o.x1 + dx, "x", p, s);
    if (sx.hit) dx = sx.v - o.x0; else if (sx1.hit) dx = sx1.v - o.x1;
    const sz = this.snap(o.z0 + dz, "z", p, s), sz1 = this.snap(o.z1 + dz, "z", p, s);
    if (sz.hit) dz = sz.v - o.z0; else if (sz1.hit) dz = sz1.v - o.z1;
    s.x0 = o.x0 + dx; s.x1 = o.x1 + dx; s.z0 = o.z0 + dz; s.z1 = o.z1 + dz;
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
        const follows = this.doc.ground && this.doc.ground.pts && this.doc.ground.pts.length > 2;
        this.doc.blocks.push({ id, name: `Block ${this.doc.blocks.length + 1}`, ...r, ...(follows ? { face: "auto" } : {}) });
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
      this.doc.lines.push({ id, floor, ...line, at: this.opts.lineAt });
      this.sel = { kind: "line", id };
      this.opts.floor = this.nextFloor();
      this.commit(d.before);
      return;
    }
    if (d.kind === "tap" && tapped) {
      const f = this.s2f(p);
      if (!f) return;
      if (d.tool === "ground") {
        const i = this.s2i(p);
        const g = this.doc.ground;
        if (g && g.pts) {
          // a tap on the line adds a bend there
          const at = this.nearPolyline(p, g.pts.map(([u, v]) => this.i2s({ x: u, y: v })), 12);
          if (!at) { L.toast("Tap on the ground line to add a bend"); return; }
          g.pts.splice(at.i + 1, 0, [round1(i.x), round1(i.y)]);
          this.sel = { kind: "ground" };
          this.commit(d.before);
          return;
        }
        if (!this.groundDraft) { this.groundDraft = [round1(i.x), round1(i.y)]; this.paint(); return; }
        const pts = [this.groundDraft, [round1(i.x), round1(i.y)]].sort((a, b) => a[0] - b[0]);
        this.groundDraft = null;
        this.doc.ground = { z: 0, pts };
        this.sel = { kind: "ground" };
        this.commit(d.before);
        if (!this.doc.blocks.length) this.setTool("block");
        return;
      }
      if (d.tool === "edge") {
        const Y = this.planeOf("edge");
        const draft = this.edgeDraft || [];
        const last = draft.length ? this.f2s(draft[draft.length - 1][0], draft[draft.length - 1][1], Y) : null;
        if (last && draft.length >= 2 && Math.hypot(last.x - p.x, last.y - p.y) <= 12) { this.finishEdge(); return; }
        const fe = this.s2f(p, Y);
        if (!fe) return;
        this.edgeDraft = [...draft, [fe.X, fe.Z]];
        this.paint();
        return;
      }
      if (d.tool === "roof") {
        const draft = this.roofDraft || [];
        const first = draft.length ? this.f2s(draft[0][0], draft[0][1]) : null;
        if (first && draft.length >= 3 && Math.hypot(first.x - p.x, first.y - p.y) <= 12) { this.finishRoof(); return; }
        const at = this.snapPoint(p);
        if (!at) return;
        this.roofDraft = [...draft, [at.X, at.Z]];
        this.paint();
        return;
      }
      if (d.tool === "light") {
        if (!this.ctx.selection().target) { L.toast("Pick a light from the list first"); return; }
        // the block under the tap, measured on its own wall
        const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);
        const blk = [...this.doc.blocks].sort((a, b) => area(a) - area(b)).find((b) => {
          const fb = this.s2f(p, b.y0 || 0);
          return fb && fb.X >= b.x0 && fb.X <= b.x1 && fb.Z >= b.z0 && fb.Z <= b.z1 + 0.5;
        });
        const wallY = blk ? blk.y0 || 0 : 0;
        const fw = this.s2f(p, wallY) || f;
        const o = this.origin();
        this.ctx.place(fw.X - o.ox, fw.Z - o.gz, this.opts.outside, wallY, blk || null, this.doc.eave);
      }
    }
    this.render();
  }

  // keep rectangles the right way round after a drag
  tidy(s) {
    if (!s || s.x0 === undefined) return;
    if (s.x0 > s.x1) [s.x0, s.x1] = [s.x1, s.x0];
    if (s.z0 !== undefined && s.z0 > s.z1) [s.z0, s.z1] = [s.z1, s.z0];
  }
};

// ---- helpers -----------------------------------------------------------------------------------

const ROOF_BACKS = [["ridge", "Slopes to a ridge"], ["extrude", "Same shape all the way back"], ["shed", "One slope to the back"]];
const ROOF_HELP = {
  ridge: "Its outline is the front slope: up to a ridge, then down the back. Drawn as a trapezoid it's a hip roof; as a rectangle, the gable ends are at the sides.",
  extrude: "The outline is pushed straight back: a gable facing the street, a flat roof, or any shape that's the same from front to back.",
  shed: "One slope, from the eaves at the front up to the top at the back.",
};
const LINE_AT = [["floor", "The floor"], ["below", "The ceiling under it"]];

// Soffits stick out about 24" past the walls on most houses
const EAVE_M = 0.6096;

// The camera behind a plane's homography H (plane coords X across, Z up -> image px). The focal
// length comes from H's perspective when two estimates agree, else a typical phone lens (65°
// across). Returns {H, f, Kn (K times the plane's normal, scaled like H's columns), pos}.
function solveCamera(H, w, h) {
  const cx = w / 2, cy = h / 2;
  const col = (j) => [H[0][j] - cx * H[2][j], H[1][j] - cy * H[2][j], H[2][j]];
  const p = col(0), q = col(1);
  const fallback = (w / 2) / Math.tan((65 / 2) * Math.PI / 180);
  const lo = (w / 2) / Math.tan(55 * Math.PI / 180), hi = (w / 2) / Math.tan(10 * Math.PI / 180);
  const est = [];
  const den1 = p[2] * q[2];
  if (Math.abs(den1) > 1e-12) est.push(-(p[0] * q[0] + p[1] * q[1]) / den1);
  const den2 = p[2] * p[2] - q[2] * q[2];
  if (Math.abs(den2) > 1e-12) est.push((q[0] * q[0] + q[1] * q[1] - p[0] * p[0] - p[1] * p[1]) / den2);
  const good = est.filter((f2) => f2 > lo * lo && f2 < hi * hi).map(Math.sqrt);
  let f = fallback;
  if (good.length === 2 && Math.abs(good[0] - good[1]) / Math.max(...good) < 0.25) f = (good[0] + good[1]) / 2;
  const Kinv = (v) => [(v[0] - cx * v[2]) / f, (v[1] - cy * v[2]) / f, v[2]];
  const a1 = Kinv([H[0][0], H[1][0], H[2][0]]), a2 = Kinv([H[0][1], H[1][1], H[2][1]]), a3 = Kinv([H[0][2], H[1][2], H[2][2]]);
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  const lam = (len(a1) + len(a2)) / 2;
  if (!(lam > 0)) return null;
  let n = [a1[1] * a2[2] - a1[2] * a2[1], a1[2] * a2[0] - a1[0] * a2[2], a1[0] * a2[1] - a1[1] * a2[0]];
  const nl = len(n) || 1;
  n = n.map((v) => (v / nl) * lam);
  if (n[2] < 0) n = n.map((v) => -v); // into the house is away from the camera
  const Kn = [f * n[0] + cx * n[2], f * n[1] + cy * n[2], n[2]];
  // where the camera is: a1 X + a2 Z + n Y' = -a3 (Y' measured from the door's plane)
  const M = [[a1[0], a2[0], n[0]], [a1[1], a2[1], n[1]], [a1[2], a2[2], n[2]]];
  const Mi = invert3(M);
  if (!Mi) return null;
  const sol = [0, 1, 2].map((i) => -(Mi[i][0] * a3[0] + Mi[i][1] * a3[1] + Mi[i][2] * a3[2]));
  return { H, f, fov: 2 * Math.atan((w / 2) / f) * 180 / Math.PI, measuredLens: f !== fallback, Kn, pos: { X: sol[0], Z: sol[1], Y: sol[2] } };
}

function uid() { return Math.random().toString(36).slice(2, 10); }
function round3(v) { return Math.round(v * 1000) / 1000; }
// whether rectangle a's middle is inside rectangle b
function inRect(a, b) {
  const X = (a.x0 + a.x1) / 2, Z = (a.z0 + a.z1) / 2;
  return X >= b.x0 && X <= b.x1 && Z >= b.z0 - 0.05 && Z <= b.z1 + 0.05;
}
function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
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
