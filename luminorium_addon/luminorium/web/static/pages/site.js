// The top view: a satellite or drone photo of the house from above, squared up and scaled from the
// front photo's roofline, and what's traced on it: the roof outline (the walls are the eaves'
// depth inside it), the yard (paths, driveways, patios, pools, beds, lawns, trees, bushes), each
// level's floor plan (walls by measurement, doors, rooms), and where floods and spots point.
//
// Everything traced is kept in house metres: x across the front from its left end, y back from
// the front wall (the street is at the bottom of the view). The photo is placed on that with a
// scale, a turn and a shift (`xf`), worked out from two lines the user draws. Uses the helpers
// facade.js defines (label, hexA, svgIcon, loadBitmap, uid, round3, insidePoly, polyArea).
"use strict";

window.SiteEditor = class SiteEditor {
  // ctx: { house(), floors(), areas(), selection() -> {target, part}, select(id), place(x, y, level),
  //        aim(id, aim), saved(view), changed() }
  constructor(ctx) {
    this.ctx = ctx;
    this.doc = null;
    this.photo = null;
    this.img = null;
    this.tool = "square";
    this.picks = [];          // several picked (Ctrl+click): [{ kind, id }]
    this.sel = null;          // { kind: "outline"|"yard"|"wall"|"door"|"room"|"square"|"ref"|"check", id }
    this.level = null;        // the level whose floor plan is shown
    this.opts = { yard: "path", studs: "2x4", finish: "drywall", smooth: false, angled: false };
    this.draft = null;        // points being traced: { kind, pts: [[x, y]] } in house metres, or photo px
    this.undoStack = []; this.redoStack = [];
    this.view = { k: 10, x: 0, y: 0, fitted: false };
    this.pointers = new Map();
    this.drag = null;
    this.hover = null;
    this.measure = null;
    this.saveTimer = null;
    this.root = L.el("div.fc");
    this.root.editor = this; // for scripted checks
    this.build();
  }

  // ---- data ------------------------------------------------------------------------------------

  load(site) {
    const s = site || {};
    this.photo = s.photo || null;
    this.doc = {
      xf: s.xf || null, square: s.square || null, turns: s.turns || 0, trim: s.trim || 0, ref: s.ref || null, check: s.check || null,
      outline: s.outline ? s.outline.map((p) => [...p]) : null, ext_wall: s.ext_wall || "2x6",
      yard: (s.yard || []).map((y) => JSON.parse(JSON.stringify(y))),
      walls: (s.walls || []).map((w) => JSON.parse(JSON.stringify(w))),
      doors: (s.doors || []).map((d) => ({ ...d })), rooms: (s.rooms || []).map((r) => JSON.parse(JSON.stringify(r))),
      stairs: (s.stairs || []).map((t) => ({ ...t })),
    };
    if (!this.level) this.level = this.defaultLevel();
    this.draft = null;
    if (this.doc.outline && this.doc.xf && this.squareOutline()) {
      this.scheduleSave();
      L.toast("Squared up the roof outline (and the photo with it)");
    }
    if (this.photo && (!this.img || this.img._for !== JSON.stringify(this.photo))) this.loadImage();
    if (!this.photo) this.img = null;
    if (!this.doc.square) this.tool = "square";
    this.paint();
  }
  defaultLevel() {
    const f = this.ctx.floors();
    return (f.find((x) => /main/i.test(x.name)) || f[0] || {}).id || null;
  }
  loadImage() {
    const img = new Image();
    img._for = JSON.stringify(this.photo);
    img.onload = () => { this.img = img; this.view.fitted = false; this.paint(); };
    img.onerror = () => L.toast("Couldn't load the photo");
    img.src = `api/house/photo?which=top&t=${Date.now()}`;
  }
  snapshot() { return JSON.stringify(this.doc); }
  commit(before) {
    this.place();
    if (before === this.snapshot()) { this.paint(); return; }
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    this.scheduleSave();
    this.paint();
  }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.doc = JSON.parse(this.undoStack.pop()); this.afterHistory(); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.doc = JSON.parse(this.redoStack.pop()); this.afterHistory(); }
  afterHistory() { this.picks = this.picks.filter((q) => this.shape(q)); if (this.sel && !this.shape(this.sel)) this.sel = null; this.scheduleSave(); this.paint(); }
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveEl.textContent = "Saving…";
    this.saveTimer = setTimeout(() => this.save(), 600);
  }
  async save() {
    try {
      const view = await L.api("api/house/site", { method: "PUT", body: this.doc });
      this.saveEl.textContent = "Saved";
      this.ctx.saved(view);
    } catch (e) {
      this.saveEl.textContent = "Not saved";
      L.toast(e.message);
    }
  }
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
      const r = await fetch(`api/house/photo?which=top&w=${w}&h=${h}`, { method: "PUT", body: blob, headers: { "Content-Type": "image/jpeg" } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `Upload failed (${r.status})`);
      const site = await r.json();
      this.img = null;
      this.undoStack.length = 0; this.redoStack.length = 0;
      this.load(site);
      this.ctx.changed();
      L.toast("Photo added. Now draw along a straight wall or roof edge to square it up.");
    } catch (e) {
      L.toast(e.message || "Couldn't read that photo");
    }
  }
  async startOver() {
    if (!this.confirmClear) { this.confirmClear = true; this.paint(); return; }
    this.confirmClear = false;
    const view = await L.api("api/house/site", { method: "DELETE" });
    this.img = null; this.sel = null; this.undoStack.length = 0;
    this.load(null);
    this.ctx.saved(view);
  }

  // ---- placing the photo -------------------------------------------------------------------------
  //
  // photo px (u right, v down) -> house metres: flip v, turn by theta, scale by s, shift by (tx, ty)

  xf() { return this.doc.xf || this.provisional(); }
  // Before it's scaled: the photo fitted to about 40 m across, turned as far as it's squared
  provisional() {
    const w = this.photo ? this.photo.w : 1000, h = this.photo ? this.photo.h : 1000;
    const s = 40 / Math.max(w, h);
    const theta = this.theta();
    const [cx, cy] = rot([w / 2, -h / 2], theta);
    return { s, theta, tx: 10 - cx * s, ty: 8 - cy * s };
  }
  theta() {
    const sq = this.doc.square;
    let t = 0;
    if (sq) {
      const phi = Math.atan2(-(sq.b[1] - sq.a[1]), sq.b[0] - sq.a[0]);
      t = (sq.runs === "depth" ? Math.PI / 2 : 0) - phi;
    }
    return t + (this.doc.turns || 0) * Math.PI / 2 + (this.doc.trim || 0);
  }

  // Square the roof outline to the house. Its edges' average lean from straight across or
  // straight back is taken out by turning the photo that little bit (so the tracing still sits on
  // the roof), then each edge is made exactly straight. Only for outlines that are nearly square
  // already (every edge within 12° of across or back); returns whether it changed anything.
  squareOutline() {
    const o = this.doc.outline;
    if (!o || o.length < 4) return false;
    const n = o.length;
    let sum = 0, weight = 0;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = o[i], [x1, y1] = o[(i + 1) % n];
      const len = Math.hypot(x1 - x0, y1 - y0);
      let a = Math.atan2(y1 - y0, x1 - x0);
      // the lean from the nearest of across or back, -45° to 45°
      a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
      if (a > Math.PI / 4) a -= Math.PI / 2;
      if (Math.abs(a) > 12 * Math.PI / 180) return false;
      sum += a * len; weight += len;
    }
    const lean = weight ? sum / weight : 0;
    const before = JSON.stringify(o);
    if (Math.abs(lean) > 0.0005 && this.doc.xf) {
      this.doc.trim = (this.doc.trim || 0) - lean;
      this.place(); // turns the photo and the outline with it
    }
    // then each edge straight: across edges share one y, back edges one x
    const q = this.doc.outline.map((p) => [...p]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const across = Math.abs(q[j][0] - q[i][0]) >= Math.abs(q[j][1] - q[i][1]);
      if (across) { const y = (q[i][1] + q[j][1]) / 2; q[i][1] = y; q[j][1] = y; }
      else { const x = (q[i][0] + q[j][0]) / 2; q[i][0] = x; q[j][0] = x; }
    }
    this.doc.outline = q.map(([x, y]) => [round3(x), round3(y)]);
    return JSON.stringify(this.doc.outline) !== before;
  }
  p2h(u, v, xf = this.xf()) { const [a, b] = rot([u, -v], xf.theta); return [a * xf.s + xf.tx, b * xf.s + xf.ty]; }
  h2p(x, y, xf = this.xf()) { const [a, b] = rot([(x - xf.tx) / xf.s, (y - xf.ty) / xf.s], -xf.theta); return [a, -b]; }

  // The roofline from the front photo, in house metres: { x0, w }
  frontRoofline() {
    const m = this.ctx.house().massing;
    if (!m || !m.roofline) return null;
    const f = this.ctx.house().facade || {};
    const xs = (f.edges || []).flatMap((e) => e.pts.map((q) => q[0]));
    const ox = (f.blocks || []).length ? Math.min(...f.blocks.map((b) => b.x0)) : 0;
    return xs.length ? { x0: Math.min(...xs) - ox, w: m.roofline } : null;
  }
  eave() { return (this.ctx.house().massing || {}).eave ?? 0.6096; }

  // Work out the photo's placement from the square-up line and the scale line, keeping whatever
  // is traced where it is on the photo
  place() {
    const d = this.doc;
    if (!d.ref || d.ref.pts.length < 2) return;
    const theta = this.theta();
    const ends = [d.ref.pts[0], d.ref.pts[d.ref.pts.length - 1]].map(([u, v]) => rot([u, -v], theta));
    const across = Math.abs(ends[1][0] - ends[0][0]);
    const front = this.frontRoofline();
    const length = d.ref.length || (front && front.w);
    if (!length || across < 5) return;
    const s = length / across;
    const left = ends[0][0] <= ends[1][0] ? ends[0] : ends[1];
    // the left end of the roof edge sits at the roofline's left end, the eaves' depth out front
    const ax = front ? front.x0 : 0, ay = -this.eave();
    const xf = { s, theta, tx: ax - left[0] * s, ty: ay - left[1] * s };
    const old = d.xf;
    if (old && Math.abs(old.s - xf.s) < 1e-9 && Math.abs(old.theta - xf.theta) < 1e-9 && Math.abs(old.tx - xf.tx) < 1e-6 && Math.abs(old.ty - xf.ty) < 1e-6) return;
    // keep the tracing on the photo
    const move = ([x, y]) => { const [u, v] = this.h2p(x, y, old || this.provisional()); return this.p2h(u, v, xf).map(round3); };
    if (old) {
      if (d.outline) d.outline = d.outline.map(move);
      for (const y of d.yard) { if (y.pts) y.pts = y.pts.map(move); if (y.parts) y.parts = y.parts.map((q) => q.map(move)); if (y.c) { y.c = move(y.c); y.r = round3(y.r * xf.s / old.s); } }
    }
    d.xf = xf;
  }
  calibrated() { return !!this.doc.xf; }
  // How far the check line says the scale is off, as a fraction
  checkError() {
    const c = this.doc.check;
    if (!c || !c.length || !this.doc.xf || c.pts.length < 2) return null;
    const ends = [c.pts[0], c.pts[c.pts.length - 1]].map(([u, v]) => this.p2h(u, v));
    const deep = Math.abs(ends[1][1] - ends[0][1]);
    return deep > 0 ? (deep - c.length) / c.length : null;
  }

  // ---- view: house metres <-> screen (the street at the bottom) --------------------------------

  h2s(x, y) { return { x: this.view.x + x * this.view.k, y: this.view.y - y * this.view.k }; }
  s2h(p) { return [(p.x - this.view.x) / this.view.k, (this.view.y - p.y) / this.view.k]; }
  fit() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    if (!W || !H) return;
    const xs = [], ys = [];
    const house = this.ctx.house();
    if (this.calibrated() || !this.photo) {
      // the house and the yard, with room around them
      const pts = [...(this.doc.outline || []), ...this.doc.yard.flatMap((y) => y.pts || [[y.c[0] - y.r, y.c[1] - y.r], [y.c[0] + y.r, y.c[1] + y.r]])];
      for (const [x, y] of pts) { xs.push(x); ys.push(y); }
      xs.push(-4, house.size.width + 4); ys.push(-8, house.size.depth + 4);
    } else for (const [u, v] of [[0, 0], [this.photo.w, 0], [this.photo.w, this.photo.h], [0, this.photo.h]]) { const [x, y] = this.p2h(u, v); xs.push(x); ys.push(y); }
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const k = Math.min(W / (x1 - x0), H / (y1 - y0)) * 0.94;
    this.view = { k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 + ((y0 + y1) / 2) * k, fitted: true };
  }
  zoomAt(p, f) {
    const [x, y] = this.s2h(p);
    const k = Math.min(400, Math.max(1, this.view.k * f));
    this.view.k = k; this.view.x = p.x - x * k; this.view.y = p.y + y * k;
    this.render();
  }
  mpp() { return 1 / this.view.k; }

  // The outside walls: the roof outline pulled in by the eaves, and their inside face
  planOuter() { return this.doc.outline ? insetPoly(this.doc.outline, this.eave()) : null; }
  planInner() { const o = this.planOuter(); return o ? insetPoly(o, EXT_WALL[this.doc.ext_wall] || EXT_WALL["2x6"]) : null; }

  shape(sel) {
    if (!sel) return null;
    const d = this.doc;
    if (sel.kind === "outline") return d.outline;
    if (sel.kind === "square") return d.square;
    if (sel.kind === "ref") return d.ref;
    if (sel.kind === "check") return d.check;
    if (sel.kind === "light") return this.ctx.house().targets.find((t) => t.id === sel.id) || null;
    const list = { yard: d.yard, wall: d.walls, door: d.doors, room: d.rooms, stairs: d.stairs }[sel.kind];
    return list ? list.find((x) => x.id === sel.id) || null : null;
  }

  // ---- page parts --------------------------------------------------------------------------------

  build() {
    const { el } = L;
    this.canvas = el("canvas", { role: "img", "aria-label": "The house from above", tabindex: "0", style: { width: "100%", height: "100%", display: "block", touchAction: "none" } });
    this.c2d = this.canvas.getContext("2d");
    this.toolbar = el("div.fc-tools", { role: "toolbar", "aria-label": "Drawing tools", "aria-orientation": "vertical" });
    this.optionsBar = el("div.fc-opts");
    this.stepsEl = el("ol.fc-steps", { "aria-label": "Steps" });
    this.hintEl = el("div.fc-hint", { role: "status" });
    this.inspEl = el("div.fc-insp");
    this.saveEl = el("span.small.muted", "");
    this.fileInput = el("input", { type: "file", accept: "image/*", style: { display: "none" }, on: { change: (e) => { this.upload(e.target.files[0]); e.target.value = ""; } } });
    this.stage = el("div.fc-stage", this.canvas);
    this.empty = el("div.fc-empty",
      el("div", { style: { fontSize: "16px", fontWeight: "600" } }, "Add a photo of the house from above"),
      el("p.muted", { style: { margin: "6px 0 14px", maxWidth: "52ch" } },
        "A screenshot of your house on a satellite map works well: zoom in until the house fills most of the screen, and include the yard. The front photo sets the scale, so do that first."),
      el("div.row", { style: { gap: "8px", justifyContent: "center" } },
        el("button.btn.primary", { type: "button", on: { click: () => this.fileInput.click() } }, "Choose a photo"),
        el("button.btn", { type: "button", on: { click: () => { this.noPhoto = true; this.tool = "outline"; this.paint(); } } }, "Draw without a photo")));
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
  }
  open() { return !!this.photo || this.noPhoto || !!this.doc.outline; }

  TOOLS() {
    const needPhoto = !!this.photo && !this.doc.square;
    const needScale = !!this.photo && !this.calibrated();
    return [
      { id: "select", label: "Select", key: "V", icon: "M5 3l14 8-6 2-2 6z" },
      { id: "pan", label: "Pan", key: "H", icon: "M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L8 13" },
      { sep: true },
      { id: "square", label: "Square up", key: "Q", icon: "M4 20L20 4M4 14v6h6", off: !this.photo },
      { id: "ref", label: "Scale from the roofline", key: "S", icon: "M3 12h18M3 8v8M21 8v8", off: needPhoto },
      { id: "outline", label: "Roof outline", key: "O", icon: "M4 6h10l6 6v6H4z", off: needScale },
      { id: "yard", label: "Yard", key: "Y", icon: "M12 3a5 5 0 0 0-5 5c0 3 5 9 5 9s5-6 5-9a5 5 0 0 0-5-5zM4 21h16", off: needScale },
      { sep: true },
      { id: "wall", label: "Wall", key: "W", icon: "M4 4v16M4 12h16", off: needScale || !this.doc.outline },
      { id: "stairs", label: "Stairs", key: "T", icon: "M4 20h4v-4h4v-4h4V8h4", off: needScale },
      { id: "door", label: "Door in a wall", key: "D", icon: "M6 21V3h12v18M14 12h.01", off: needScale || !this.doc.walls.length },
      { id: "room", label: "Name a room", key: "R", icon: "M4 4h16v16H4zM8 10h8M8 14h5", off: needScale },
      { sep: true },
      { id: "light", label: "Place a light", key: "L", icon: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z", off: needScale },
      { id: "aim", label: "Aim a light", key: "A", icon: "M12 12l8-5v10zM12 12h-8M4 9v6", off: needScale },
      { id: "measure", label: "Measure", key: "M", icon: "M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2", off: needScale },
      { id: "across", label: "Measure across", key: "X", icon: "M3 5v14M21 5v14M9 8v8M15 8v8M3 12h18", off: needScale || !this.doc.outline },
    ];
  }
  setTool(id) {
    const t = this.TOOLS().find((x) => x.id === id);
    if (!t || t.off) return;
    if (id !== "across") this.chain = null;
    this.tool = id;
    this.draft = null;
    this.measure = null;
    this.paint();
    this.canvas.focus({ preventScroll: true });
  }

  steps() {
    const d = this.doc;
    const aimed = this.ctx.house().targets.some((t) => t.item && t.item.aim);
    return [
      { label: "Photo", done: !!this.photo, act: () => this.fileInput.click() },
      { label: "Square up", done: !!d.square, tool: "square" },
      { label: "Scale", done: this.calibrated(), tool: "ref" },
      { label: "Roof outline", done: !!d.outline, tool: "outline" },
      { label: "Yard", done: d.yard.length > 0, tool: "yard" },
      { label: "Floor plans", done: d.walls.length > 0, tool: "wall" },
      { label: "Aim lights", done: aimed, tool: "aim" },
    ];
  }

  hint() {
    if (!this.open()) return "";
    if (this.photo && !this.img) return "Loading the photo…";
    const fmt = L.fmtLen;
    const d = this.doc, dr = this.draft;
    switch (this.tool) {
      case "square": return "Drag along any long straight wall or roof edge. The photo turns so the house is square. Then use Turn if the street isn't at the bottom.";
      case "ref": {
        const f = this.frontRoofline();
        if (dr) return `${dr.pts.length} point${dr.pts.length === 1 ? "" : "s"}. Keep tapping along the front roof edge; tap the last point again (or press Enter) at the far end.`;
        return f ? `Trace the front edge of the roof from one end to the other, as you did on the front photo. Its length across, ${fmt(f.w)}, sets the scale.`
          : "Trace the front edge of the roof from one end to the other, then type how long it is across (mark the roof edges on the front photo to have it measured for you).";
      }
      case "outline": return dr ? `${dr.pts.length} corner${dr.pts.length === 1 ? "" : "s"}. Tap each corner of the roof; tap the first one again (or press Enter) to finish.`
        : d.outline ? `The walls are ${fmt(this.eave())} inside the roof (the eaves). Drag a corner to move it; double-click an edge to add a corner; Alt-click a corner to take it out.`
          : "Tap each corner of the roof's outline, all the way round. The walls are worked out from it.";
      case "yard": {
        const k = this.opts.yard;
        if (k === "tree" || k === "bush") return `Drag from the middle of the ${k} out to its edge.`;
        if (dr) return `${dr.pts.length} point${dr.pts.length === 1 ? "" : "s"}. Tap the next; ${k === "path" ? "tap the last point again (or Enter) to finish" : "tap the first point again (or Enter) to close it"}.`;
        return k === "path" ? "Tap along the middle of the path, from one end to the other." : `Tap around the edge of the ${YARD_LABEL[k].toLowerCase()}. Turn on Curved for round shapes.`;
      }
      case "wall": return this.movePlan ? `Drag anywhere to move the whole ${this.levelName()} plan: walls, doorways, rooms and stairs.`
        : `Drag from where a wall starts to where it ends, on the ${this.levelName()} plan. Ends snap onto other walls and their corners (a ring shows it); hold Alt to stop it. ${this.opts.angled ? "Angled: the end goes anywhere." : "It stays square unless Angled is on."} Then type how far it is from another wall.`;
      case "stairs": return `Drag over the stairs on the ${this.levelName()} plan, from the bottom step to the top (or the top to the bottom, for stairs going down). Then pick where they lead.`;
      case "door": return "Tap a wall where a doorway is.";
      case "room": return "Tap inside a room to name it.";
      case "light": {
        const s = this.ctx.selection();
        return s.target ? `Tap where ${s.target.name} is (${this.levelName()}${this.level === OUT ? "" : " level"}).` : "Pick a light from the list, then tap where it is.";
      }
      case "aim": return this.sel && this.sel.kind === "light" ? "Tap what it should light (the ground, a tree, a bush) to point it there, or drag the arrow to turn it. Drag the edge of its beam to widen it. Tilt it in the panel." : "Tap a light to aim it.";
      case "across": return !this.chain || !this.chain.items.length
        ? `Tap the walls in order straight across the ${this.levelName()} plan, as you measured them: an outside wall first if you can, then each wall in between, then the far wall.`
        : "Keep tapping walls in order across, then type each tape measurement in the panel.";
      case "measure": return this.measure ? `${fmt(this.measure.len)} · drag again to measure something else` : "Drag from one point to another to measure it.";
      case "pan": return "Drag to move. Scroll or pinch to zoom.";
      default: return "Tap something to pick it; drag it or its handles. Delete removes it.";
    }
  }
  levelName() { return this.level === OUT ? "Outside" : (this.ctx.floors().find((f) => f.id === this.level) || {}).name || "this"; }

  paint() {
    if (!this.doc) return;
    const { el } = L;
    const open = this.open();
    this.empty.style.display = open ? "none" : "";
    this.stage.style.display = open ? "" : "none";
    this.replaceBtn.style.display = this.photo ? "" : "none";
    L.set(this.stepsEl, ...this.steps().map((s, i) => el("li", el("button", { type: "button", class: `fc-step${s.done ? " done" : ""}${s.tool && s.tool === this.tool ? " on" : ""}`,
      disabled: !open && i > 0 ? "" : null, on: { click: () => (s.act ? s.act() : this.setTool(s.tool)) } }, el("span.n", s.done ? "✓" : String(i + 1)), s.label))));
    L.set(this.toolbar, ...this.TOOLS().map((t) => t.sep ? el("span.fc-sep") :
      el("button", { type: "button", class: "fc-tool", title: `${t.label} (${t.key})`, "aria-label": t.label, "aria-pressed": String(this.tool === t.id),
        disabled: t.off || !open ? "" : null, on: { click: () => this.setTool(t.id) } }, svgIcon(t.icon), el("span.fc-tl", t.label))),
    el("span.fc-sep"),
    el("button", { type: "button", class: "fc-tool", title: "Undo (Ctrl+Z)", "aria-label": "Undo", disabled: this.undoStack.length ? null : "", on: { click: () => this.undo() } }, svgIcon("M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"), el("span.fc-tl", "Undo")),
    el("button", { type: "button", class: "fc-tool", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo", disabled: this.redoStack.length ? null : "", on: { click: () => this.redo() } }, svgIcon("M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"), el("span.fc-tl", "Redo")),
    el("button", { type: "button", class: "fc-tool", title: "Fit", "aria-label": "Fit", on: { click: () => { this.view.fitted = false; this.render(); } } }, svgIcon("M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"), el("span.fc-tl", "Fit")));
    this.paintOptions();
    this.paintInspector();
    this.hintEl.textContent = this.hint();
    this.render();
  }

  lenField(label, value, set, lo = 0, hi = 500, placeholder = "") {
    const { el } = L;
    return el("label.fc-o", el("span", label), el("input.input", { value: value == null ? "" : L.fmtLen(value), placeholder, inputmode: "decimal", style: { width: "96px" },
      on: { change: (e) => { const t = e.target.value.trim(); if (!t) return set(null); const v = L.parseLen(t); if (!(v >= lo && v <= hi)) { L.toast(`Give a length from ${L.fmtLen(lo)} to ${L.fmtLen(hi)}`); e.target.value = value == null ? "" : L.fmtLen(value); return; } set(v); } } }));
  }
  levelChips(withOutside) {
    const { el } = L;
    const levels = [...this.ctx.floors().map((f) => [f.id, f.name]), ...(withOutside ? [[OUT, "Outside"]] : [])];
    return el("div.chips", levels.map(([id, name]) => el("button.chip", { type: "button", "aria-pressed": String(this.level === id), on: { click: () => { this.level = id; this.paint(); } } }, name)));
  }

  paintOptions() {
    const { el } = L;
    const d = this.doc, bits = [];
    const edit = (fn) => { const b = this.snapshot(); fn(); this.commit(b); };
    if (this.tool === "square" && d.square) {
      bits.push(el("span.fc-olabel", "The line runs"), el("div.seg", { role: "radiogroup", "aria-label": "The line runs" },
        [["across", "Across the front"], ["depth", "Front to back"]].map(([k, label]) => el("button", { type: "button", role: "radio", "aria-checked": String(d.square.runs === k),
          on: { click: () => edit(() => { d.square.runs = k; }) } }, label))),
      el("button.btn.small", { type: "button", on: { click: () => edit(() => { d.turns = ((d.turns || 0) + 1) % 4; this.view.fitted = false; }) } }, "Turn ↻"),
      el("span.small.muted", "Turn until the street is at the bottom."));
    } else if (this.tool === "ref") {
      const f = this.frontRoofline();
      bits.push(this.lenField("Its length across", d.ref && d.ref.length ? d.ref.length : null, (v) => edit(() => { if (!d.ref) return; if (v == null) delete d.ref.length; else d.ref.length = v; }), 1, 300, f ? `${L.fmtLen(f.w)} (front photo)` : "type it"));
      if (this.draft) bits.push(el("button.btn.small.primary", { type: "button", disabled: this.draft.pts.length < 2 ? "" : null, on: { click: () => this.finishDraft() } }, "Finish"),
        el("button.btn.small", { type: "button", on: { click: () => { this.draft = null; this.paint(); } } }, "Cancel"));
      bits.push(el("button.btn.small", { type: "button", on: { click: () => { this.checking = !this.checking; this.draft = null; this.paint(); } }, "aria-pressed": String(!!this.checking) }, this.checking ? "Checking front to back…" : "Check front to back"));
      if (this.checking) bits.push(this.lenField("Front-to-back length", d.check ? d.check.length : null, (v) => edit(() => { if (!d.check) d.check = { pts: [] }; d.check.length = v ?? undefined; }), 1, 300, "measured or known"));
    } else if (this.tool === "outline") {
      bits.push(el("span.fc-olabel", "Outside walls"), el("div.seg", { role: "radiogroup", "aria-label": "Outside walls" },
        Object.keys(EXT_WALL).map((k) => el("button", { type: "button", role: "radio", "aria-checked": String(d.ext_wall === k), on: { click: () => edit(() => { d.ext_wall = k; }) } }, `${k} (${L.fmtLen(EXT_WALL[k])})`))));
      if (this.draft) bits.push(el("button.btn.small.primary", { type: "button", disabled: this.draft.pts.length < 3 ? "" : null, on: { click: () => this.finishDraft() } }, "Finish"));
    } else if (this.tool === "yard") {
      bits.push(el("div.chips", Object.entries(YARD_LABEL).map(([k, label]) => el("button.chip", { type: "button", "aria-pressed": String(this.opts.yard === k), on: { click: () => { this.opts.yard = k; this.draft = null; this.paint(); } } }, label))));
      if (!["tree", "bush"].includes(this.opts.yard)) bits.push(el("label.check.small", el("input", { type: "checkbox", checked: this.opts.smooth, on: { change: (e) => { this.opts.smooth = e.target.checked; this.render(); } } }), "Curved"));
      if (this.draft) bits.push(el("button.btn.small.primary", { type: "button", on: { click: () => this.finishDraft() } }, "Finish"));
    } else if (["wall", "door", "room", "stairs", "across"].includes(this.tool)) {
      bits.push(el("span.fc-olabel", "Level"), this.levelChips(false));
      if (this.tool === "wall") {
        bits.push(this.buildSelect(this.opts, (k, v) => { this.opts[k] = v; this.paint(); }),
          el("label.check.small", el("input", { type: "checkbox", checked: this.opts.angled, on: { change: (e) => { this.opts.angled = e.target.checked; this.paint(); } } }), "Angled"));
        const here = d.walls.filter((w) => w.level === this.level).length + d.rooms.filter((r) => r.level === this.level).length + d.stairs.filter((t) => t.level === this.level).length;
        if (here) {
          const others = this.ctx.floors().filter((f) => f.id !== this.level);
          const pick = el("select.input", { style: { width: "auto" } }, others.map((f) => el("option", { value: f.id }, f.name)));
          bits.push(el("span", { style: { flex: "1" } }),
            el("button.btn.small", { type: "button", "aria-pressed": String(!!this.movePlan), on: { click: () => { this.movePlan = !this.movePlan; this.paint(); } } }, this.movePlan ? "Done moving" : "Move the whole plan"),
            el("span.fc-olabel", "Move this plan to"), pick,
            el("button.btn.small", { type: "button", on: { click: () => this.movePlanTo(pick.value) } }, "Move"));
        }
      }
    } else if (this.tool === "light") {
      bits.push(el("span.fc-olabel", "On"), this.levelChips(true));
    } else if (this.tool === "measure" && this.measure) {
      bits.push(el("span.fc-olabel", "Measured"), el("strong", L.fmtLen(this.measure.len)));
    }
    if (!bits.length) { const t = this.TOOLS().find((x) => x.id === this.tool); if (t) bits.push(el("span.fc-olabel", `${t.label} · ${t.key}`)); }
    L.set(this.optionsBar, ...bits);
    this.optionsBar.style.display = this.open() ? "" : "none";
  }
  buildSelect(w, set) {
    const { el } = L;
    return el("label.fc-o", el("span", "Wall"), el("select.input", { style: { width: "auto" }, on: { change: (e) => { const [studs, finish] = e.target.value.split("|"); set("studs", studs); set("finish", finish); } } },
      WALL_BUILDS.map(([studs, finish]) => el("option", { value: `${studs}|${finish}`, selected: w.studs === studs && w.finish === finish ? "" : null },
        `${studs}, ${finish} (${L.fmtLen(STUD_M[studs] + 2 * FINISH_M[finish])})`))));
  }

  paintInspector() {
    const { el } = L;
    const s = this.shape(this.sel);
    const fmt = L.fmtLen;
    const d = this.doc;
    const edit = (fn) => { const b = this.snapshot(); fn(); this.commit(b); };
    const field = (label, input) => el("label.field", el("span", label), input);
    const del = el("button.btn.small.danger", { type: "button", on: { click: () => this.remove() } }, "Delete");
    let body = null;
    if (!this.open()) body = null;
    else if (this.tool === "across") body = this.chainPanel();
    else if (this.picks.length > 1) {
      const n = (kind) => this.picks.filter((q) => q.kind === kind).length;
      const parts = [["wall", "wall"], ["room", "room"], ["stairs", "stairs"], ["yard", "yard shape"]].map(([k, w]) => (n(k) ? `${n(k)} ${w}${n(k) > 1 && k !== "stairs" ? "s" : ""}` : null)).filter(Boolean);
      body = el("div.fc-sum", el("h3", `${this.picks.length} picked`), el("span.small", parts.join(", ")),
        el("span.small.muted", "Drag any of them to move them together. Ctrl+click another to add it, or one of these to take it out."),
        this.clipRow(), el("button.btn.small.danger", { type: "button", on: { click: () => this.remove() } }, "Delete them"));
    }
    else if (!s) {
      const err = this.checkError();
      const outer = this.planOuter();
      const bb = outer ? bbox(outer) : null;
      body = el("div.fc-sum", el("h3", "From above"),
        el("dl.fc-kv",
          el("dt", "Scale"), el("dd", this.calibrated() ? `1 px = ${fmt(this.doc.xf.s)}` : "not set yet"),
          bb ? [el("dt", "House, wall to wall"), el("dd", `${fmt(bb.x1 - bb.x0)} × ${fmt(bb.y1 - bb.y0)}`)] : null,
          el("dt", "Yard shapes"), el("dd", String(d.yard.length)),
          el("dt", "Walls"), el("dd", String(d.walls.length)),
          err != null ? [el("dt", "Front to back check"), el("dd", { style: { color: Math.abs(err) > 0.03 ? "var(--warn-text, #e0a030)" : "var(--ok)" } }, `${err > 0 ? "+" : ""}${(err * 100).toFixed(1)}%`)] : null),
        err != null && Math.abs(err) > 0.03 ? el("p.small", "The two directions disagree by more than 3%. The photo may lean (most satellite photos aren't straight down), or the roofline or the length typed may be off.") : null,
        el("p.small.muted", "The outside walls are the eaves' depth inside the roof outline. They set how deep the house is on the house map."),
        this.photo ? (this.confirmClear
          ? el("div.row", { style: { gap: "8px" } }, el("button.btn.small.danger", { type: "button", on: { click: () => this.startOver() } }, "Yes, remove it all"),
            el("button.btn.small", { type: "button", on: { click: () => { this.confirmClear = false; this.paint(); } } }, "Keep it"))
          : el("button.btn.small", { type: "button", on: { click: () => this.startOver() } }, "Remove the photo and drawing")) : null);
    } else if (this.sel.kind === "yard") {
      const round = s.kind === "tree" || s.kind === "bush";
      body = el("div.fc-sum", el("h3", s.name || YARD_LABEL[s.kind]),
        field("Name", el("input.input", { value: s.name || "", placeholder: YARD_LABEL[s.kind], on: { change: (e) => edit(() => { s.name = e.target.value.slice(0, 60); }) } })),
        field("Kind", el("select", { on: { change: (e) => edit(() => { s.kind = e.target.value; }) } },
          Object.entries(YARD_LABEL).filter(([k]) => (k === "tree" || k === "bush") === round).map(([k, label]) => el("option", { value: k, selected: s.kind === k ? "" : null }, label)))),
        round ? [this.lenRow("Across", s.r * 2, (v) => edit(() => { s.r = Math.max(0.1, v / 2); })), this.lenRow("Height (to aim uplights at)", s.h, (v) => edit(() => { if (v) s.h = v; else delete s.h; }), true)]
          : el("label.check.small", el("input", { type: "checkbox", checked: !!s.smooth, on: { change: (e) => edit(() => { s.smooth = e.target.checked; }) } }), "Curved"),
        s.kind === "path" ? this.lenRow("Width", s.width ?? 1.2, (v) => edit(() => { s.width = v; })) : null,
        del);
    } else if (this.sel.kind === "wall") {
      const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const refs = this.wallRefs(s);
      const ref = this.chosenRef(s, refs);
      const dist = ref ? this.faceDistance(s, ref) : null;
      body = el("div.fc-sum", el("h3", "Wall"),
        this.buildSelect(s, (k, v) => edit(() => { s[k] = v; })),
        el("label.field", el("span", "On"), el("select", { on: { change: (e) => edit(() => { s.level = e.target.value; this.level = s.level; }) } },
          this.ctx.floors().map((f) => el("option", { value: f.id, selected: s.level === f.id ? "" : null }, f.name)))),
        el("label.check.small", el("input", { type: "checkbox", checked: !!s.angled, on: { change: (e) => edit(() => { if (e.target.checked) s.angled = true; else { delete s.angled; s.b = squareTo(s.a, s.b); } }) } }), "Angled"),
        this.lenRow("Length", len, (v) => edit(() => { const k = v / (len || 1); s.b = [round3(s.a[0] + (s.b[0] - s.a[0]) * k), round3(s.a[1] + (s.b[1] - s.a[1]) * k)]; })),
        ref ? el("div.field", el("span", "How far from"),
          el("select.input", { on: { change: (e) => { this.wallRef = { wall: s.id, ref: e.target.value }; this.paint(); } } }, refs.map((r) => el("option", { value: r.id, selected: r.id === ref.id ? "" : null }, r.label))),
          el("button.btn.small", { type: "button", "aria-pressed": String(!!this.pickRef), on: { click: () => { this.pickRef = !this.pickRef; this.paint(); } } },
            this.pickRef ? "Tap the wall on the plan…" : "Pick on the plan"),
          this.lenRow("Wall face to wall face", dist, (v) => edit(() => this.setFaceDistance(s, ref, v))),
          el("span.small.muted", "Measure from the face of one wall to the face of the other, as with a tape. The numbers match the tags on the plan; the blue one is shown with its dimension.")) : null,
        del);
    } else if (this.sel.kind === "stairs") {
      const floors = this.ctx.floors();
      const from = floors.find((f) => f.id === s.level);
      const st = stairInfo(s, floors);
      const fmt = L.fmtLen;
      body = el("div.fc-sum", el("h3", "Stairs"),
        s.level !== this.level ? el("span.small.muted", `Drawn on the ${from ? from.name : "other"} plan; they lead here, so here they go the other way. Changes here change them there.`) : null,
        el("label.field", el("span", "From"), el("span", from ? from.name : "?")),
        el("label.field", el("span", "Up or down to"), el("select", { on: { change: (e) => edit(() => { s.to = e.target.value; }) } },
          floors.filter((f) => f.id !== s.level).map((f) => el("option", { value: f.id, selected: s.to === f.id ? "" : null }, f.name)))),
        el("button.btn.small", { type: "button", on: { click: () => edit(() => { s.dir = { "x+": "x-", "x-": "x+", "y+": "y-", "y-": "y+" }[s.dir]; }) } }, "Turn round"),
        this.lenRow("Width", st.width, (v) => edit(() => setStair(s, { width: v }, floors))),
        this.lenRow("Tread depth", st.tread, (v) => edit(() => setStair(s, { tread: v }, floors))),
        this.lenRow("Step height", st.riser, (v) => edit(() => { if (v >= 0.05 && v <= 0.4) s.riser = round3(v); })),
        el("label.field", el("span", "Steps"),
          el("input.input", { type: "number", min: 1, max: 60, step: 1, value: st.steps, style: { width: "90px" },
            on: { change: (e) => { const n = Math.round(Number(e.target.value)); if (!(n >= 1 && n <= 60)) { L.toast("1 to 60 steps"); e.target.value = st.steps; return; } edit(() => setStair(s, { steps: n }, floors)); } } }),
          el("span.small.muted", "Not counting a landing or the floor at the top.")),
        el("dl.fc-kv", el("dt", "Length"), el("dd", fmt(st.run)), el("dt", "They climb"), el("dd", fmt(st.climb)),
          st.rise ? [el("dt", "Between the levels"), el("dd", fmt(st.rise))] : null),
        st.rise && Math.abs(st.climb - st.rise) > 0.0254
          ? el("div.banner", { style: { fontSize: "13px" } }, `These stairs climb ${fmt(st.climb)}, but ${from ? from.name : "the levels"} and where they lead are ${fmt(st.rise)} apart. `,
            el("button.btn.small", { type: "button", on: { click: () => edit(() => { delete s.riser; }) } }, "Fit the step height"))
          : el("span.small.muted", "Drag the white handles on the picked stairs to size them; the ends move a whole step at a time."),
        del);
    } else if (this.sel.kind === "door") {
      const w = d.walls.find((x) => x.id === s.wall);
      const len = w ? Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) : 0;
      body = el("div.fc-sum", el("h3", "Doorway"),
        this.lenRow("Width", s.width, (v) => edit(() => { s.width = Math.max(0.4, Math.min(5, v)); })),
        this.lenRow("From the end of the wall", Math.max(0, s.at - s.width / 2), (v) => edit(() => { s.at = Math.max(s.width / 2, Math.min(len - s.width / 2, v + s.width / 2)); })),
        // the wall carries on over it in 3D; an opening down a few steps can top out lower
        this.lenRow("Top of the opening, above the floor", s.top ?? null, (v) => edit(() => { if (v == null) delete s.top; else s.top = Math.max(0.5, Math.min(10, v)); }), true),
        el("span.small.muted", `Empty: a door's ${L.fmtLen(2.032)}. The wall is drawn over it up to the ceiling.`),
        del);
    } else if (this.sel.kind === "room") {
      const areas = this.ctx.areas().filter((a) => !this.level || a.floor_id === s.level || !a.floor_id);
      body = el("div.fc-sum", el("h3", s.name || "Room"),
        field("Which room in Home Assistant", el("select", { on: { change: (e) => edit(() => { s.area = e.target.value || null; const a = areas.find((x) => x.id === s.area); if (a) s.name = a.name; }) } },
          el("option", { value: "" }, "Not set"), areas.map((a) => el("option", { value: a.id, selected: s.area === a.id ? "" : null }, a.name)))),
        field("Name", el("input.input", { value: s.name || "", on: { change: (e) => edit(() => { s.name = e.target.value.slice(0, 60); }) } })),
        del);
    } else if (this.sel.kind === "light") {
      body = this.aimPanel(s);
    } else if (this.sel.kind === "outline") {
      body = el("div.fc-sum", el("h3", "Roof outline"), el("dl.fc-kv", el("dt", "Corners"), el("dd", String(s.length))),
        el("button.btn.small", { type: "button", on: { click: () => edit(() => { if (!this.squareOutline()) L.toast("It's already square, or has corners that aren't meant to be"); }) } }, "Square it up"),
        el("p.small.muted", "Drag a corner to move it; double-click an edge to add one; Alt-click a corner to take it out."), del);
    } else if (["ref", "check", "square"].includes(this.sel.kind)) {
      body = el("div.fc-sum", el("h3", { ref: "Scale line", check: "Front-to-back check", square: "Square-up line" }[this.sel.kind]),
        el("p.small.muted", "Drag its points to adjust it."), del);
    }
    // under one wall, room, stairs or yard shape (or nothing, with something copied): copy and paste
    if (body && this.open() && this.tool === "select" && this.picks.length <= 1 && ((this.sel && COPYABLE.includes(this.sel.kind)) || (!this.sel && CLIP && clipCount()))) body.append(this.clipRow());
    L.set(this.inspEl, body);
    this.inspEl.style.display = body ? "" : "none";
  }
  lenRow(label, value, set, optional) {
    const { el } = L;
    return el("label.field", el("span", label), el("input.input", { value: value == null ? "" : L.fmtLen(value), placeholder: optional ? "optional" : "", inputmode: "decimal",
      on: { change: (e) => { const t = e.target.value.trim(); if (!t && optional) return set(null); const v = L.parseLen(t); if (!Number.isFinite(v) || v < 0) { L.toast("Not a length"); return; } set(v); } } }));
  }

  // ---- aiming ------------------------------------------------------------------------------------

  aimPanel(t) {
    const { el } = L;
    const aim = { ...(t.item && t.item.aim) };
    const kind = aim.kind || "all";
    const set = (change) => this.ctx.aim(t.id, { ...BEAMS[change.kind || kind].defaults, ...aim, ...change });
    const slider = (label, key, min, max, fmt) => {
      const out = el("span.mono", fmt(aim[key]));
      return el("label.field", el("span", label, out), el("input", { type: "range", min, max, step: 1, value: aim[key] ?? 0,
        on: { input: (e) => { out.textContent = fmt(Number(e.target.value)); }, change: (e) => set({ [key]: Number(e.target.value) }) } }));
    };
    return el("div.fc-sum", el("h3", t.name),
      el("div.field", el("span", "Its light"), el("div.seg", { role: "radiogroup", "aria-label": "Its light" },
        Object.entries(BEAMS).map(([k, b]) => el("button", { type: "button", role: "radio", "aria-checked": String(kind === k),
          on: { click: () => this.ctx.aim(t.id, k === "all" ? null : { ...b.defaults, heading: aim.heading ?? 0, kind: k }) } }, b.label)))),
      kind === "all" ? el("p.small.muted", "Bulbs and ceiling lights light all around: nothing to aim.") : [
        slider("Beam width", "beam", 5, kind === "wall" ? 180 : 160, (v) => `${v}°`),
        slider("Points", "tilt", -90, 90, (v) => v >= 85 ? "straight up" : v <= -85 ? "straight down" : v === 0 ? "level" : v > 0 ? `${v}° up` : `${-v}° down`),
        el("dl.fc-kv", el("dt", "Faces"), el("dd", headingText(aim.heading ?? 0))),
        el("p.small.muted", "Drag the arrow on the view to turn it."),
      ]);
  }

  // ---- walls by measurement ----------------------------------------------------------------------

  wallThick(w) { return STUD_M[w.studs] + 2 * FINISH_M[w.finish]; }
  vertical(w) { return Math.abs(w.b[0] - w.a[0]) < Math.abs(w.b[1] - w.a[1]); }
  // What a wall can be measured from: the outside walls' inside faces, and parallel walls
  // The walls a wall can be measured from: the outside walls' inside faces and the walls on its
  // level that run the same way alongside it. Each says where it is and how far, nearest first; `n` is the
  // number on its tag on the plan.
  wallRefs(w) {
    const refs = [];
    const inner = this.planInner();
    const vert = this.vertical(w), here = this.wallPos(w);
    if (inner) {
      const bb = bbox(inner);
      if (vert) refs.push({ id: "L", name: "The left outside wall", pos: bb.x0, face: 0, span: [bb.y0, bb.y1] }, { id: "R", name: "The right outside wall", pos: bb.x1, face: 0, span: [bb.y0, bb.y1] });
      else refs.push({ id: "F", name: "The front outside wall", pos: bb.y0, face: 0, span: [bb.x0, bb.x1] }, { id: "B", name: "The back outside wall", pos: bb.y1, face: 0, span: [bb.x0, bb.x1] });
    }
    const mine = vert ? [Math.min(w.a[1], w.b[1]), Math.max(w.a[1], w.b[1])] : [Math.min(w.a[0], w.b[0]), Math.max(w.a[0], w.b[0])];
    for (const o of this.doc.walls) {
      if (o === w || o.level !== w.level || this.vertical(o) !== vert) continue;
      const pos = this.wallPos(o);
      const way = vert ? (pos < here ? "to the left" : "to the right") : (pos < here ? "toward the front" : "toward the back");
      const span = vert ? [Math.min(o.a[1], o.b[1]), Math.max(o.a[1], o.b[1])] : [Math.min(o.a[0], o.b[0]), Math.max(o.a[0], o.b[0])];
      // only walls that face it, alongside it for some of its length: a tape can't go round corners
      if (Math.min(mine[1], span[1]) - Math.max(mine[0], span[0]) < 0.05) continue;
      refs.push({ id: o.id, name: `A wall ${way}`, pos, face: this.wallThick(o) / 2, span, wall: o });
    }
    for (const r of refs) r.dist = this.faceDistance(w, r);
    refs.sort((a, b) => a.dist - b.dist);
    refs.forEach((r, i) => { r.n = i + 1; r.label = `${r.n} · ${r.name}, ${L.fmtLen(r.dist)} away`; });
    return refs;
  }
  // The wall this one is measured from: the one chosen for it, else the nearest
  chosenRef(w, refs) {
    const c = this.wallRef && this.wallRef.wall === w.id ? refs.find((r) => r.id === this.wallRef.ref) : null;
    return c || refs[0];
  }
  wallPos(w) { return this.vertical(w) ? (w.a[0] + w.b[0]) / 2 : (w.a[1] + w.b[1]) / 2; }
  faceDistance(w, ref) {
    const gap = Math.abs(this.wallPos(w) - ref.pos);
    return Math.max(0, gap - this.wallThick(w) / 2 - ref.face);
  }
  setFaceDistance(w, ref, v) {
    const side = Math.sign(this.wallPos(w) - ref.pos) || 1;
    const target = ref.pos + side * (v + this.wallThick(w) / 2 + ref.face);
    const delta = target - this.wallPos(w);
    if (this.vertical(w)) { w.a[0] = round3(w.a[0] + delta); w.b[0] = round3(w.b[0] + delta); }
    else { w.a[1] = round3(w.a[1] + delta); w.b[1] = round3(w.b[1] + delta); }
  }

  // What's picked: several (Ctrl+click), else the one
  picked() { return this.picks.length > 1 ? [...this.picks] : this.sel ? [this.sel] : []; }
  remove() {
    if (this.picks.length > 1) {
      const b = this.snapshot(), d = this.doc;
      for (const q of this.picks) {
        const key = LISTS[q.kind];
        if (key) d[key] = d[key].filter((x) => x.id !== q.id);
        if (q.kind === "wall") d.doors = d.doors.filter((x) => x.wall !== q.id);
      }
      this.picks = []; this.sel = null;
      this.commit(b);
      return;
    }
    if (!this.sel) return;
    const b = this.snapshot(), k = this.sel.kind, d = this.doc;
    if (k === "light") return;
    if (k === "outline") d.outline = null;
    else if (k === "square") { d.square = null; d.xf = null; }
    else if (k === "ref") { d.ref = null; d.xf = null; }
    else if (k === "check") d.check = null;
    else {
      const key = { yard: "yard", wall: "walls", door: "doors", room: "rooms", stairs: "stairs" }[k];
      d[key] = d[key].filter((x) => x.id !== this.sel.id);
      if (k === "wall") d.doors = d.doors.filter((x) => x.wall !== this.sel.id);
    }
    this.sel = null;
    this.commit(b);
  }

  // ---- drawing -----------------------------------------------------------------------------------

  render() {
    const c = this.canvas, ctx = this.c2d;
    if (!this.doc || !this.open()) return;
    const dpr = window.devicePixelRatio || 1;
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    if (!this.view.fitted) this.fit();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = colors();
    ctx.fillStyle = col.field; ctx.fillRect(0, 0, W, H);
    this.drawGrid(ctx, W, H);
    if (this.img) {
      const xf = this.xf(), k = this.view.k;
      // photo px -> screen: house = s R [u, -v] + t; screen = (vx + k x, vy - k y)
      const cs = Math.cos(xf.theta) * xf.s * k, sn = Math.sin(xf.theta) * xf.s * k;
      ctx.save();
      ctx.setTransform(dpr * cs, dpr * -sn, dpr * sn, dpr * cs, dpr * (this.view.x + k * xf.tx), dpr * (this.view.y - k * xf.ty));
      ctx.globalAlpha = this.tool === "wall" || this.tool === "door" || this.tool === "room" ? 0.45 : 0.9;
      ctx.drawImage(this.img, 0, 0);
      ctx.restore();
    }
    this.drawShapes(ctx, col);
  }
  drawGrid(ctx, W, H) {
    const unit = L.units() === "imperial" ? L.FT : 1;
    const step = unit * (this.view.k * unit < 6 ? 10 : this.view.k * unit < 14 ? 5 : 1);
    const [x0, y1] = this.s2h({ x: 0, y: 0 }), [x1, y0] = this.s2h({ x: W, y: H });
    ctx.lineWidth = 1;
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { const a = this.h2s(x, 0); ctx.strokeStyle = "rgba(128,140,160,0.12)"; ctx.beginPath(); ctx.moveTo(a.x, 0); ctx.lineTo(a.x, H); ctx.stroke(); }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { const a = this.h2s(0, y); ctx.strokeStyle = "rgba(128,140,160,0.12)"; ctx.beginPath(); ctx.moveTo(0, a.y); ctx.lineTo(W, a.y); ctx.stroke(); }
  }
  hpath(ctx, pts, close = true, smooth = false, more = false) {
    const q = pts.map(([x, y]) => this.h2s(x, y));
    if (smooth && q.length > 2 && !more) { smoothPath(ctx, q, close); return; }
    if (!more) ctx.beginPath();
    q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (close) ctx.closePath();
  }
  handles(ctx, pts, color) {
    for (const [x, y] of pts) { const p = this.h2s(x, y); ctx.beginPath(); ctx.rect(p.x - 6, p.y - 6, 12, 12); ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke(); }
  }

  drawShapes(ctx, col) {
    const d = this.doc;
    const isSel = (kind, id) => (this.sel && this.sel.kind === kind && (id === undefined || this.sel.id === id)) || this.picks.some((q) => q.kind === kind && q.id === id);
    const house = this.ctx.house();
    // the street side
    ctx.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillStyle = "rgba(200,210,220,0.6)"; ctx.textAlign = "center";
    ctx.fillText("↓ STREET SIDE ↓", this.stage.clientWidth / 2, this.stage.clientHeight - 10);
    // yard
    for (const y of d.yard) {
      const sel = isSel("yard", y.id), c = YARD_COLOR[y.kind];
      if (y.c) {
        const p = this.h2s(y.c[0], y.c[1]), r = y.r * this.view.k;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = hexA(c, sel ? 0.5 : 0.32); ctx.fill();
        ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = c; ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
        if (sel) this.handles(ctx, [[y.c[0] + y.r, y.c[1]]], c);
      } else if (y.kind === "path") {
        // every line in one stroke, so where merged ones cross it isn't drawn twice
        if (!y.parts) this.hpath(ctx, y.pts, false, y.smooth);
        else { ctx.beginPath(); for (const line of yardPieces(y)) this.hpath(ctx, line, false, false, true); }
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(3, (y.width ?? 1.2) * this.view.k); ctx.strokeStyle = hexA(c, sel ? 0.75 : 0.55); ctx.stroke();
        ctx.lineCap = "butt";
        if (sel) this.handles(ctx, y.pts, c);
      } else {
        if (!y.parts) { this.hpath(ctx, y.pts, true, y.smooth); ctx.fillStyle = hexA(c, sel ? 0.5 : 0.32); ctx.fill(); ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = c; ctx.stroke(); }
        else drawUnion(ctx, yardPieces(y).map((q) => q.map(([a, b]) => this.h2s(a, b))), hexA(c, sel ? 0.5 : 0.32), c, sel ? 2.5 : 1.5);
        if (sel) this.handles(ctx, y.pts, c);
      }
      if (y.name) { const at = y.c || centroid(y.pts); const p = this.h2s(at[0], at[1]); label(ctx, y.name, p.x, p.y - 6, "#fff", col, "center"); }
    }
    // the house: blocks from the front photo, faint, then the roof outline and the walls
    const m = house.massing;
    if (m) for (const b of m.blocks) {
      this.hpath(ctx, [[b.x0, b.y0 || 0], [b.x1, b.y0 || 0], [b.x1, (b.y0 || 0) + b.depth], [b.x0, (b.y0 || 0) + b.depth]]);
      ctx.setLineDash([3, 4]); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(90,169,230,0.6)"; ctx.stroke(); ctx.setLineDash([]);
    }
    if (d.outline) {
      const sel = isSel("outline");
      this.hpath(ctx, d.outline); ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = "#c58cf0"; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      const outer = this.planOuter(), inner = this.planInner();
      if (outer && inner) {
        // the outside walls, as a solid band
        ctx.beginPath();
        for (const poly of [outer, inner]) poly.forEach(([x, y], i) => { const p = this.h2s(x, y); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
        ctx.fillStyle = "rgba(220,226,234,0.85)"; ctx.fill("evenodd");
      }
      if (sel || this.tool === "outline") this.handles(ctx, d.outline, "#c58cf0");
    }
    // the floor plan of the level shown
    const showPlan = ["wall", "door", "room", "stairs", "select", "light", "aim", "across"].includes(this.tool);
    if (showPlan) {
      for (const w of d.walls) {
        if (w.level !== this.level) continue;
        const sel = isSel("wall", w.id);
        const a = this.h2s(w.a[0], w.a[1]), b = this.h2s(w.b[0], w.b[1]);
        // square ends: a corner fills in, and an end on another wall sits inside it
        ctx.lineCap = "square"; ctx.lineWidth = Math.max(3, this.wallThick(w) * this.view.k);
        ctx.strokeStyle = sel ? "#ff8a3d" : "rgba(220,226,234,0.9)";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.lineCap = "butt";
        // doorways: gaps
        for (const dr of d.doors.filter((x) => x.wall === w.id)) {
          const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
          const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
          const p0 = this.h2s(w.a[0] + ux * (dr.at - dr.width / 2), w.a[1] + uy * (dr.at - dr.width / 2));
          const p1 = this.h2s(w.a[0] + ux * (dr.at + dr.width / 2), w.a[1] + uy * (dr.at + dr.width / 2));
          ctx.strokeStyle = isSel("door", dr.id) ? "#ff8a3d" : col.field; ctx.lineWidth = Math.max(3, this.wallThick(w) * this.view.k) + 2;
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
        if (sel) this.handles(ctx, [w.a, w.b], "#ff8a3d");
      }
      for (const t of d.stairs) {
        if (t.level === this.level) this.drawStairs(ctx, t, isSel("stairs", t.id), col);
        // stairs from another level that lead here: the same stairs, the other way
        else if (t.to === this.level) this.drawStairs(ctx, stairsSeenFrom(t), isSel("stairs", t.id), col);
      }
      if (this.sel && this.sel.kind === "wall" && this.tool !== "across" && this.picks.length <= 1) this.drawWallDims(ctx, col);
      if (this.tool === "across") this.drawChain(ctx, col);
      for (const r of d.rooms) {
        if (r.level !== this.level) continue;
        const p = this.h2s(r.at[0], r.at[1]);
        label(ctx, r.name || "Room", p.x, p.y, isSel("room", r.id) ? "#ff8a3d" : "#fff", col, "center");
      }
    }
    // lights: on the level shown, and outside
    const s = this.ctx.selection();
    for (const t of house.targets) {
      if (!t.world || !t.item) continue;
      const here = t.item.floor === "_outside" || t.item.floor === this.level || !showPlan;
      const sel = (s.target && s.target.id === t.id) || isSel("light", t.id);
      const p = this.h2s(t.world.x, t.world.y);
      if (t.item.aim && (here || sel)) this.drawBeam(ctx, t, sel);
      ctx.globalAlpha = here || sel ? 1 : 0.25;
      ctx.beginPath(); ctx.arc(p.x, p.y, sel ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = sel ? "#ff8a3d" : t.state === "on" ? "#f5c25a" : "#cfd6de"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#111"; ctx.stroke();
      ctx.globalAlpha = 1;
      if (sel) label(ctx, t.name, p.x, p.y - 12, "#fff", col, "center");
      if (t.fixtures > 0) {
        // several fixtures on one switch: each a dot, joined by a dashed line
        const q = t.parts.filter((pt) => pt.world).map((pt) => this.h2s(pt.world.x, pt.world.y));
        ctx.save(); ctx.globalAlpha = here || sel ? 1 : 0.3; ctx.setLineDash([6, 5]); ctx.strokeStyle = sel ? "#ff8a3d" : "#d9a441"; ctx.lineWidth = 1.5;
        ctx.beginPath(); q.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.stroke(); ctx.setLineDash([]);
        for (const pt of q) { ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2); ctx.fillStyle = sel ? "#ff8a3d" : t.state === "on" ? "#f5c25a" : "#cfd6de"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#111"; ctx.stroke(); }
        ctx.restore();
      } else for (const part of t.parts) if (part.world) { const q = this.h2s(part.world.x, part.world.y); ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fillStyle = "#9ad0f5"; ctx.fill(); }
    }
    // calibration lines
    if (d.square && (this.tool === "square" || isSel("square"))) this.photoLine(ctx, [d.square.a, d.square.b], "#ffd166", "Square");
    if (d.ref && (this.tool === "ref" || isSel("ref"))) this.photoLine(ctx, d.ref.pts, "#ff5d6c", "Roof edge");
    if (d.check && d.check.pts.length && (this.tool === "ref" || isSel("check"))) this.photoLine(ctx, d.check.pts, "#7bc47f", "Front to back");
    // what's being drawn
    const dr = this.draft;
    if (dr && dr.pts.length) {
      const color = dr.kind === "ref" ? "#ff5d6c" : dr.kind === "check" ? "#7bc47f" : dr.kind === "outline" ? "#c58cf0" : YARD_COLOR[dr.kind] || "#fff";
      const pts = dr.photo ? dr.pts.map(([u, v]) => this.p2h(u, v)) : dr.pts;
      const hov = this.hover ? this.s2h(this.hover) : null;
      this.hpath(ctx, hov ? [...pts, hov] : pts, false, this.opts.smooth && dr.kind !== "ref" && dr.kind !== "check");
      ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
      this.handles(ctx, pts, color);
    }
    if (this.drag && this.drag.kind === "wallDraw" && this.drag.b) {
      const a0 = this.drag.a2 || this.drag.a;
      const a = this.h2s(a0[0], a0[1]), b = this.h2s(this.drag.b[0], this.drag.b[1]);
      ctx.lineWidth = Math.max(3, (STUD_M[this.opts.studs] + 2 * FINISH_M[this.opts.finish]) * this.view.k); ctx.strokeStyle = "#ff8a3d";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      label(ctx, L.fmtLen(Math.hypot(this.drag.b[0] - a0[0], this.drag.b[1] - a0[1])), (a.x + b.x) / 2, (a.y + b.y) / 2 - 10, "#fff", col, "center");
    }
    if (this.snapMark && this.drag && (this.drag.kind === "wallDraw" || this.drag.kind === "handle" || (this.drag.kind === "moveShape" && this.drag.hit.kind === "wall"))) {
      const q = this.h2s(...this.snapMark);
      ctx.strokeStyle = "#7bc47f"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2); ctx.stroke();
    }
    if (this.drag && this.drag.kind === "stairDraw" && this.drag.b) {
      const st = this.stairFrom(this.drag.a, this.drag.b);
      if (st) this.drawStairs(ctx, st, true, col);
    }
    if (this.drag && this.drag.kind === "circle" && this.drag.r) {
      const p = this.h2s(this.drag.c[0], this.drag.c[1]);
      ctx.beginPath(); ctx.arc(p.x, p.y, this.drag.r * this.view.k, 0, Math.PI * 2); ctx.strokeStyle = YARD_COLOR[this.opts.yard]; ctx.lineWidth = 2; ctx.stroke();
    }
    if (this.drag && this.drag.kind === "squareDraw" && this.drag.b) {
      const a = this.drag.start, b = this.drag.cur;
      ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    if (this.measure) {
      const a = this.h2s(...this.measure.a), b = this.h2s(...this.measure.b);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      label(ctx, L.fmtLen(this.measure.len), (a.x + b.x) / 2, (a.y + b.y) / 2 - 10, "#fff", col, "center");
    }
    this.scaleBar(ctx);
  }
  // ---- Measure across: tape measurements across a level, face to face ---------------------------
  // A chain is walls tapped in order straight across the plan (all running the same way):
  // items are {out: "L"|"R"|"F"|"B"} (an outside wall's inside face) or {id} (a wall on the plan);
  // gaps[i] is the tape measurement from item i's face to item i+1's face.
  chainPos(it) {
    if (it.out) { const bb = bbox(this.planInner()); return { L: bb.x0, R: bb.x1, F: bb.y0, B: bb.y1 }[it.out]; }
    const w = this.doc.walls.find((q) => q.id === it.id);
    return w ? this.wallPos(w) : null;
  }
  chainHalf(it) { if (it.out) return 0; const w = this.doc.walls.find((q) => q.id === it.id); return w ? this.wallThick(w) / 2 : 0; }
  chainName(it) {
    if (it.out) return { L: "The left outside wall", R: "The right outside wall", F: "The front outside wall", B: "The back outside wall" }[it.out];
    return "A wall";
  }
  // What the plan has now between each pair, face to face, and across the whole chain
  chainNow() {
    const c = this.chain, pos = c.items.map((it) => this.chainPos(it)), half = c.items.map((it) => this.chainHalf(it));
    const gaps = pos.slice(1).map((v, i) => Math.abs(v - pos[i]) - half[i] - half[i + 1]);
    const n = pos.length;
    const span = n > 1 ? Math.abs(pos[n - 1] - pos[0]) - half[0] - half[n - 1] : 0;
    return { pos, half, gaps, span };
  }
  chainTap([x, y]) {
    const tol = 10 / this.view.k;
    if (!this.chain) this.chain = { items: [], gaps: [], axis: null, along: null };
    const c = this.chain;
    const last = c.items[c.items.length - 1];
    if (last && last.out && c.items.length > 1) { L.toast("That's the far wall. Clear the chain to start again."); return; }
    // what was tapped: a wall on this level, else an outside wall's inside face
    let it = null, axis = null;
    const w = this.doc.walls.filter((q) => q.level === this.level).find((q) => segDist([x, y], q.a, q.b) <= this.wallThick(q) / 2 + tol);
    if (w) { it = { id: w.id }; axis = this.vertical(w) ? "x" : "y"; }
    else {
      const inner = this.planInner();
      if (inner) {
        const bb = bbox(inner);
        const near = [["L", "x", Math.abs(x - bb.x0)], ["R", "x", Math.abs(x - bb.x1)], ["F", "y", Math.abs(y - bb.y0)], ["B", "y", Math.abs(y - bb.y1)]]
          .filter(([, , dd]) => dd <= tol + 0.1).sort((a, b) => a[2] - b[2])[0];
        if (near) { it = { out: near[0] }; axis = near[1]; }
      }
    }
    if (!it) { L.toast("Tap a wall, or the inside of an outside wall"); return; }
    if (c.axis && axis !== c.axis) { L.toast(c.axis === "y" ? "Pick walls that run across the house: the chain goes front to back" : "Pick walls that run front to back: the chain goes across"); return; }
    if (c.items.some((q) => (q.id && q.id === it.id) || (q.out && q.out === it.out))) { L.toast("That wall is in the chain already"); return; }
    // in order: each one further the same way
    if (c.items.length >= 2) {
      const pos = c.items.map((q) => this.chainPos(q)), dir = Math.sign(pos[1] - pos[0]), v = this.chainPos(it);
      if (Math.sign(v - pos[pos.length - 1]) !== dir) { L.toast("Tap them in order, straight across"); return; }
    }
    if (!c.items.length) { c.axis = axis; c.along = axis === "x" ? y : x; }
    if (c.items.length) c.gaps.push(null);
    c.items.push(it);
    this.paint();
  }
  chainPanel() {
    const { el } = L;
    const fmt = L.fmtLen;
    const c = this.chain;
    const intro = el("p.small.muted", { style: { margin: 0 } }, "For tape measurements across a level: from the inside face of an outside wall, across each room and hall, to the inside face of the far wall. Tap the walls in that order on the plan, then type each measurement here. Walls in between are taken as their build (2x4 with drywall unless you set one).");
    if (!c || c.items.length < 2) return el("div.fc-sum", el("h3", "Measure across"), intro,
      c && c.items.length ? el("span.small", `1 · ${this.chainName(c.items[0])}: now tap the next wall.`) : null);
    const now = this.chainNow();
    const rows = [];
    c.items.forEach((it, i) => {
      rows.push(el("div.small", { style: { fontWeight: "600" } }, `${i + 1} · ${this.chainName(it)}`));
      if (i < c.gaps.length) {
        rows.push(this.lenRow(`Face to face, ${i + 1} to ${i + 2}`, c.gaps[i], (v) => { c.gaps[i] = v; this.paint(); }),
          el("span.small.muted", `On the plan now: ${fmt(Math.max(0, now.gaps[i]))}`));
      }
    });
    const typed = c.gaps.every((g) => g > 0);
    const inner = c.items.slice(1, -1).reduce((a, it) => a + 2 * this.chainHalf(it), 0);
    const measured = typed ? c.gaps.reduce((a, g) => a + g, 0) + inner : null;
    const ends = c.items[0].out && c.items[c.items.length - 1].out;
    const off = measured != null ? measured - now.span : null;
    const bits = [];
    if (measured != null) {
      bits.push(el("dl.fc-kv", el("dt", "Your measurements"), el("dd", fmt(measured)), el("dt", "On the plan"), el("dd", fmt(now.span)),
        el("dt", "Off by"), el("dd", Math.abs(off) < 0.0127 ? "they match" : `${off >= 0 ? "+" : "−"}${fmt(Math.abs(off))}`)));
      const scale = ends ? this.chainScale(measured, now.span) : null;
      if (scale && Math.abs(off) > 0.0254) {
        bits.push(el("p.small", { style: { margin: 0 } }, `The tape says the inside is ${fmt(measured)} ${c.axis === "y" ? "front to back" : "across"}. Rescaling the top view to fit makes the house ${fmt(scale.after)} ${c.axis === "y" ? "deep" : "wide"} outside (now ${fmt(scale.before)}), and the roofline ${fmt(scale.roofline)}${scale.front ? ` (the front photo says ${fmt(scale.front)})` : ""}.`),
          el("button.btn.small.primary", { type: "button", on: { click: () => this.chainPlace(true) } }, "Rescale to fit, then place the walls"),
          el("button.btn.small", { type: "button", on: { click: () => this.chainPlace(false) } }, "Place the walls, keep the scale"));
      } else bits.push(el("button.btn.small.primary", { type: "button", on: { click: () => this.chainPlace(false) } }, "Place the walls"),
        ends || Math.abs(off) <= 0.0254 ? null : el("span.small.muted", "The last gap takes up the difference: the far wall stays where it is."));
    }
    return el("div.fc-sum", el("h3", "Measure across"), ...rows, ...bits,
      el("button.btn.small", { type: "button", on: { click: () => { this.chain = null; this.paint(); } } }, "Clear and start again"));
  }
  // What rescaling the photo would do: the roof outline traced on it scales; the outside walls
  // are the eaves' depth in from it, and their inside face their thickness in from that
  chainScale(measured, span) {
    const ext = (EXT_WALL[this.doc.ext_wall] || EXT_WALL["2x6"]) + this.eave();
    const f = (measured + 2 * ext) / (span + 2 * ext);
    const outer = this.planOuter(), bb = outer ? bbox(outer) : null;
    const front = this.frontRoofline();
    const ref = this.doc.ref, length = ref && (ref.length || (front && front.w));
    if (!bb || !length || !(f > 0.5 && f < 2)) return null;
    const before = this.chain.axis === "y" ? bb.y1 - bb.y0 : bb.x1 - bb.x0;
    const eave = this.eave();
    return { f, before, after: (before + 2 * eave) * f - 2 * eave, roofline: length * f, front: front && front.w, length };
  }
  // Place the chain's walls at the typed distances from the first one (after rescaling the photo,
  // when asked). Walls ending on a moved wall move their ends with it, so rooms stay closed.
  chainPlace(rescale) {
    const c = this.chain, d = this.doc;
    const before = this.snapshot();
    if (rescale) {
      const now = this.chainNow();
      const inner = c.items.slice(1, -1).reduce((a, it) => a + 2 * this.chainHalf(it), 0);
      const sc = this.chainScale(c.gaps.reduce((a, g) => a + g, 0) + inner, now.span);
      if (!sc) return;
      const old = d.xf;
      d.ref.length = round3(sc.length * sc.f);
      this.place();
      // the plan's walls, rooms and stairs keep their places on the photo, as the outline does
      const mv = ([x, y]) => { const [u, v] = this.h2p(x, y, old); return this.p2h(u, v, d.xf).map(round3); };
      for (const w of d.walls) { w.a = mv(w.a); w.b = mv(w.b); }
      for (const r of d.rooms) r.at = mv(r.at);
      for (const t of d.stairs) { const [a, b] = [mv([t.x0, t.y0]), mv([t.x1, t.y1])]; t.x0 = Math.min(a[0], b[0]); t.x1 = Math.max(a[0], b[0]); t.y0 = Math.min(a[1], b[1]); t.y1 = Math.max(a[1], b[1]); }
    }
    const i0 = c.axis === "x" ? 0 : 1, i1 = 1 - i0;
    const pos = c.items.map((it) => this.chainPos(it));
    const dir = Math.sign(pos[pos.length - 1] - pos[0]) || 1;
    let face = pos[0] + dir * this.chainHalf(c.items[0]);
    for (let i = 1; i < c.items.length; i++) {
      const it = c.items[i];
      if (it.out) break; // the far outside wall stays put
      const w = d.walls.find((q) => q.id === it.id);
      const h = this.wallThick(w) / 2, old = this.wallPos(w), want = round3(face + dir * (c.gaps[i - 1] + h));
      const lo = Math.min(w.a[i1], w.b[i1]) - 0.05, hi = Math.max(w.a[i1], w.b[i1]) + 0.05;
      // ends of other walls that met this one
      for (const o of d.walls) {
        if (o === w || o.level !== w.level) continue;
        for (const e of [o.a, o.b]) if (Math.abs(e[i0] - old) < 0.03 && e[i1] >= lo && e[i1] <= hi) e[i0] = want;
      }
      w.a[i0] = want; w.b[i0] = want;
      face = want + dir * h;
    }
    this.chain = { ...c, gaps: [...c.gaps] };
    this.commit(before);
    L.toast(rescale ? "Rescaled, and the walls are where you measured them" : "The walls are where you measured them");
  }
  drawChain(ctx, col) {
    const c = this.chain;
    if (!c || !c.items.length || !this.planInner()) return;
    const P = (pos, along) => (c.axis === "x" ? this.h2s(pos, along) : this.h2s(along, pos));
    const now = this.chainNow();
    const dir = c.items.length > 1 ? Math.sign(now.pos[1] - now.pos[0]) || 1 : 1;
    ctx.save();
    for (let i = 0; i + 1 < c.items.length; i++) {
      const f0 = now.pos[i] + dir * now.half[i], f1 = now.pos[i + 1] - dir * now.half[i + 1];
      const a = P(f0, c.along), b = P(f1, c.along);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      for (const q of [a, b]) {
        ctx.beginPath(); ctx.moveTo(q.x - 6 * (ux + uy), q.y - 6 * (uy - ux)); ctx.lineTo(q.x + 6 * (ux + uy), q.y + 6 * (uy - ux)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(q.x - 9 * uy, q.y + 9 * ux); ctx.lineTo(q.x + 9 * uy, q.y - 9 * ux); ctx.stroke();
      }
      const typed = c.gaps[i];
      label(ctx, typed ? `${L.fmtLen(typed)} (now ${L.fmtLen(Math.max(0, now.gaps[i]))})` : L.fmtLen(Math.max(0, now.gaps[i])), (a.x + b.x) / 2, (a.y + b.y) / 2 - 8, typed ? "#5aa9e6" : "#ffffff", col, "center");
    }
    c.items.forEach((it, i) => {
      const q = P(now.pos[i], c.along);
      ctx.beginPath(); ctx.arc(q.x, q.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = "#5aa9e6"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
      ctx.fillStyle = "#ffffff"; ctx.font = "600 11px 'IBM Plex Sans', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), q.x, q.y + 0.5);
      ctx.textBaseline = "alphabetic";
    });
    ctx.restore();
  }
  // The picked wall's measuring: a numbered tag on each wall it can be measured from, the chosen
  // one in blue, and a dimension line between the two faces, as on a blueprint
  drawWallDims(ctx, col) {
    const w = this.shape(this.sel);
    if (!w || w.level !== this.level) return;
    const refs = this.wallRefs(w);
    if (!refs.length) return;
    const ref = this.chosenRef(w, refs);
    const vert = this.vertical(w);
    const BLUE = "#5aa9e6";
    const P = (pos, along) => (vert ? this.h2s(pos, along) : this.h2s(along, pos));
    const wSpan = vert ? [Math.min(w.a[1], w.b[1]), Math.max(w.a[1], w.b[1])] : [Math.min(w.a[0], w.b[0]), Math.max(w.a[0], w.b[0])];
    // where the dimension runs: the middle of where the two walls overlap, else of the picked wall
    const at = (r) => { const lo = Math.max(wSpan[0], r.span[0]), hi = Math.min(wSpan[1], r.span[1]); return lo < hi ? (lo + hi) / 2 : (wSpan[0] + wSpan[1]) / 2; };
    // the chosen wall, in blue
    ctx.save();
    ctx.strokeStyle = BLUE; ctx.globalAlpha = 0.9;
    if (ref.wall) {
      const a = this.h2s(ref.wall.a[0], ref.wall.a[1]), b = this.h2s(ref.wall.b[0], ref.wall.b[1]);
      ctx.lineCap = "square"; ctx.lineWidth = Math.max(3, this.wallThick(ref.wall) * this.view.k);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else {
      const a = P(ref.pos, ref.span[0]), b = P(ref.pos, ref.span[1]);
      ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
    // the dimension: face to face, with ticks at the faces and the length over the middle
    const along = at(ref), side = Math.sign(ref.pos - this.wallPos(w)) || 1;
    const f0 = this.wallPos(w) + side * this.wallThick(w) / 2, f1 = ref.pos - side * ref.face;
    const a = P(f0, along), b = P(f1, along);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    ctx.save();
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (const q of [a, b]) {
      // a blueprint tick: a short slash across the line, and a stop along the face
      ctx.beginPath(); ctx.moveTo(q.x - 6 * (ux + uy), q.y - 6 * (uy - ux)); ctx.lineTo(q.x + 6 * (ux + uy), q.y + 6 * (uy - ux)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(q.x - 9 * uy, q.y + 9 * ux); ctx.lineTo(q.x + 9 * uy, q.y - 9 * ux); ctx.stroke();
    }
    ctx.restore();
    label(ctx, L.fmtLen(Math.max(0, Math.abs(f1 - f0))), (a.x + b.x) / 2, (a.y + b.y) / 2 - 8, "#ffffff", col, "center");
    // numbered tags on every wall it can be measured from
    for (const r of refs) {
      // a fifth of the way along it, clear of the dimension line in the middle
      const lo = Math.max(wSpan[0], r.span[0]), hi = Math.min(wSpan[1], r.span[1]);
      const q = r.wall ? this.h2s(r.wall.a[0] + (r.wall.b[0] - r.wall.a[0]) * 0.2, r.wall.a[1] + (r.wall.b[1] - r.wall.a[1]) * 0.2)
        : P(r.pos, lo < hi ? lo + (hi - lo) * 0.2 : r.span[0] + (r.span[1] - r.span[0]) * 0.2);
      const on = r === ref;
      ctx.beginPath(); ctx.arc(q.x, q.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = on ? BLUE : "#1b2027"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = on ? "#ffffff" : BLUE; ctx.stroke();
      ctx.fillStyle = "#ffffff"; ctx.font = "600 11px 'IBM Plex Sans', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(r.n), q.x, q.y + 0.5);
      ctx.textBaseline = "alphabetic";
    }
  }
  // Stairs from above: the treads, and an arrow up (or down) the way they go
  drawStairs(ctx, t, sel, col) {
    const color = sel ? "#ff8a3d" : "rgba(240,180,41,0.9)";
    this.hpath(ctx, [[t.x0, t.y0], [t.x1, t.y0], [t.x1, t.y1], [t.x0, t.y1]]);
    ctx.fillStyle = hexA("#f0b429", sel ? 0.25 : 0.12); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
    const along = t.dir[0], sign = t.dir[1] === "+" ? 1 : -1;
    const lo = along === "x" ? t.x0 : t.y0, hi = along === "x" ? t.x1 : t.y1;
    ctx.lineWidth = 1;
    const info = stairInfo(t, this.ctx.floors());
    for (let k = 1; k < info.steps; k++) {
      const v = lo + k * info.tread;
      const a = along === "x" ? this.h2s(v, t.y0) : this.h2s(t.x0, v), b = along === "x" ? this.h2s(v, t.y1) : this.h2s(t.x1, v);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    const mid = along === "x" ? (t.y0 + t.y1) / 2 : (t.x0 + t.x1) / 2;
    const from = sign > 0 ? lo + 0.2 : hi - 0.2, to = sign > 0 ? hi - 0.2 : lo + 0.2;
    const a = along === "x" ? this.h2s(from, mid) : this.h2s(mid, from), b = along === "x" ? this.h2s(to, mid) : this.h2s(mid, to);
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - 10 * Math.cos(ang - 0.5), b.y - 10 * Math.sin(ang - 0.5)); ctx.lineTo(b.x - 10 * Math.cos(ang + 0.5), b.y - 10 * Math.sin(ang + 0.5)); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
    const floors = this.ctx.floors(), f0 = floors.find((f) => f.id === t.level), f1 = floors.find((f) => f.id === t.to);
    if (f1) label(ctx, `${f0 && f1.elevation < f0.elevation ? "DOWN" : "UP"} to ${f1.name}`, a.x, a.y - 8, color, col, "center");
    if (sel && t.id) this.handles(ctx, stairEdges(t).map((e) => e.at), color);
  }
  // A stair rectangle from a drag: the way they go is along the drag's longer side
  stairFrom(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.abs(dx) < 0.3 || Math.abs(dy) < 0.3) return null;
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "x+" : "x-") : (dy > 0 ? "y+" : "y-");
    const floors = this.ctx.floors().slice().sort((p, q) => p.elevation - q.elevation);
    const i = floors.findIndex((f) => f.id === this.level);
    const to = (floors[i + 1] || floors[i - 1] || {}).id;
    return { level: this.level, to, dir, x0: round3(Math.min(a[0], b[0])), x1: round3(Math.max(a[0], b[0])), y0: round3(Math.min(a[1], b[1])), y1: round3(Math.max(a[1], b[1])) };
  }

  // Move every wall, room and stairs of the level shown to another level
  movePlanTo(level) {
    if (!level) return;
    const b = this.snapshot();
    for (const list of [this.doc.walls, this.doc.rooms, this.doc.stairs]) for (const x of list) if (x.level === this.level) x.level = level;
    // stairs that would now lead to their own level lead to the next one instead
    const floors = this.ctx.floors().slice().sort((p, q) => p.elevation - q.elevation);
    const i = floors.findIndex((f) => f.id === level);
    for (const t of this.doc.stairs) if (t.level === level && t.to === level) t.to = (floors[i + 1] || floors[i - 1] || {}).id || null;
    const name = (this.ctx.floors().find((f) => f.id === level) || {}).name;
    this.level = level;
    this.commit(b);
    L.toast(`Moved to ${name}`);
  }

  photoLine(ctx, pts, color, name) {
    const h = pts.map(([u, v]) => this.p2h(u, v));
    this.hpath(ctx, h, false); ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
    this.handles(ctx, h, color);
    const p = this.h2s(h[0][0], h[0][1]);
    label(ctx, name, p.x + 8, p.y - 8, color, colors());
  }
  // A light's beam from above: a wedge for its width, an arrow for where it points
  drawBeam(ctx, t, sel) {
    const a = t.item.aim, p = this.h2s(t.world.x, t.world.y);
    const len = (sel ? 3 : 2) * this.view.k * Math.max(0.25, Math.cos((a.tilt || 0) * Math.PI / 180));
    const up = Math.abs(a.tilt || 0) >= 80;
    ctx.fillStyle = sel ? "rgba(255,180,80,0.28)" : "rgba(245,194,90,0.18)";
    if (up) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.2 * this.view.k * Math.tan(Math.min(80, a.beam / 2) * Math.PI / 180) + 6, 0, Math.PI * 2); ctx.fill();
      if (sel) this.aimHandles = null;
      return;
    }
    const hd = headingVec(a.heading || 0);
    const ang = Math.atan2(-hd[1], hd[0]); // screen angle (y down)
    const half = Math.min(179, a.beam) / 2 * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.arc(p.x, p.y, len, ang - half, ang + half); ctx.closePath(); ctx.fill();
    if (a.at) {
      const q = this.h2s(a.at.x, a.at.y);
      ctx.save(); ctx.strokeStyle = sel ? "#ff8a3d" : "rgba(245,194,90,0.7)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(q.x - 10, q.y); ctx.lineTo(q.x + 10, q.y); ctx.moveTo(q.x, q.y - 10); ctx.lineTo(q.x, q.y + 10); ctx.stroke();
      ctx.restore();
    }
    if (sel) {
      const tip = { x: p.x + Math.cos(ang) * len, y: p.y + Math.sin(ang) * len };
      ctx.strokeStyle = "#ff8a3d"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      // the arrow head (drag it to turn), and the beam's edge (drag it to widen)
      ctx.beginPath(); ctx.arc(tip.x, tip.y, 8, 0, Math.PI * 2); ctx.fillStyle = "#ff8a3d"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
      const edge = { x: p.x + Math.cos(ang + half) * len, y: p.y + Math.sin(ang + half) * len };
      ctx.beginPath(); ctx.rect(edge.x - 5, edge.y - 5, 10, 10); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#ff8a3d"; ctx.stroke();
      this.aimHandles = { light: t, tip, edge, center: p, ang, len };
    }
  }
  scaleBar(ctx) {
    const H = this.stage.clientHeight, at = { x: 24, y: H - 26 };
    const unit = L.units() === "imperial" ? L.FT : 1;
    const len = ([1, 2, 5, 10, 20, 50].find((n) => n * unit * this.view.k >= 60) || 50) * unit;
    const px = len * this.view.k;
    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(at.x - 8, at.y - 18, px + 16, 30);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(at.x, at.y - 4); ctx.lineTo(at.x, at.y + 4); ctx.moveTo(at.x, at.y); ctx.lineTo(at.x + px, at.y); ctx.moveTo(at.x + px, at.y - 4); ctx.lineTo(at.x + px, at.y + 4); ctx.stroke();
    ctx.font = `500 11px ${getComputedStyle(document.body).fontFamily}`; ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    ctx.fillText(this.calibrated() || !this.photo ? L.fmtLen(len) : "not to scale yet", at.x, at.y - 7);
  }

  // ---- input -------------------------------------------------------------------------------------

  local(e) { const b = this.canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }

  key(e) {
    if (e.target !== this.canvas) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (this.draft) {
      if (e.key === "Enter") { e.preventDefault(); this.finishDraft(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); this.draft.pts.pop(); if (!this.draft.pts.length) this.draft = null; this.paint(); return; }
      if (e.key === "Escape") { this.draft = null; this.paint(); return; }
    }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.remove(); return; }
    if (e.key === "Escape") { this.sel = null; this.picks = []; this.measure = null; this.paint(); return; }
    if (e.ctrlKey || e.metaKey) {
      if (k === "c") { e.preventDefault(); this.copy(); return; }
      if (k === "x") { e.preventDefault(); if (this.copy()) this.remove(); return; }
      if (k === "v") { e.preventDefault(); this.paste(); return; }
      if (k === "a") { e.preventDefault(); this.selectAll(); return; }
      if (k === "d") { e.preventDefault(); if (this.copy(true)) this.paste(); return; }
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = this.TOOLS().find((x) => x.key && x.key.toLowerCase() === k);
    if (t) { e.preventDefault(); this.setTool(t.id); }
  }

  // Points of the shapes that can be dragged: [{kind, id, i, get, set}]
  hitHandle(p) {
    const near = (x, y, r = 11) => { const q = this.h2s(x, y); return Math.hypot(q.x - p.x, q.y - p.y) <= r; };
    const d = this.doc, sel = this.sel, s = this.shape(sel);
    if (this.aimHandles && sel && sel.kind === "light") {
      const ah = this.aimHandles;
      if (Math.hypot(ah.tip.x - p.x, ah.tip.y - p.y) <= 12) return { kind: "aimTip" };
      if (Math.hypot(ah.edge.x - p.x, ah.edge.y - p.y) <= 10) return { kind: "aimEdge" };
    }
    const photoPts = (pts) => pts.findIndex(([u, v]) => { const [x, y] = this.p2h(u, v); return near(x, y); });
    if (d.square && (this.tool === "square" || (sel && sel.kind === "square"))) { const i = photoPts([d.square.a, d.square.b]); if (i >= 0) return { kind: "square", i }; }
    if (d.ref && (this.tool === "ref" || (sel && sel.kind === "ref"))) { const i = photoPts(d.ref.pts); if (i >= 0) return { kind: "ref", i }; }
    if (d.check && d.check.pts.length && (this.tool === "ref" || (sel && sel.kind === "check"))) { const i = photoPts(d.check.pts); if (i >= 0) return { kind: "check", i }; }
    if (d.outline && (this.tool === "outline" || (sel && sel.kind === "outline"))) { const i = d.outline.findIndex(([x, y]) => near(x, y)); if (i >= 0) return { kind: "outline", i }; }
    if (s && sel.kind === "yard") {
      if (s.c && near(s.c[0] + s.r, s.c[1])) return { kind: "yardR", id: s.id };
      if (s.pts) { const i = s.pts.findIndex(([x, y]) => near(x, y)); if (i >= 0) return { kind: "yard", id: s.id, i }; }
    }
    if (s && sel.kind === "wall") { if (near(...s.a)) return { kind: "wall", id: s.id, i: 0 }; if (near(...s.b)) return { kind: "wall", id: s.id, i: 1 }; }
    if (s && sel.kind === "stairs") {
      const e = stairEdges(s).find((q) => near(...q.at));
      // the ends move a whole step at a time: the tread stays as it is
      if (e) return { kind: "stairEdge", id: s.id, edge: e.edge, tread: stairInfo(s, this.ctx.floors()).tread };
    }
    return null;
  }
  hitShape(p) {
    const [x, y] = this.s2h(p);
    const d = this.doc, tol = 8 / this.view.k;
    const house = this.ctx.house();
    for (const t of house.targets) {
      if (!t.world || !t.item) continue;
      const q = this.h2s(t.world.x, t.world.y);
      if (Math.hypot(q.x - p.x, q.y - p.y) <= 9) return { kind: "light", id: t.id };
    }
    for (const r of d.rooms) if (r.level === this.level && Math.hypot(r.at[0] - x, r.at[1] - y) < 0.8) return { kind: "room", id: r.id };
    for (const dr of d.doors) {
      const w = d.walls.find((q) => q.id === dr.wall);
      if (!w || w.level !== this.level) continue;
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
      const c = [w.a[0] + (w.b[0] - w.a[0]) * dr.at / len, w.a[1] + (w.b[1] - w.a[1]) * dr.at / len];
      if (Math.hypot(c[0] - x, c[1] - y) < dr.width / 2) return { kind: "door", id: dr.id };
    }
    for (const w of d.walls) if (w.level === this.level && segDist([x, y], w.a, w.b) <= this.wallThick(w) / 2 + tol) return { kind: "wall", id: w.id };
    for (const t of d.stairs) if ((t.level === this.level || t.to === this.level) && x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) return { kind: "stairs", id: t.id };
    for (const yd of [...d.yard].reverse()) {
      if (yd.c && Math.hypot(yd.c[0] - x, yd.c[1] - y) <= yd.r) return { kind: "yard", id: yd.id };
      if (yd.kind === "path" && yardPieces(yd).some((line) => line.some((q, i) => i && segDist([x, y], line[i - 1], q) <= (yd.width ?? 1.2) / 2 + tol))) return { kind: "yard", id: yd.id };
      if (yd.pts && yd.kind !== "path" && yardPieces(yd).some((poly) => insidePoly({ x, y }, poly))) return { kind: "yard", id: yd.id };
    }
    if (d.outline && insidePoly({ x, y }, d.outline)) return { kind: "outline" };
    return null;
  }

  down(e) {
    if (!this.open()) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.drag = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), view: { ...this.view }, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; return; }
    if (this.tool === "pan" || e.button === 1 || e.button === 2) { this.drag = { kind: "pan", start: p, view: { ...this.view } }; return; }
    if (this.pickRef && this.sel && this.sel.kind === "wall") {
      const w = this.shape(this.sel), [x, y] = this.s2h(p), tol = 10 / this.view.k;
      const hit = w && this.wallRefs(w).find((r) => r.wall ? segDist([x, y], r.wall.a, r.wall.b) <= this.wallThick(r.wall) / 2 + tol
        : Math.abs((this.vertical(w) ? x : y) - r.pos) <= tol);
      this.pickRef = false;
      if (hit) this.wallRef = { wall: w.id, ref: hit.id }; else L.toast("That wall doesn't face this one: pick one that runs the same way, alongside it");
      this.paint();
      return;
    }
    const before = this.snapshot();
    // with the Wall tool a drag always draws a new wall (from another's end, say); ends are
    // adjusted with Select
    const h0 = this.hitHandle(p);
    const h = h0 && !(this.tool === "wall" && h0.kind === "wall") ? h0 : null;
    if (h) {
      if (e.altKey && h.kind === "outline" && this.doc.outline.length > 3) { this.doc.outline.splice(h.i, 1); this.commit(before); return; }
      if (e.altKey && h.kind === "yard") { const y = this.shape({ kind: "yard", id: h.id }); if (y.pts.length > (y.kind === "path" ? 2 : 3)) { y.pts.splice(h.i, 1); this.commit(before); } return; }
      this.drag = { kind: "handle", h, before, start: p };
      return;
    }
    const [x, y] = this.s2h(p);
    if (this.tool === "square") { this.drag = { kind: "squareDraw", start: p, cur: p, before }; return; }
    if (this.tool === "across") { this.chainTap([x, y]); return; }
    if (this.tool === "measure") { this.measure = null; this.drag = { kind: "measure", a: [x, y], start: p }; return; }
    if (this.tool === "wall" && this.movePlan) {
      const pick = (list) => list.filter((q) => q.level === this.level).map((q) => ({ q, o: JSON.parse(JSON.stringify(q)) }));
      this.drag = { kind: "movePlan", h0: [x, y], start: p, before, items: [...pick(this.doc.walls), ...pick(this.doc.rooms), ...pick(this.doc.stairs)] };
      return;
    }
    if (this.tool === "wall") { this.snapMark = null; this.drag = { kind: "wallDraw", a: this.snapWall([x, y], null, null, e.altKey), start: p, before }; return; }
    if (this.tool === "stairs") { this.drag = { kind: "stairDraw", a: [x, y], start: p, before }; return; }
    if (this.tool === "yard" && (this.opts.yard === "tree" || this.opts.yard === "bush")) { this.drag = { kind: "circle", c: [x, y], start: p, before }; return; }
    if (this.tool === "select" || this.tool === "aim") {
      const hit = this.hitShape(p);
      if (this.tool === "select" && (e.ctrlKey || e.metaKey)) {
        // Ctrl (or ⌘) + click: add it to what's picked, or take it out
        if (hit && COPYABLE.includes(hit.kind)) {
          const now = this.picked().filter((q) => COPYABLE.includes(q.kind));
          const i = now.findIndex((q) => q.kind === hit.kind && q.id === hit.id);
          if (i >= 0) now.splice(i, 1); else now.push(hit);
          this.picks = now.length > 1 ? now : [];
          this.sel = now[now.length - 1] || null;
          this.paint();
        }
        return;
      }
      if (hit && this.picks.length > 1 && this.picks.some((q) => q.kind === hit.kind && q.id === hit.id)) {
        this.drag = { kind: "moveMany", before, start: p, h0: [x, y], items: this.picks.map((q) => ({ q, orig: JSON.parse(JSON.stringify(this.shape(q))) })) };
        return;
      }
      this.picks = [];
      if (hit && (this.tool === "select" || hit.kind === "light")) {
        this.sel = hit;
        if (hit.kind === "light") this.ctx.select(hit.id);
        const s = this.shape(hit);
        this.drag = hit.kind === "light" ? null : { kind: "moveShape", hit, before, start: p, h0: [x, y], orig: JSON.parse(JSON.stringify(s)) };
        this.paint();
        return;
      }
      if (this.tool === "aim" && this.sel && this.sel.kind === "light") {
        // a tap aims the picked light there; a drag pans
        this.drag = { kind: "aimTap", start: p, view: { ...this.view } };
        return;
      }
      this.sel = null; this.aimHandles = null; this.paint();
      this.drag = { kind: "pan", start: p, view: { ...this.view } };
      return;
    }
    this.drag = { kind: "tap", start: p, before };
  }
  move(e) {
    this.altHeld = e.altKey;
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    this.hover = p;
    const d = this.drag;
    if (!d) { if (this.draft) this.render(); return; }
    d.cur = p;
    if (d.kind === "pinch" && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const k = Math.min(400, Math.max(1, d.view.k * (Math.hypot(a.x - b.x, a.y - b.y) / d.dist)));
      const hx = (d.mid.x - d.view.x) / d.view.k, hy = (d.view.y - d.mid.y) / d.view.k;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.view = { k, x: mid.x - hx * k, y: mid.y + hy * k, fitted: true };
      this.render(); return;
    }
    if (d.kind === "aimTap" && Math.hypot(p.x - d.start.x, p.y - d.start.y) > 6) d.kind = "pan";
    if (d.kind === "pan") { this.view = { ...d.view, x: d.view.x + p.x - d.start.x, y: d.view.y + p.y - d.start.y, fitted: true }; this.render(); return; }
    const [x, y] = this.s2h(p);
    if (d.kind === "handle") { this.dragHandle(d.h, p, [x, y]); this.render(); return; }
    if (d.kind === "moveShape") { this.dragShape(d, [x, y]); this.render(); return; }
    if (d.kind === "moveMany") { this.dragMany(d, [x, y]); this.render(); return; }
    if (d.kind === "measure") { this.measure = { a: d.a, b: [x, y], len: Math.hypot(x - d.a[0], y - d.a[1]) }; this.paintOptions(); this.render(); return; }
    if (d.kind === "wallDraw") { d.b = this.wallEnd(d.a, [x, y], null, e.altKey); d.a2 = this.shifted(d.a); this.render(); return; }
    if (d.kind === "stairDraw") { d.b = [x, y]; this.render(); return; }
    if (d.kind === "movePlan") {
      const dx = x - d.h0[0], dy = y - d.h0[1];
      const mv = ([px, py]) => [round3(px + dx), round3(py + dy)];
      for (const { q, o } of d.items) {
        if (o.a) { q.a = mv(o.a); q.b = mv(o.b); }
        if (o.at) q.at = mv(o.at);
        if (o.x0 !== undefined) { q.x0 = round3(o.x0 + dx); q.x1 = round3(o.x1 + dx); q.y0 = round3(o.y0 + dy); q.y1 = round3(o.y1 + dy); }
      }
      this.render(); return;
    }
    if (d.kind === "circle") { d.r = Math.hypot(x - d.c[0], y - d.c[1]); this.render(); return; }
    if (d.kind === "squareDraw") { d.b = true; this.render(); return; }
  }
  dragHandle(h, p, [x, y]) {
    const d = this.doc;
    const photo = () => { const b = this.view; const i = this.h2p(x, y); return [Math.round(i[0] * 10) / 10, Math.round(i[1] * 10) / 10]; };
    if (h.kind === "aimTip" || h.kind === "aimEdge") {
      const ah = this.aimHandles; if (!ah) return;
      const ang = Math.atan2(p.y - ah.center.y, p.x - ah.center.x);
      const aim = { ...ah.light.item.aim };
      if (h.kind === "aimTip") aim.heading = Math.round(headingFromScreen(ang));
      else aim.beam = Math.round(Math.max(5, Math.min(aim.kind === "wall" ? 180 : 160, 2 * Math.abs(angDiff(ang, ah.ang)) * 180 / Math.PI)));
      ah.light.item.aim = aim; // shown now, saved on release
      return;
    }
    if (h.kind === "square") { if (h.i === 0) d.square.a = photo(); else d.square.b = photo(); return; }
    if (h.kind === "ref") { d.ref.pts[h.i] = photo(); return; }
    if (h.kind === "check") { d.check.pts[h.i] = photo(); return; }
    if (h.kind === "outline") { d.outline[h.i] = [round3(x), round3(y)]; return; }
    if (h.kind === "stairEdge") {
      const s = this.shape({ kind: "stairs", id: h.id });
      if (!s) return;
      const along = s.dir[0], v = h.edge[0] === "x" ? x : y;
      if (h.edge[0] === along) {
        // an end: a whole number of treads from the other end
        const other = h.edge[1] === "0" ? s[`${along}1`] : s[`${along}0`];
        const n = Math.max(1, Math.min(60, Math.round(Math.abs(v - other) / h.tread)));
        s[h.edge] = round3(h.edge[1] === "0" ? other - n * h.tread : other + n * h.tread);
        s.steps = n;
      } else {
        const other = h.edge[1] === "0" ? s[`${h.edge[0]}1`] : s[`${h.edge[0]}0`];
        s[h.edge] = round3(h.edge[1] === "0" ? Math.min(v, other - 0.3) : Math.max(v, other + 0.3));
      }
      return;
    }
    const s = this.shape({ kind: h.kind === "yardR" ? "yard" : h.kind, id: h.id });
    if (h.kind === "yardR") { s.r = round3(Math.max(0.1, Math.hypot(x - s.c[0], y - s.c[1]))); return; }
    if (h.kind === "yard") { s.pts[h.i] = [round3(x), round3(y)]; return; }
    if (h.kind === "wall") {
      const other = h.i === 0 ? s.b : s.a;
      const q = this.wallEnd(other, [x, y], s, this.altHeld, s.angled);
      const o2 = this.shifted(other); // onto a corner: the other end slides over with it
      if (h.i === 0) { s.a = q; s.b = o2; } else { s.b = q; s.a = o2; }
    }
  }
  // Several picked things dragged together; the first wall among them snaps as one would alone
  dragMany(d, [x, y]) {
    let dx = x - d.h0[0], dy = y - d.h0[1];
    const w = d.items.find((it) => it.q.kind === "wall");
    if (w) {
      const [a] = this.snapWallMove(this.shape(w.q), [w.orig.a[0] + dx, w.orig.a[1] + dy], [w.orig.b[0] + dx, w.orig.b[1] + dy], this.altHeld);
      dx = a[0] - w.orig.a[0]; dy = a[1] - w.orig.a[1];
    }
    for (const it of d.items) moveItem(it.q.kind, this.shape(it.q), it.orig, dx, dy);
  }
  dragShape(d, [x, y]) {
    const dx = x - d.h0[0], dy = y - d.h0[1], o = d.orig, s = this.shape(d.hit);
    if (!s) return;
    const mv = ([px, py]) => [round3(px + dx), round3(py + dy)];
    if (d.hit.kind === "outline") { this.doc.outline = o.map(mv); return; }
    if (d.hit.kind === "yard") { if (o.c) s.c = mv(o.c); else { s.pts = o.pts.map(mv); if (o.parts) s.parts = o.parts.map((q) => q.map(mv)); } return; }
    if (d.hit.kind === "wall") { const [a, b] = this.snapWallMove(s, mv(o.a), mv(o.b), this.altHeld); s.a = a; s.b = b; return; }
    if (d.hit.kind === "room") { s.at = mv(o.at); return; }
    if (d.hit.kind === "stairs") { s.x0 = round3(o.x0 + dx); s.x1 = round3(o.x1 + dx); s.y0 = round3(o.y0 + dy); s.y1 = round3(o.y1 + dy); return; }
    if (d.hit.kind === "door") {
      const w = this.doc.walls.find((q) => q.id === s.wall); if (!w) return;
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
      const t = ((x - w.a[0]) * (w.b[0] - w.a[0]) + (y - w.a[1]) * (w.b[1] - w.a[1])) / len;
      s.at = round3(Math.max(s.width / 2, Math.min(len - s.width / 2, t)));
    }
  }
  up(e, cancel = false) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pinch") { if (this.pointers.size === 0) this.drag = null; return; }
    this.drag = null;
    if (cancel) { if (d.before) this.doc = JSON.parse(d.before); this.render(); return; }
    const p = this.local(e);
    const tapped = Math.hypot(p.x - d.start.x, p.y - d.start.y) < 6;
    if (d.kind === "pan" || d.kind === "measure") { this.paint(); return; }
    if (d.kind === "aimTap") {
      const t = this.shape(this.sel);
      if (!t || !t.item) return;
      const [x, y] = this.s2h(p);
      // a tree or bush under the tap: its canopy; else the ground
      const plant = this.doc.yard.find((q) => q.c && Math.hypot(q.c[0] - x, q.c[1] - y) <= q.r);
      const h = plant ? plant.h ?? (plant.kind === "tree" ? Math.max(3, plant.r * 1.6) : Math.max(0.6, plant.r)) : 0;
      const at = plant ? { x: plant.c[0], y: plant.c[1], z: round3(h * (plant.kind === "tree" ? 0.65 : 0.5)) } : { x: round3(x), y: round3(y), z: 0 };
      const what = plant ? (plant.name ? `the ${plant.name}` : `the ${plant.kind}`) : "the ground";
      const aim = t.item.aim || { kind: "flood", beam: 90, tilt: 0, heading: 0 };
      this.ctx.aim(t.id, { kind: aim.kind, beam: aim.beam, tilt: aim.tilt, heading: aim.heading, at, what });
      return;
    }
    const [x, y] = this.s2h(p);
    if (d.kind === "handle") {
      this.snapMark = null;
      if (d.h.kind === "aimTip" || d.h.kind === "aimEdge") { const ah = this.aimHandles; if (ah) this.ctx.aim(ah.light.id, ah.light.item.aim); return; }
      this.commit(d.before); return;
    }
    if (d.kind === "moveShape") { if (!tapped) this.commit(d.before); else this.paint(); return; }
    if (d.kind === "moveMany") { if (!tapped) this.commit(d.before); else { this.picks = []; this.sel = d.items[d.items.length - 1].q; this.paint(); } return; }
    if (d.kind === "squareDraw") {
      if (tapped) return;
      const a = this.h2p(...this.s2h(d.start)), b = this.h2p(x, y);
      this.doc.square = { a: a.map(round1), b: b.map(round1), runs: Math.abs(p.x - d.start.x) >= Math.abs(p.y - d.start.y) ? "across" : "depth" };
      this.doc.xf = null;
      this.view.fitted = false;
      this.commit(d.before);
      if (!this.doc.ref) this.setTool("ref");
      return;
    }
    if (d.kind === "movePlan") { this.commit(d.before); return; }
    if (d.kind === "stairDraw") {
      const st = this.stairFrom(d.a, [x, y]);
      if (!st) return this.render();
      const id = uid();
      this.doc.stairs.push({ id, ...st });
      this.sel = { kind: "stairs", id };
      this.commit(d.before); return;
    }
    if (d.kind === "wallDraw") {
      d.b = this.wallEnd(d.a, [x, y], null, e.altKey);
      d.a = this.shifted(d.a);
      this.snapMark = null;
      if (!d.b || Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) < 0.3) return this.render();
      const id = uid();
      this.doc.walls.push({ id, level: this.level, a: d.a.map(round3), b: d.b.map(round3), studs: this.opts.studs, finish: this.opts.finish, ...(this.opts.angled ? { angled: true } : {}) });
      this.sel = { kind: "wall", id };
      this.commit(d.before); return;
    }
    if (d.kind === "circle") {
      d.r = Math.hypot(x - d.c[0], y - d.c[1]);
      if (!d.r || d.r < 0.15) return this.render();
      const id = uid();
      this.doc.yard.push({ id, kind: this.opts.yard, name: "", c: d.c.map(round3), r: round3(d.r) });
      this.sel = { kind: "yard", id };
      this.commit(d.before); return;
    }
    if (d.kind !== "tap" || !tapped) return this.render();
    // taps
    if (this.tool === "ref" || this.tool === "outline" || this.tool === "yard") {
      const kind = this.tool === "ref" ? (this.checking ? "check" : "ref") : this.tool === "outline" ? "outline" : this.opts.yard;
      const photoPts = kind === "ref" || kind === "check";
      if (!this.draft || this.draft.kind !== kind) this.draft = { kind, photo: photoPts, pts: [] };
      const pts = this.draft.pts;
      const asH = (q) => (photoPts ? this.p2h(...q) : q);
      const closes = kind !== "ref" && kind !== "check" && kind !== "path";
      const near = (q) => { const s = this.h2s(...asH(q)); return Math.hypot(s.x - p.x, s.y - p.y) <= 12; };
      if (pts.length >= (closes ? 3 : 2) && near(closes ? pts[0] : pts[pts.length - 1])) { this.finishDraft(); return; }
      let at = [x, y];
      if (kind === "outline" && pts.length && !e.altKey) {
        // within 10° of straight across or straight back: make it exactly so
        const [px, py] = pts[pts.length - 1];
        const ang = Math.abs(Math.atan2(y - py, x - px)) * 180 / Math.PI;
        if (ang < 10 || ang > 170) at = [x, py];
        else if (Math.abs(ang - 90) < 10) at = [px, y];
      }
      pts.push(photoPts ? this.h2p(...at).map(round1) : [round3(at[0]), round3(at[1])]);
      this.paint(); return;
    }
    if (this.tool === "door") {
      const w = this.doc.walls.filter((q) => q.level === this.level).find((q) => segDist([x, y], q.a, q.b) <= this.wallThick(q) / 2 + 10 / this.view.k);
      if (!w) { L.toast("Tap on a wall"); return; }
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const t = ((x - w.a[0]) * (w.b[0] - w.a[0]) + (y - w.a[1]) * (w.b[1] - w.a[1])) / (len || 1);
      const width = Math.min(0.8128, len);
      const id = uid();
      this.doc.doors.push({ id, wall: w.id, at: round3(Math.max(width / 2, Math.min(len - width / 2, t))), width });
      this.sel = { kind: "door", id };
      this.commit(d.before); return;
    }
    if (this.tool === "room") {
      const id = uid();
      this.doc.rooms.push({ id, level: this.level, at: [round3(x), round3(y)], area: null, name: "" });
      this.sel = { kind: "room", id };
      this.commit(d.before); return;
    }
    if (this.tool === "light") {
      if (!this.ctx.selection().target) { L.toast("Pick a light from the list first"); return; }
      this.ctx.place(round3(x), round3(y), this.level);
    }
    this.render();
  }
  finishDraft() {
    const dr = this.draft;
    if (!dr) return;
    const before = this.snapshot();
    const d = this.doc;
    if (dr.kind === "ref") { if (dr.pts.length < 2) return; d.ref = { ...(d.ref || {}), pts: dr.pts }; }
    else if (dr.kind === "check") { if (dr.pts.length < 2) return; d.check = { ...(d.check || {}), pts: dr.pts }; if (!d.check.length) L.toast("Now type its front-to-back length"); }
    else if (dr.kind === "outline") { if (dr.pts.length < 3) return; d.outline = dr.pts; this.squareOutline(); this.sel = { kind: "outline" }; }
    else {
      const least = dr.kind === "path" ? 2 : 3;
      if (dr.pts.length < least) return;
      const id = uid();
      d.yard.push({ id, kind: dr.kind, name: "", pts: dr.pts, smooth: !!this.opts.smooth, ...(dr.kind === "path" ? { width: 1.2 } : {}) });
      this.sel = { kind: "yard", id };
    }
    this.draft = null;
    this.commit(before);
    if (dr.kind === "ref" && this.calibrated()) { this.view.fitted = false; L.toast("Scaled. Now trace the roof's outline."); this.setTool("outline"); }
  }
  dblclick(e) {
    const p = this.local(e), [x, y] = this.s2h(p);
    const d = this.doc;
    const add = (pts, closed) => {
      let best = null;
      for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const dd = segDist([x, y], a, b); if (dd < 10 / this.view.k && (!best || dd < best.d)) best = { i, d: dd }; }
      if (!best) return false;
      const before = this.snapshot(); pts.splice(best.i + 1, 0, [round3(x), round3(y)]); this.commit(before); return true;
    };
    if (this.sel && this.sel.kind === "outline" && d.outline) add(d.outline, true);
    else if (this.sel && this.sel.kind === "yard") { const s = this.shape(this.sel); if (s && s.pts) add(s.pts, s.kind !== "path"); }
  }
  // The start of a wall being drawn, moved over when its end snapped onto a corner (snapShift)
  shifted(a) { return this.snapShift ? [round3(a[0] + this.snapShift[0]), round3(a[1] + this.snapShift[1])] : a; }
  // Where a wall's end goes, dragged from its other end `a`: square to the house (unless angled),
  // then onto what's near (snapWall)
  wallEnd(a, p, skip, free, angled = this.opts.angled) {
    if (angled) return this.snapWall(p, null, skip, free);
    return this.snapWall(squareTo(a, p), a, skip, free);
  }
  // ---- copy and paste: walls (with their doorways), rooms, stairs and yard shapes ------------------
  copy(quiet = false) {
    const d = this.doc, items = this.picked().filter((q) => COPYABLE.includes(q.kind));
    if (!items.length) { if (!quiet) L.toast("Pick walls, rooms, stairs or yard shapes to copy (Ctrl+click picks several)"); return false; }
    const ids = (kind) => new Set(items.filter((q) => q.kind === kind).map((q) => q.id));
    const pick = (list, kind) => list.filter((x) => ids(kind).has(x.id)).map((x) => JSON.parse(JSON.stringify(x)));
    const walls = pick(d.walls, "wall"), wallIds = new Set(walls.map((w) => w.id));
    CLIP = { level: this.level, walls, doors: d.doors.filter((x) => wallIds.has(x.wall)).map((x) => ({ ...x })), rooms: pick(d.rooms, "room"), stairs: pick(d.stairs, "stairs"), yard: pick(d.yard, "yard") };
    if (!quiet) L.toast(`Copied ${clipCount()}. Show another level and paste (Ctrl+V) to put them in the same place there.`);
    this.paint();
    return true;
  }
  // Onto the level shown, in the same place (so walls stack from one level to the next); where
  // they'd land on themselves, a foot over
  paste(level = this.level) {
    if (!CLIP || !clipCount()) { L.toast("Nothing copied yet"); return; }
    const d = this.doc, before = this.snapshot();
    // already there (pasted twice, or onto the level they came from): a foot over
    const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01;
    const there = CLIP.walls.some((w) => d.walls.some((o) => o.level === level && same(o.a, w.a) && same(o.b, w.b)))
      || CLIP.rooms.some((r) => d.rooms.some((o) => o.level === level && same(o.at, r.at)))
      || CLIP.stairs.some((t) => d.stairs.some((o) => o.level === level && same([o.x0, o.y0], [t.x0, t.y0]) && same([o.x1, o.y1], [t.x1, t.y1])));
    const shift = level === CLIP.level || there ? 0.3048 : 0;
    const mv = (pt) => [round3(pt[0] + shift), round3(pt[1] - shift)];
    const picks = [], newWall = new Map();
    for (const w of CLIP.walls) { const id = uid(); newWall.set(w.id, id); d.walls.push({ ...w, id, level, a: mv(w.a), b: mv(w.b) }); picks.push({ kind: "wall", id }); }
    for (const dr of CLIP.doors) d.doors.push({ ...dr, id: uid(), wall: newWall.get(dr.wall) });
    for (const r of CLIP.rooms) { const id = uid(); d.rooms.push({ ...r, id, level, at: mv(r.at) }); picks.push({ kind: "room", id }); }
    for (const t of CLIP.stairs) {
      const id = uid();
      // stairs pasted onto the level they led to lead back to where they came from
      const to = t.to === level ? CLIP.level : t.to;
      d.stairs.push({ ...t, id, level, to, x0: round3(t.x0 + shift), x1: round3(t.x1 + shift), y0: round3(t.y0 - shift), y1: round3(t.y1 - shift) });
      picks.push({ kind: "stairs", id });
    }
    for (const y of CLIP.yard) {
      const id = uid(), yy = JSON.parse(JSON.stringify(y));
      if (yy.pts) yy.pts = yy.pts.map(([a, b]) => [round3(a + 0.3048), round3(b - 0.3048)]);
      if (yy.parts) yy.parts = yy.parts.map((q) => q.map(([a, b]) => [round3(a + 0.3048), round3(b - 0.3048)]));
      if (yy.c) yy.c = [round3(yy.c[0] + 0.3048), round3(yy.c[1] - 0.3048)];
      d.yard.push({ ...yy, id });
      picks.push({ kind: "yard", id });
    }
    if (level !== this.level) this.level = level;
    this.tool = "select";
    this.picks = picks.length > 1 ? picks : [];
    this.sel = picks[picks.length - 1] || null;
    this.commit(before);
    L.toast(`Pasted ${clipCount()} on ${this.levelName()}${shift ? ", a foot over" : ""}`);
  }
  // Every wall, room and stairs on the level shown
  selectAll() {
    const d = this.doc, here = (x) => x.level === this.level;
    const picks = [...d.walls.filter(here).map((x) => ({ kind: "wall", id: x.id })), ...d.rooms.filter(here).map((x) => ({ kind: "room", id: x.id })), ...d.stairs.filter(here).map((x) => ({ kind: "stairs", id: x.id }))];
    if (!picks.length) { L.toast(`Nothing drawn on the ${this.levelName()} plan yet`); return; }
    this.tool = "select";
    this.picks = picks.length > 1 ? picks : [];
    this.sel = picks[picks.length - 1];
    this.paint();
  }
  // The buttons for the same: on a phone or tablet there's no keyboard
  clipRow() {
    const { el } = L;
    const some = this.picked().some((q) => COPYABLE.includes(q.kind));
    const others = this.ctx.floors().filter((f) => f.id !== this.level);
    const to = el("select.input", { style: { width: "auto" } }, others.map((f) => el("option", { value: f.id }, f.name)));
    return el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "10px" } },
      el("div.row", { style: { gap: "6px", flexWrap: "wrap" } },
        some ? el("button.btn.small", { type: "button", title: "Ctrl+C", on: { click: () => this.copy() } }, "Copy") : null,
        some ? el("button.btn.small", { type: "button", title: "Ctrl+X", on: { click: () => { if (this.copy()) this.remove(); } } }, "Cut") : null,
        CLIP && clipCount() ? el("button.btn.small", { type: "button", title: "Ctrl+V", on: { click: () => this.paste() } }, `Paste ${clipCount()} here`) : null),
      some && others.length ? el("div.row", { style: { gap: "6px", flexWrap: "wrap", alignItems: "center" } },
        el("span.small.muted", "Copy to"), to,
        el("button.btn.small", { type: "button", on: { click: () => { if (this.copy(true)) this.paste(to.value); } } }, "Copy")) : null,
      el("span.small.muted", "Ctrl+click picks several. Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+A (everything on this level), Ctrl+D (duplicate), Delete, Esc."));
  }
  // A whole wall dragged to a, b: whichever of its ends comes near another wall's end, a corner of
  // the outside walls' inside face, or onto another wall (not one alongside it), takes it there,
  // and the rest of the wall comes too (so it stays the same length and way round). Alt: no snap.
  snapWallMove(w, a, b, free) {
    this.snapMark = null;
    if (free) return [a, b];
    const walls = this.doc.walls.filter((q) => q.level === this.level && q !== w);
    const half = Math.max(this.wallThick(w), ...walls.map((q) => this.wallThick(q))) / 2;
    const tol = Math.max(16 / this.view.k, 2 * half + 12 / this.view.k);
    const inner = this.planInner() || [];
    const pts = [...walls.flatMap((q) => [q.a, q.b]), ...inner];
    const segs = [...walls.map((q) => [q.a, q.b]), ...inner.map((q, i) => [q, inner[(i + 1) % inner.length]])];
    const ux = b[0] - a[0], uy = b[1] - a[1], ul = Math.hypot(ux, uy) || 1;
    let best = null;
    const take = (end, q, rank) => {
      const d = Math.hypot(q[0] - end[0], q[1] - end[1]);
      if (d <= tol && (!best || rank < best.rank || (rank === best.rank && d < best.d))) best = { d, rank, q, dx: q[0] - end[0], dy: q[1] - end[1] };
    };
    for (const end of [a, b]) {
      for (const q of pts) take(end, q, 0); // ends and corners first
      for (const [p, q] of segs) {
        const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy;
        if (!l2 || Math.abs(ux * dy - uy * dx) / (ul * Math.sqrt(l2)) < 0.1) continue; // alongside: no
        const t = Math.max(0, Math.min(1, ((end[0] - p[0]) * dx + (end[1] - p[1]) * dy) / l2));
        take(end, [p[0] + t * dx, p[1] + t * dy], 1);
      }
    }
    if (!best) return [a, b];
    this.snapMark = best.q;
    const mv = ([x, y]) => [round3(x + best.dx), round3(y + best.dy)];
    return [mv(a), mv(b)];
  }
  // A wall end near (x, y): another wall's end or a corner of the outside walls' inside face
  // first, else onto another wall or that face (a T). With `from` (the other end, square walls),
  // the end stays on the line from it. Marks where it snapped (snapMark); `free` (Alt): no snap.
  snapWall([x, y], from, skip, free) {
    this.snapMark = null;
    this.snapShift = null;
    if (free) return [round3(x), round3(y)];
    const walls = this.doc.walls.filter((w) => w.level === this.level && w !== skip);
    // Zoomed in, a wall is many pixels thick: an end dropped anywhere on another wall's body
    // (or the new wall's own half-thickness from it) snaps to its centre line, so corners meet
    const half = Math.max(this.wallThick(this.opts), ...walls.map((w) => this.wallThick(w))) / 2;
    const tol = Math.max(12 / this.view.k, 2 * half + 6 / this.view.k);
    const inner = this.planInner() || [];
    const pts = [...walls.flatMap((w) => [w.a, w.b]), ...inner];
    const segs = [...walls.map((w) => [w.a, w.b]), ...inner.map((q, i) => [q, inner[(i + 1) % inner.length]])];
    const across = from ? Math.abs(y - from[1]) < 1e-9 : false; // a square wall running across (y stays)
    let best = null;
    const take = (q) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d <= tol && (!best || d < best.d)) best = { q, d }; };
    // a square wall ending near another wall's end or a corner: it meets it there, the whole wall
    // sliding sideways that little (snapShift, for its start) so the corner is clean
    if (from) {
      // only a slide of up to two wall thicknesses: further off, it's not meant for that corner
      for (const q of pts) if (Math.abs(across ? q[1] - y : q[0] - x) <= 2 * half) take(q);
      if (best) {
        this.snapMark = best.q;
        this.snapShift = across ? [0, best.q[1] - y] : [best.q[0] - x, 0];
        return best.q.map(round3);
      }
    }
    // ends and corners
    for (const q of pts) {
      if (!from) take(q);
      else take(across ? [q[0], y] : [x, q[1]]); // in line with it (an end, or square to it)
    }
    if (best) { this.snapMark = best.q; return best.q.map(round3); }
    // onto a wall or the outside walls' inside face
    for (const [a, b] of segs) {
      if (from) {
        // where the wall's line meets it
        const q = across ? crossAt(a, b, "y", y) : crossAt(a, b, "x", x);
        if (q) take(q);
      } else {
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        if (!l2) continue;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
        take([a[0] + t * dx, a[1] + t * dy]);
      }
    }
    if (best) { this.snapMark = best.q; return best.q.map(round3); }
    return [round3(x), round3(y)];
  }
  // Snap a plan point to wall ends and the outside walls' inside faces
  snapPlan([x, y]) {
    const tol = 10 / this.view.k;
    let bx = x, by = y;
    const xs = [], ys = [];
    for (const w of this.doc.walls) if (w.level === this.level) { xs.push(w.a[0], w.b[0]); ys.push(w.a[1], w.b[1]); }
    const inner = this.planInner();
    if (inner) { for (const [px, py] of inner) { xs.push(px); ys.push(py); } }
    for (const v of xs) if (Math.abs(v - x) < tol && Math.abs(v - x) < Math.abs(bx - x) + 1e-9) bx = v;
    for (const v of ys) if (Math.abs(v - y) < tol && Math.abs(v - y) < Math.abs(by - y) + 1e-9) by = v;
    return [round3(bx), round3(by)];
  }
};

// ---- constants and helpers ---------------------------------------------------------------------

const OUT = "_outside";
const STUD_M = { "2x4": 0.0889, "2x6": 0.1397, "2x8": 0.1842 };
const FINISH_M = { drywall: 0.0127, plaster: 0.01905 };
const EXT_WALL = { "2x4": 0.0889 + 0.0127 + 0.0301, "2x6": 0.1397 + 0.0127 + 0.0301, "2x8": 0.1842 + 0.0127 + 0.0301 };
const WALL_BUILDS = [["2x4", "drywall"], ["2x6", "drywall"], ["2x8", "drywall"], ["2x4", "plaster"], ["2x6", "plaster"], ["2x8", "plaster"]];
const YARD_LABEL = { path: "Path", driveway: "Driveway", patio: "Patio", pool: "Pool", bed: "Garden bed", lawn: "Lawn", tree: "Tree", bush: "Bush", other: "Other" };
const YARD_COLOR = { path: "#c9c2b4", driveway: "#9aa0a6", patio: "#d4a373", pool: "#4cc3f0", bed: "#8d6e4f", lawn: "#6fbf73", tree: "#3f9d4a", bush: "#7cc576", other: "#b0b8c4" };
// What a light's beam is like: all around (a bulb), a flood, a spot, or a half (wall lights)
const BEAMS = {
  all: { label: "All around", defaults: {} },
  flood: { label: "Flood", defaults: { kind: "flood", beam: 90, tilt: 0, heading: 0 } },
  spot: { label: "Spot", defaults: { kind: "spot", beam: 25, tilt: 0, heading: 0 } },
  wall: { label: "Half (wall light)", defaults: { kind: "wall", beam: 180, tilt: 0, heading: 0 } },
};

function rot([x, y], t) { const c = Math.cos(t), s = Math.sin(t); return [c * x - s * y, s * x + c * y]; }
function bbox(pts) { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; }
function centroid(pts) { return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]; }
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
// Keep a wall square to the house: along x or along y from its start
// Where segment a-b crosses the line where coordinate `axis` ("x" or "y") is v, or null
function crossAt(a, b, axis, v) {
  const i = axis === "x" ? 0 : 1, j = 1 - i;
  const lo = Math.min(a[i], b[i]), hi = Math.max(a[i], b[i]);
  if (v < lo - 1e-9 || v > hi + 1e-9 || Math.abs(b[i] - a[i]) < 1e-9) return null;
  const t = (v - a[i]) / (b[i] - a[i]);
  const q = [0, 0]; q[i] = v; q[j] = a[j] + t * (b[j] - a[j]);
  return q;
}
// Stairs: width across, length along the way they go, steps (treads, not the floor at the top),
// each tread's depth, each step's height, and how far they climb. Steps not typed follow from
// the levels' heights (about 7.5" a step); a step height not typed fits the levels.
function stairInfo(t, floors) {
  const along = t.dir[0];
  const run = along === "x" ? t.x1 - t.x0 : t.y1 - t.y0;
  const width = along === "x" ? t.y1 - t.y0 : t.x1 - t.x0;
  const f0 = floors.find((f) => f.id === t.level), f1 = floors.find((f) => f.id === t.to);
  // between two blocks' floors (set in 3D), else the levels'
  const z0 = t.z0 ?? (f0 && f0.elevation), z1 = t.z1 ?? (f1 && f1.elevation);
  const rise = z0 != null && z1 != null ? Math.abs(z1 - z0) : 0;
  const steps = t.steps || (rise ? Math.max(1, Math.round(rise / 0.19) - 1) : Math.max(1, Math.round(run / 0.28)));
  const riser = t.riser || (rise ? rise / (steps + 1) : 0.19);
  return { run, width, rise, steps, tread: run / steps, riser, climb: riser * (steps + 1) };
}
// Change stairs by a typed width, tread depth or number of steps. The bottom stays where it is.
function setStair(s, { width, tread, steps }, floors) {
  const info = stairInfo(s, floors);
  const along = s.dir[0], across = along === "x" ? "y" : "x";
  if (width !== undefined) { if (width < 0.3) return; s[`${across}1`] = round3(s[`${across}0`] + width); return; }
  const n = steps ?? info.steps, tr = tread ?? info.tread;
  if (!(n >= 1) || !(tr >= 0.1)) return;
  s.steps = n;
  const run = n * tr;
  if (s.dir[1] === "+") s[`${along}1`] = round3(s[`${along}0`] + run); else s[`${along}0`] = round3(s[`${along}1`] - run);
}
// A yard shape's pieces: its own line or outline, then any merged into it
function yardPieces(y) { return y.pts ? [y.pts, ...(y.parts || [])] : []; }
// Several outlines filled as one shape: overlaps filled once, and each outline stroked only where
// it isn't inside another, so merged shapes show no seam
function drawUnion(ctx, polys, fill, stroke, width) {
  const area = (q) => q.reduce((a, p, i) => { const n = q[(i + 1) % q.length]; return a + p.x * n.y - n.x * p.y; }, 0);
  const one = polys.map((q) => (area(q) < 0 ? [...q].reverse() : q)); // all the same way round
  ctx.beginPath();
  for (const q of one) q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.fillStyle = fill; ctx.fill("nonzero");
  ctx.lineWidth = width; ctx.strokeStyle = stroke;
  one.forEach((q, i) => {
    ctx.save();
    if (one.length > 1) {
      ctx.beginPath(); ctx.rect(-1e5, -1e5, 2e5, 2e5);
      one.forEach((o, j) => { if (j !== i) o.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); });
      ctx.clip("evenodd");
    }
    ctx.beginPath(); q.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
    ctx.restore();
  });
}
// What can be picked several at a time, copied and pasted, and where each kind is kept
const COPYABLE = ["wall", "room", "stairs", "yard"];
const LISTS = { yard: "yard", wall: "walls", door: "doors", room: "rooms", stairs: "stairs" };
// The clipboard: shared by every Top view on the page, kept while the page is open
let CLIP = null;
function clipCount() { return CLIP ? CLIP.walls.length + CLIP.rooms.length + CLIP.stairs.length + CLIP.yard.length : 0; }
// Move a plan item from its original by dx, dy
function moveItem(kind, s, o, dx, dy) {
  if (!s) return;
  const mv = ([px, py]) => [round3(px + dx), round3(py + dy)];
  if (kind === "wall") { s.a = mv(o.a); s.b = mv(o.b); }
  else if (kind === "room") s.at = mv(o.at);
  else if (kind === "stairs") { s.x0 = round3(o.x0 + dx); s.x1 = round3(o.x1 + dx); s.y0 = round3(o.y0 + dy); s.y1 = round3(o.y1 + dy); }
  else if (kind === "yard") { if (o.c) s.c = mv(o.c); else { s.pts = o.pts.map(mv); if (o.parts) s.parts = o.parts.map((q) => q.map(mv)); } }
}
// Stairs as seen from the level they lead to: from there they go the other way
function stairsSeenFrom(t) {
  return { ...t, level: t.to, to: t.level, dir: { "x+": "x-", "x-": "x+", "y+": "y-", "y-": "y+" }[t.dir] };
}
// The middle of each side of a stair rectangle: drag handles
function stairEdges(t) {
  const xm = (t.x0 + t.x1) / 2, ym = (t.y0 + t.y1) / 2;
  return [{ edge: "x0", at: [t.x0, ym] }, { edge: "x1", at: [t.x1, ym] }, { edge: "y0", at: [xm, t.y0] }, { edge: "y1", at: [xm, t.y1] }];
}
function squareTo(a, b) { return Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]]; }
// A polygon pulled in by d (each edge moved in, corners where they meet)
function insetPoly(poly, d) {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const [x0, y0] = poly[(i + n - 1) % n], [x1, y1] = poly[i]; area += x0 * y1 - x1 * y0; }
  const sign = area > 0 ? 1 : -1;
  const lines = poly.map(([x0, y0], i) => {
    const [x1, y1] = poly[(i + 1) % n];
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    return { p: [x0 - (dy / len) * sign * d, y0 + (dx / len) * sign * d], r: [dx, dy] };
  });
  return lines.map((l, i) => {
    const { p, r } = lines[(i + n - 1) % n], q = l.p, s = l.r;
    const cross = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(cross) < 1e-9) return q;
    const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / cross;
    return [p[0] + t * r[0], p[1] + t * r[1]];
  });
}
// A smooth closed (or open) curve through screen points (Catmull-Rom as Béziers)
function smoothPath(ctx, q, closed) {
  const n = q.length, P = (i) => q[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
  }
  if (closed) ctx.closePath();
}
// Headings: 0 faces the street; degrees turning clockwise seen from above
function headingVec(h) { const r = h * Math.PI / 180; return [-Math.sin(r), -Math.cos(r)]; }
function headingFromScreen(ang) {
  // screen angle (y down) -> house direction (y up) -> heading
  const dx = Math.cos(ang), dy = -Math.sin(ang);
  let h = Math.atan2(-dx, -dy) * 180 / Math.PI;
  return (h + 360) % 360;
}
function headingText(h) {
  const names = ["the street", "the street and left", "the left side", "the back and left", "the back", "the back and right", "the right side", "the street and right"];
  return `toward ${names[Math.round(((h % 360) + 360) % 360 / 45) % 8]}`;
}
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
