// A small volumetric view of the house for the house map: floors as slabs at their real heights,
// lights as orbs with a line down to their floor, a ground grid. Drag to orbit, wheel or pinch to
// zoom; tap a light to pick it; drag the picked light across its floor (Move) or up and down
// (Raise). Plain canvas 2D with a perspective camera: no 3D library to download.
"use strict";

window.House3D = class House3D {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.h = handlers; // onPick(id, part), onPlace(x, y), onMove(id, part, x, y, done), onRaise(id, h, done), onAimAt(point, what)
    this.scene = null;
    this.yaw = -0.55;     // around the vertical axis
    this.pitch = 0.62;    // above the horizon
    this.zoom = 1;
    this.mode = "move";   // "move" | "raise"
    this.pan = { x: 0, y: 0, z: 0 }; // how far the view's middle is slid from the house's
    this.pointers = new Map();
    this.drag = null;
    const ro = new ResizeObserver(() => this.render());
    ro.observe(canvas);
    canvas.style.touchAction = "none";
    canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // the right button pans
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e, true));
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom = Math.min(4, Math.max(0.35, this.zoom * Math.exp(-e.deltaY * 0.0012)));
      this.render();
    }, { passive: false });
  }

  setScene(scene) {
    this.scene = scene;
    this.render();
  }

  preset(name) {
    if (name === "top") { this.yaw = 0; this.pitch = 1.5; }
    else if (name === "front") { this.yaw = 0; this.pitch = 0.08; }
    else { this.yaw = -0.55; this.pitch = 0.62; }
    this.zoom = 1;
    this.pan = { x: 0, y: 0, z: 0 };
    this.render();
  }

  // ---- camera ------------------------------------------------------------------------------

  camera() {
    const s = this.scene;
    const target = { x: s.W / 2 + this.pan.x, y: s.D / 2 - 2 + this.pan.y, z: (s.zMin + s.zMax) / 2 + this.pan.z };
    const span = Math.max(s.W + 12, s.D + 15, (s.zMax - s.zMin) * 2);
    const dist = (span * 1.15) / this.zoom;
    const cp = Math.cos(this.pitch);
    const pos = {
      x: target.x + dist * cp * Math.sin(this.yaw),
      y: target.y - dist * cp * Math.cos(this.yaw),
      z: target.z + dist * Math.sin(this.pitch),
    };
    const f = norm(sub(target, pos));
    let r = cross(f, { x: 0, y: 0, z: 1 });
    if (len(r) < 1e-6) r = { x: 1, y: 0, z: 0 };
    r = norm(r);
    const u = cross(r, f);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    return { pos, f, r, u, cx: W / 2, cy: H / 2, focal: Math.min(W, H * 1.6) * 1.1 };
  }

  project(p, cam = this.cam) {
    const d = sub(p, cam.pos);
    const zc = dot(d, cam.f);
    if (zc < 0.1) return null;
    return { x: cam.cx + (dot(d, cam.r) * cam.focal) / zc, y: cam.cy - (dot(d, cam.u) * cam.focal) / zc, depth: zc, scale: cam.focal / zc };
  }

  ray(sx, sy, cam = this.cam) {
    return norm(add(cam.f, add(scale(cam.r, (sx - cam.cx) / cam.focal), scale(cam.u, -(sy - cam.cy) / cam.focal))));
  }

  // Where a screen point meets the horizontal plane at height z
  onPlane(sx, sy, z) {
    const cam = this.cam;
    const d = this.ray(sx, sy, cam);
    if (Math.abs(d.z) < 1e-6) return null;
    const t = (z - cam.pos.z) / d.z;
    if (t <= 0) return null;
    return { x: cam.pos.x + d.x * t, y: cam.pos.y + d.y * t };
  }

  // ---- drawing ---------------------------------------------------------------------------------

  colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return { bg: v("--field"), line: v("--line"), line2: v("--line2"), faint: v("--faint"), muted: v("--muted"),
      text: v("--text"), accent: v("--accent"), info: v("--info"), ok: v("--ok"), card2: v("--card2") };
  }

  render() {
    const c = this.canvas, ctx = this.ctx, s = this.scene;
    if (!s) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = this.colors();
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, W, H);
    const cam = (this.cam = this.camera());
    const P = (x, y, z) => this.project({ x, y, z }, cam);

    // ground grid
    const g = s.grid;
    ctx.lineWidth = 1;
    const gx0 = Math.floor(-6 / g) * g, gx1 = s.W + 6, gy0 = Math.floor(-12 / g) * g, gy1 = s.D + 4;
    const grid = (alpha = 1) => {
      ctx.globalAlpha = alpha;
      for (let x = gx0; x <= gx1 + 1e-6; x += g) this.line(P(x, gy0, 0), P(x, gy1, 0), Math.round(x / g) % 5 ? col.line : col.line2);
      for (let y = gy0; y <= gy1 + 1e-6; y += g) this.line(P(gx0, y, 0), P(gx1, y, 0), Math.round(y / g) % 5 ? col.line : col.line2);
      ctx.globalAlpha = 1;
    };
    if (!s.solid) grid();
    // in the solid view the flat things on the ground wait for the ground (drawn after what's below it)
    this._flat = s.solid ? [] : null;

    // things to draw back to front
    const items = [];
    // the house drawn on the front photo: see-through walls and roofs, windows on the front
    if (s.top) this.topView(items, P, col);
    if (s.massing) this.massing(items, P, col);
    // else the house volume: outline from the lowest floor to the top of the highest
    const box = s.massing ? [] : [[0, 0], [s.W, 0], [s.W, s.D], [0, s.D]];
    for (const [x, y] of box) items.push({ depth: depthOf(P(x, y, s.zMin), P(x, y, s.zMax)), draw: () => this.line(P(x, y, s.zMin), P(x, y, s.zMax), col.faint, 1) });
    if (box.length) for (const z of [s.zMin, s.zMax]) for (let k = 0; k < 4; k++) {
      const a = box[k], b = box[(k + 1) % 4];
      items.push({ depth: depthOf(P(a[0], a[1], z), P(b[0], b[1], z)), draw: () => this.line(P(a[0], a[1], z), P(b[0], b[1], z), col.faint, 1) });
    }
    // floors: a slab at each elevation over its span, and a faint ceiling
    const cut = s.cutZ ?? Infinity; // a block picked in Shape: what's above it is hidden
    for (const f of s.floors) {
      if (f.elevation >= cut - 0.05) continue;
      const x0 = f.x0 ?? 0, x1 = f.x1 ?? s.W;
      // a level's floor lies only under the blocks it's in (else the whole house, as before)
      const spans = this.floorSpans(f, x0, x1);
      if (spans.length > 1 || (spans.length === 1 && spans[0].own)) {
        for (const r of spans) {
          const q = [P(r.x0, r.y0, f.elevation), P(r.x1, r.y0, f.elevation), P(r.x1, r.y1, f.elevation), P(r.x0, r.y1, f.elevation)];
          items.push({ depth: avgDepth(q) + 0.01, room: r.room, rank: 0, draw: () => {
            if (f.set === false) this.ctx.setLineDash([5, 4]);
            this.poly(q, f.active ? col.accent : col.card2, f.set === false ? 0 : f.active ? 0.18 : 0.55, f.active ? col.accent : col.line2);
            this.ctx.setLineDash([]);
          } });
        }
        const r0 = spans[0], lab = P(r0.x0 + 0.3, r0.y0 + 0.2, f.elevation);
        if (lab) items.push({ depth: lab.depth, draw: () => this.text(`${f.name}  ${f.label}${f.set === false ? " (guessed)" : ""}`, lab.x, lab.y - 4, f.active ? col.accent : col.muted, 11, "left") });
        continue;
      }
      // a house with blocks but none in this level: just its name, no floor the size of the house
      if (s.massing && s.massing.blocks.length) {
        const lab = P(x0 + 0.3, 0.2, f.elevation);
        if (lab) items.push({ depth: lab.depth, draw: () => this.text(`${f.name}  ${f.label}${f.set === false ? " (guessed)" : ""}`, lab.x, lab.y - 4, f.active ? col.accent : col.muted, 11, "left") });
        continue;
      }
      const quad = (z) => [P(x0, 0, z), P(x1, 0, z), P(x1, s.D, z), P(x0, s.D, z)];
      const floorQ = quad(f.elevation), ceilQ = quad(f.elevation + f.ceiling);
      // a floor whose height is guessed from the others is only outlined, dashed
      const guessed = f.set === false;
      items.push({ depth: avgDepth(floorQ) + 0.01, draw: () => {
        if (guessed) this.ctx.setLineDash([5, 4]);
        this.poly(floorQ, f.active ? col.accent : col.card2, guessed ? 0 : f.active ? 0.18 : 0.55, f.active ? col.accent : col.line2);
        this.ctx.setLineDash([]);
        const lab = P(x0 + 0.3, 0.2, f.elevation);
        if (lab) this.text(`${f.name}  ${f.label}${guessed ? " (guessed)" : ""}`, lab.x, lab.y - 4, f.active ? col.accent : col.muted, 11, "left");
      } });
      if (!guessed) items.push({ depth: avgDepth(ceilQ), draw: () => this.poly(ceilQ, col.card2, 0, f.active ? col.accent : col.line, 0.5) });
    }
    // pools of each light's own colour on the floor under it (the solid view)
    for (const gl of s.glows || []) {
      if (gl.floorZ >= cut - 0.05) continue;
      const r = gl.r ?? 1.2 + 2.2 * gl.level;
      // light stops at a wall: each way out from under the light, only as far as the first wall
      const walls = this.obstacles(gl.floor, gl.floorZ);
      const ring = Array.from({ length: 36 }, (_, k) => {
        const a = (k / 36) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
        const t = Math.min(r, this.wallHit2d(gl.x, gl.y, dx, dy, r, walls, gl.floorZ + 0.1));
        return P(gl.x + dx * t, gl.y + dy * t, gl.floorZ + 0.02);
      });
      const c0 = P(gl.x, gl.y, gl.floorZ + 0.02);
      if (!c0 || ring.some((q) => !q)) continue;
      items.push({ depth: c0.depth - 0.05, below: gl.floorZ < -0.01, room: this.roomOf(gl.x, gl.y, gl.floorZ + 0.1), rank: 2, draw: () => {
        const rad = Math.max(...ring.map((q) => Math.hypot(q.x - c0.x, q.y - c0.y)));
        const grad = ctx.createRadialGradient(c0.x, c0.y, 0, c0.x, c0.y, rad);
        grad.addColorStop(0, hexA(gl.color, 0.55 * gl.level + 0.1)); grad.addColorStop(1, hexA(gl.color, 0));
        ctx.save(); ctx.globalCompositeOperation = "lighter";
        ctx.beginPath(); ring.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
        ctx.fillStyle = grad; ctx.fill(); ctx.restore();
      } });
    }
    // The structure first (back to front), then the lights on top of it, so slabs never hide them.
    // Room by room, the farthest first; in a room its floor, the walls seen from inside, light on
    // the floor, what's in it, then the walls seen from outside and their windows. (Sorting faces
    // by their middles alone put long walls and the walls in a room in the wrong order.)
    const rooms = (s.massing ? s.massing.blocks : []).map((b) => { const p = P((b.x0 + b.x1) / 2, (b.y0 || 0) + b.depth / 2, (b.z0 + b.z1) / 2); return p ? p.depth : 0; });
    const key = (it) => (it.room != null && it.room >= 0 && it.depth > -1e8 ? rooms[it.room] : it.depth);
    items.sort((a, b) => (key(b) - key(a)) || ((a.rank ?? 3) - (b.rank ?? 3)) || (b.depth - a.depth));
    if (s.solid) {
      // below the ground first (a basement's walls), then the ground with a hole where each block
      // goes into it, the grid and the yard on it, then the rest
      for (const it of items) if (it.below) it.draw();
      this.solidGround(P, col, gx0, gx1, gy0, gy1);
      grid(0.45);
      for (const f of this._flat) f();
      for (const it of items) if (!it.below) it.draw();
    } else for (const it of items) it.draw();
    this._flat = null;
    items.length = 0;
    // lights: a drop line to the floor, a shadow, the orb; parts as small dots
    for (const l of s.lights) {
      const top = P(l.x, l.y, l.z), base = P(l.x, l.y, l.floorZ);
      if (!top || l.floorZ >= cut - 0.05) continue;
      if (l.aim && !l.dim) this.beam(items, P, l);
      if (l.linked) { this.fixtures(items, P, l, col); continue; }
      for (const p of l.parts) {
        const pp = P(p.x, p.y, p.z);
        if (pp) items.push({ depth: pp.depth, draw: () => this.dot(pp, Math.max(2.5, 0.09 * pp.scale), p.sel ? col.accent : col.info, l.dim) });
      }
      items.push({ depth: top.depth, draw: () => {
        ctx.globalAlpha = l.dim ? 0.3 : 1;
        if (base) {
          this.line(base, top, l.sel ? col.accent : col.faint, l.sel ? 2 : 1, l.sel ? [] : [3, 3]);
          this.dot(base, Math.max(2, 0.08 * base.scale), l.sel ? col.accent : col.faint, l.dim);
        }
        const r = Math.max(5, (l.sel ? 0.3 : 0.22) * top.scale);
        if (l.on || l.sel) {
          const glow = ctx.createRadialGradient(top.x, top.y, 0, top.x, top.y, r * 3);
          glow.addColorStop(0, hexA(l.sel ? col.accent : "#f5c25a", 0.45));
          glow.addColorStop(1, hexA(l.sel ? col.accent : "#f5c25a", 0));
          ctx.fillStyle = glow;
          ctx.beginPath(); ctx.arc(top.x, top.y, r * 3, 0, Math.PI * 2); ctx.fill();
        }
        if (l.form) this.drawBar(l, P, col);
        ctx.beginPath(); ctx.arc(top.x, top.y, r, 0, Math.PI * 2);
        ctx.fillStyle = l.sel ? col.accent : l.on ? "#d9a441" : col.faint;
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = col.bg; ctx.stroke();
        this.glyph(l.icon, top.x, top.y, r);
        if (l.sel || l.hover || (!l.dim && this.scene.labels)) this.text(l.label, top.x, top.y - r - 6, col.text, 12, "center", true);
        ctx.globalAlpha = 1;
        l._screen = { x: top.x, y: top.y, r: r + 6, ppm: base && l.z !== l.floorZ ? Math.abs(base.y - top.y) / Math.abs(l.z - l.floorZ) : null };
      } });
    }
    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) it.draw();
    if (this.mode === "shape") { this.drawBlockHandles(col); this.drawYardHandles(); }
    // dimensions, when shown: each block's width × depth over its top, and its height
    for (const dm of s.dims || []) {
      const p = P(dm.at.x, dm.at.y, dm.at.z);
      if (p && dm.at.z <= cut + 0.05 + (dm.top ? 0.01 : 0)) this.text(dm.text, p.x, p.y, "#ffffff", 12, "center", true);
    }
    this.drawCube(col, W);
    // a hint (the page shows it under the view on narrow screens)
    if (W >= 520) this.text(this.aimMode ? "Aim: click what the light should point at (a wall, the ground, a tree)"
      : this.mode === "shape" ? "Shape: drag a yellow handle to size · drag the block to move it, Shift+drag up and down, or drag an arrow · Alt: no snapping"
      : this.mode === "raise" ? "Raise: drag the picked light up or down" : "Drag to turn · right-drag or wheel-drag to slide · scroll or pinch to zoom · drag the picked light to move it",
      12, H - 12, col.muted, 12, "left");
  }

  // The solid ground: everything round the house, with a hole where a block goes into it
  solidGround(P, col, gx0, gx1, gy0, gy1) {
    const ctx = this.ctx;
    const outer = [P(gx0, gy0, 0), P(gx1, gy0, 0), P(gx1, gy1, 0), P(gx0, gy1, 0)];
    if (outer.some((q) => !q)) return;
    ctx.beginPath(); outer.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
    for (const b of (this.scene.massing && this.scene.massing.blocks) || []) {
      if (b.z0 > -0.01) continue;
      const y0 = b.y0 || 0, y1 = y0 + b.depth;
      const h = [P(b.x0, y0, 0), P(b.x1, y0, 0), P(b.x1, y1, 0), P(b.x0, y1, 0)];
      if (h.some((q) => !q)) continue;
      h.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
    }
    ctx.fillStyle = "#1f2a22"; ctx.fill("evenodd");
  }

  // The block a point is in (the smallest, where blocks overlap), or -1
  roomOf(x, y, z) {
    const m = this.scene.massing;
    if (!m) return -1;
    let best = -1, vol = Infinity;
    m.blocks.forEach((b, i) => {
      const y0 = b.y0 || 0;
      if (x < b.x0 - 0.02 || x > b.x1 + 0.02 || y < y0 - 0.02 || y > y0 + b.depth + 0.02 || z < b.z0 - 0.05 || z > b.z1) return;
      const v = (b.x1 - b.x0) * b.depth * (b.z1 - b.z0);
      if (v < vol) { vol = v; best = i; }
    });
    return best;
  }

  // Where a level's floor lies: under each block in it (its own level, or one it spans), within
  // its stretch across. {own: true} when there were blocks to go by.
  floorSpans(f, x0, x1) {
    const m = this.scene.massing;
    const out = [];
    if (m) for (const b of m.blocks) {
      // its own blocks; a block set to another level isn't in this one, even if it's tall enough
      const inIt = b.level ? b.level === f.id : b.z0 <= f.elevation + 0.05 && b.z1 >= f.elevation + 0.3;
      if (!inIt) continue;
      const a = Math.max(b.x0, x0), c = Math.min(b.x1, x1);
      if (c - a < 0.1) continue;
      out.push({ x0: a, x1: c, y0: b.y0 || 0, y1: (b.y0 || 0) + b.depth, own: true, room: m.blocks.indexOf(b) });
    }
    return out;
  }

  // ---- flat yard shapes (paths, driveways, patios...): picked and edited in Shape -------------
  // The flat shape under a screen point, the last drawn (on top) first
  hitYard(sx, sy) {
    const t = this.scene.top;
    if (!t) return null;
    const at = this.onPlane(sx, sy, 0.01);
    if (!at) return null;
    for (const y of [...t.yard].reverse()) {
      if (y.c) continue;
      if (flatPolys(y).some((poly) => inPoly(at.x, at.y, poly))) return y.id;
    }
    return null;
  }
  // Stairs under a screen point: on their lower floor, inside their footprint
  hitStairs(sx, sy) {
    const t = this.scene.top;
    if (!t) return null;
    const levels = new Map(this.scene.floors.map((f) => [f.id, f]));
    for (const st of t.stairs || []) {
      if (!st.id) continue;
      const a = st.z0 != null ? st.z0 : (levels.get(st.level) || {}).elevation, b = st.z1 != null ? st.z1 : (levels.get(st.to) || {}).elevation;
      if (a == null || b == null) continue;
      // any height up the flight: check a few
      for (const k of [0.15, 0.5, 0.85]) {
        const at = this.onPlane(sx, sy, a + (b - a) * k);
        if (at && at.x >= st.x0 && at.x <= st.x1 && at.y >= st.y0 && at.y <= st.y1) return { id: st.id, z: a + (b - a) * k };
      }
    }
    return null;
  }
  // The picked flat shape's corners: [{part, i, at}] (part -1 is its own line or outline)
  yardCorners() {
    const t = this.scene.top, id = this.scene.selYard;
    const y = t && id && t.yard.find((q) => q.id === id);
    if (!y || !y.pts) return [];
    const out = y.pts.map((q, i) => ({ part: -1, i, at: q }));
    (y.parts || []).forEach((pts, part) => pts.forEach((q, i) => out.push({ part, i, at: q })));
    return out;
  }
  hitYardCorner(pt) {
    for (const c of this.yardCorners()) { const q = this.project({ x: c.at[0], y: c.at[1], z: 0.01 }); if (q && Math.hypot(q.x - pt.x, q.y - pt.y) <= 10) return c; }
    return null;
  }
  drawYardHandles() {
    const ctx = this.ctx;
    for (const c of this.yardCorners()) {
      const q = this.project({ x: c.at[0], y: c.at[1], z: 0.01 });
      if (!q) continue;
      ctx.beginPath(); ctx.rect(q.x - 6, q.y - 6, 12, 12); ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#ff8a3d"; ctx.stroke();
    }
  }

  // ---- windows and doors: on the front wall of their block -----------------------------------
  openingY(o) {
    if (o.y !== undefined) return o.y;
    const blk = this.scene.massing.blocks.find((b) => (o.x0 + o.x1) / 2 >= b.x0 && (o.x0 + o.x1) / 2 <= b.x1);
    return blk ? blk.y0 || 0 : 0;
  }
  // The window or door under a screen point, nearest first
  hitOpening(sx, sy) {
    const m = this.scene.massing;
    if (!m) return null;
    let best = null;
    for (const o of m.openings) {
      if (!o.id) continue;
      const y = this.openingY(o);
      const q = [[o.x0, o.z0], [o.x1, o.z0], [o.x1, o.z1], [o.x0, o.z1]].map(([x, z]) => this.project({ x, y, z }));
      if (q.some((p) => !p)) continue;
      let inside = false;
      for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
        if ((q[i].y > sy) !== (q[j].y > sy) && sx < ((q[j].x - q[i].x) * (sy - q[i].y)) / (q[j].y - q[i].y) + q[i].x) inside = !inside;
      }
      const depth = q.reduce((a, p) => a + p.depth, 0) / 4;
      if (inside && (!best || depth < best.depth)) best = { id: o.id, depth };
    }
    return best ? best.id : null;
  }
  // Where a screen point meets the upright plane y (a front wall): {x, z}
  onWall(sx, sy, y) {
    const cam = this.cam, d = this.ray(sx, sy, cam);
    if (Math.abs(d.y) < 1e-6) return null;
    const t = (y - cam.pos.y) / d.y;
    if (t <= 0) return null;
    return { x: cam.pos.x + d.x * t, z: cam.pos.z + d.z * t };
  }

  // ---- blocks: picking one and dragging its faces (Shape) --------------------------------------

  selectedBlock() {
    const m = this.scene.massing;
    return m && this.scene.selBlock ? m.blocks.find((b) => b.id === this.scene.selBlock) || null : null;
  }
  // The faces of the picked block that can be dragged: where the handle is, which way is out
  blockFaces(b) {
    const y0 = b.y0 || 0, y1 = y0 + b.depth, ym = (y0 + y1) / 2, xm = (b.x0 + b.x1) / 2, zm = (b.z0 + b.z1) / 2;
    const faces = [
      { face: "x1", label: "Right side", at: { x: b.x1, y: ym, z: zm }, axis: { x: 1, y: 0, z: 0 } },
      { face: "x0", label: "Left side", at: { x: b.x0, y: ym, z: zm }, axis: { x: -1, y: 0, z: 0 } },
      { face: "depth", label: "Back", at: { x: xm, y: y1, z: zm }, axis: { x: 0, y: 1, z: 0 } },
      { face: "z1", label: "Top", at: { x: xm, y: ym, z: b.z1 }, axis: { x: 0, y: 0, z: 1 } },
      { face: "z0", label: "Bottom", at: { x: xm, y: ym, z: b.z0 }, axis: { x: 0, y: 0, z: -1 } },
    ];
    faces.push({ face: "y0", label: "Front", at: { x: xm, y: y0, z: zm }, axis: { x: 0, y: -1, z: 0 } });
    return faces;
  }
  drawBlockHandles(col) {
    const b = this.selectedBlock();
    this._handles = [];
    if (!b) return;
    const ctx = this.ctx;
    for (const f of this.blockFaces(b)) {
      const p = this.project(f.at), q = this.project(add(f.at, scale(f.axis, 0.8)));
      if (!p || !q) continue;
      const active = this.drag && this.drag.kind === "face" && this.drag.face.face === f.face;
      ctx.save();
      ctx.strokeStyle = active ? "#ff8a3d" : "#ffd166"; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      // an arrow head pointing out of the face
      const a = Math.atan2(q.y - p.y, q.x - p.x);
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - 9 * Math.cos(a - 0.45), q.y - 9 * Math.sin(a - 0.45)); ctx.lineTo(q.x - 9 * Math.cos(a + 0.45), q.y - 9 * Math.sin(a + 0.45)); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.stroke();
      ctx.restore();
      this._handles.push({ ...f, p, q });
    }
    if (b.behind) this.drawAxes(b);
    const mv = this.drag && ["blockMove", "blockLift", "axisMove"].includes(this.drag.kind) && this.drag.moved ? this.drag : null;
    if (mv) {
      const parts = [["across", mv.dx], ["back", mv.dy], ["up", mv.dz]].filter(([, v]) => Math.abs(v || 0) >= 0.005)
        .map(([name, v]) => `${name} ${v >= 0 ? "+" : "−"}${L.fmtLen(Math.abs(v))}`);
      const p = this.project({ x: (b.x0 + b.x1) / 2, y: (b.y0 || 0) + b.depth / 2, z: b.z1 });
      if (p && parts.length) this.text(parts.join(" · "), p.x + 12, p.y - 14, "#ffd166", 13, "left", true);
    }
    if (this.drag && this.drag.kind === "face" && this.drag.delta !== undefined) {
      const d = this.drag, p = this.project(d.face.at);
      if (p) {
        const sign = d.delta >= 0 ? "+" : "−";
        this.text(`${d.face.label} ${sign}${L.fmtLen(Math.abs(d.delta))}`, p.x + 12, p.y - 12, "#ffd166", 13, "left", true);
      }
    }
  }
  // Red (across, X), green (back, Y) and blue (up, Z) arrows from the block's front left bottom
  // corner (away from the face handles in the middle of each face): drag one to move the block
  // that way only
  blockAxes(b) {
    const from = { x: b.x0, y: b.y0 || 0, z: b.z0 };
    const len = Math.max(0.8, Math.min(1.8, Math.min(b.x1 - b.x0, b.depth, b.z1 - b.z0) * 0.6));
    return [
      { name: "across", color: "#ff5d6c", from, axis: { x: 1, y: 0, z: 0 }, len },
      { name: "back", color: "#7bc47f", from, axis: { x: 0, y: 1, z: 0 }, len },
      { name: "up", color: "#5aa9e6", from, axis: { x: 0, y: 0, z: 1 }, len },
    ];
  }
  drawAxes(b) {
    const ctx = this.ctx;
    this._axes = [];
    for (const a of this.blockAxes(b)) {
      const p = this.project(a.from), q = this.project(add(a.from, scale(a.axis, a.len)));
      if (!p || !q) continue;
      const active = this.drag && this.drag.kind === "axisMove" && this.drag.axis.name === a.name;
      ctx.save(); ctx.strokeStyle = a.color; ctx.fillStyle = a.color; ctx.lineWidth = active ? 4 : 3;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      ctx.beginPath(); ctx.moveTo(q.x + 4 * Math.cos(ang), q.y + 4 * Math.sin(ang));
      ctx.lineTo(q.x - 10 * Math.cos(ang - 0.45), q.y - 10 * Math.sin(ang - 0.45)); ctx.lineTo(q.x - 10 * Math.cos(ang + 0.45), q.y - 10 * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill();
      ctx.restore();
      this._axes.push({ ...a, p, q });
    }
  }
  hitAxis(pt) {
    for (const a of this._axes || []) {
      const dx = a.q.x - a.p.x, dy = a.q.y - a.p.y, l2 = dx * dx + dy * dy;
      if (!l2) continue;
      const t = Math.max(0, Math.min(1, ((pt.x - a.p.x) * dx + (pt.y - a.p.y) * dy) / l2));
      if (t > 0.25 && Math.hypot(pt.x - (a.p.x + t * dx), pt.y - (a.p.y + t * dy)) <= 8) return a;
    }
    return null;
  }
  hitHandle(pt) {
    for (const h of this._handles || []) {
      if (Math.hypot(pt.x - h.p.x, pt.y - h.p.y) <= 12 || Math.hypot(pt.x - h.q.x, pt.y - h.q.y) <= 12) return h;
    }
    return null;
  }
  // Whether a screen point is over a block (even with others in front of it)
  rayHitsBlock(sx, sy, b) {
    const cam = this.cam;
    if (!cam) return false;
    const y0 = b.y0 || 0;
    return rayBox(cam.pos, this.ray(sx, sy, cam), [b.x0, y0, b.z0], [b.x1, y0 + b.depth, b.z1]) !== null;
  }
  // The block a screen point is on (nearest), or null
  hitBlock(sx, sy) {
    const cam = this.cam, m = this.scene.massing;
    if (!cam || !m) return null;
    const d = this.ray(sx, sy, cam);
    let best = null;
    for (const b of m.blocks) {
      const y0 = b.y0 || 0;
      const t = rayBox(cam.pos, d, [b.x0, y0, b.z0], [b.x1, y0 + b.depth, b.z1]);
      if (t !== null && (!best || t < best.t)) best = { t, id: b.id };
    }
    return best ? best.id : null;
  }

  // ---- the view cube: which way is up, and a click to look from a side, an edge or a corner ----

  cubeBox(W) { const r = 34; return { cx: W - 64, cy: 66, r }; }
  drawCube(col, W) {
    const cam = this.cam;
    if (!cam) return;
    const ctx = this.ctx, { cx, cy, r } = this.cubeBox(W);
    // the cube turns with the view, without perspective
    const P = (v) => ({ x: cx + (v.x * cam.r.x + v.y * cam.r.y + v.z * cam.r.z) * r, y: cy - (v.x * cam.u.x + v.y * cam.u.y + v.z * cam.u.z) * r, depth: v.x * cam.f.x + v.y * cam.f.y + v.z * cam.f.z });
    const faces = [
      { n: { x: 0, y: -1, z: 0 }, label: "FRONT", a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: 1 } },
      { n: { x: 0, y: 1, z: 0 }, label: "BACK", a: { x: -1, y: 0, z: 0 }, b: { x: 0, y: 0, z: 1 } },
      { n: { x: 1, y: 0, z: 0 }, label: "RIGHT", a: { x: 0, y: 1, z: 0 }, b: { x: 0, y: 0, z: 1 } },
      { n: { x: -1, y: 0, z: 0 }, label: "LEFT", a: { x: 0, y: -1, z: 0 }, b: { x: 0, y: 0, z: 1 } },
      { n: { x: 0, y: 0, z: 1 }, label: "TOP", a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } },
      { n: { x: 0, y: 0, z: -1 }, label: "BOTTOM", a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: -1, z: 0 } },
    ];
    const hover = this._cubeHover;
    const visible = faces.filter((f) => f.n.x * cam.f.x + f.n.y * cam.f.y + f.n.z * cam.f.z < -0.02);
    ctx.save();
    for (const f of visible) {
      const corner = (sa, sb) => P(add(f.n, add(scale(f.a, sa), scale(f.b, sb))));
      const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      ctx.fillStyle = col.card2; ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = col.line2; ctx.lineWidth = 1; ctx.stroke();
      // what the pointer is over: the face's middle, or a strip by an edge, or a corner
      if (hover && dotv(hover, f.n) > 0.5) {
        const ua = dotv(hover, f.a), ub = dotv(hover, f.b);
        const span = (k) => (k === 0 ? [-0.6, 0.6] : k > 0 ? [0.6, 1] : [-1, -0.6]);
        const [a0, a1] = span(ua), [b0, b1] = span(ub);
        const h = [corner(a0, b0), corner(a1, b0), corner(a1, b1), corner(a0, b1)];
        ctx.beginPath(); h.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
        ctx.fillStyle = col.accent; ctx.globalAlpha = 0.45; ctx.fill(); ctx.globalAlpha = 1;
      }
      // the face's name, laid on the face
      const o = P(f.n), ax = P(add(f.n, f.a)), bx = P(add(f.n, f.b));
      ctx.save();
      ctx.setTransform(...this._dprT((ax.x - o.x) / r, (ax.y - o.y) / r, -(bx.x - o.x) / r, -(bx.y - o.y) / r, o.x, o.y));
      ctx.font = `700 ${f.label.length > 4 ? 10 : 11}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillStyle = col.text; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(f.label, 0, 0);
      ctx.restore();
    }
    // X, Y and Z from the cube's front left bottom corner
    const origin = { x: -1, y: -1, z: -1 };
    for (const [axis, color, name] of [[{ x: 1, y: 0, z: 0 }, "#ff5d6c", "X"], [{ x: 0, y: 1, z: 0 }, "#7bc47f", "Y"], [{ x: 0, y: 0, z: 1 }, "#5aa9e6", "Z"]]) {
      const a = P(origin), b = P(add(origin, scale(axis, 2.7)));
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = color; ctx.font = `700 11px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(name, b.x + (b.x - a.x) * 0.12, b.y + (b.y - a.y) * 0.12);
    }
    // home: the usual view
    const home = { x: cx + r + 8, y: cy + r + 14 };
    ctx.fillStyle = col.muted; ctx.font = `600 15px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("⌂", home.x, home.y);
    this._home = home;
    ctx.restore();
  }
  _dprT(a, b, c, d, e, f) {
    const k = window.devicePixelRatio || 1;
    return [a * k, b * k, c * k, d * k, e * k, f * k];
  }
  // Which part of the cube is under a screen point: a direction with each of x, y, z in
  // {-1, 0, 1} (a face, an edge or a corner), or null
  cubeHit(pt) {
    const cam = this.cam;
    if (!cam) return null;
    const { cx, cy, r } = this.cubeBox(this.canvas.clientWidth);
    const sx = (pt.x - cx) / r, sy = -(pt.y - cy) / r;
    if (Math.hypot(sx, sy) > 1.9) return null;
    // a ray straight into the screen at that point, through the unit cube
    const o = add(add(scale(cam.r, sx), scale(cam.u, sy)), scale(cam.f, -5));
    const t = rayBox(o, cam.f, [-1, -1, -1], [1, 1, 1]);
    if (t === null) return null;
    const p = add(o, scale(cam.f, t));
    const k = (v) => (v > 0.6 ? 1 : v < -0.6 ? -1 : 0);
    const dir = { x: k(p.x), y: k(p.y), z: k(p.z) };
    return dir.x || dir.y || dir.z ? dir : null;
  }
  // Turn the view to look from a direction (smoothly)
  lookFrom(dir) {
    const n = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const d = { x: dir.x / n, y: dir.y / n, z: dir.z / n };
    const pitch = Math.asin(Math.max(-1, Math.min(1, d.z))) * 0.999;
    const flat = Math.hypot(d.x, d.y);
    // straight above or below: the front of the house at the bottom, as Fusion's Top does
    let yaw = flat > 1e-6 ? Math.atan2(d.x, -d.y) : 0;
    // the short way round
    while (yaw - this.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (yaw - this.yaw < -Math.PI) yaw += 2 * Math.PI;
    this.animateTo(yaw, Math.max(-1.55, Math.min(1.55, pitch)));
  }
  animateTo(yaw, pitch, pan = null) {
    const y0 = this.yaw, p0 = this.pitch, pan0 = { ...this.pan }, t0 = performance.now(), dur = 380;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.yaw = y0 + (yaw - y0) * e; this.pitch = p0 + (pitch - p0) * e;
      if (pan) this.pan = { x: pan0.x + (pan.x - pan0.x) * e, y: pan0.y + (pan.y - pan0.y) * e, z: pan0.z + (pan.z - pan0.z) * e };
      this.render();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Each block as translucent faces: four walls, and a gable (point to the street) or a ridge
  // (along the front) roof
  massing(items, P, col) {
    const WALL = "#5aa9e6", ROOF = "#8fb3d9", GLASS = "#9ad0f5";
    const solid = !!this.scene.solid;
    const face = (pts, color, alpha, strokeAlpha = 0.7, meta = {}) => {
      const q = pts.map(([x, y, z]) => P(x, y, z));
      const below = pts.every((p) => p[2] <= 0.001);
      items.push({ depth: avgDepth(q), below, ...meta, draw: () => this.poly(q, color, alpha, color, strokeAlpha) });
    };
    // a wall seen from inside its room (its outside faces away) is drawn before what's in the
    // room; one seen from outside, after
    const cam = this.cam;
    const side = (room, n, c) => ({ room, rank: n[0] * (cam.pos.x - c[0]) + n[1] * (cam.pos.y - c[1]) < 0 ? 1 : 4 });
    // the solid view: a block is a hollow room, its sides solid walls and its bottom a solid floor
    const SOLID = { wall: "#3a4554", floor: "#2b333e", edge: "#7fa6cc" };
    const solidFace = (pts, fill, meta = {}) => {
      const q = pts.map(([x, y, z]) => P(x, y, z));
      const below = pts.every((p) => p[2] <= 0.001);
      items.push({ depth: avgDepth(q), below, ...meta, draw: () => { this.poly(q, fill, 0.97, SOLID.edge, 0.55); } });
    };
    // an upright face from z0 to z1, in two where it goes into the ground
    const wallFace = (a, b, z0, z1, meta) => {
      const parts = z0 < 0 && z1 > 0 ? [[z0, 0], [0, z1]] : [[z0, z1]];
      for (const [lo, hi] of parts) solidFace([[a[0], a[1], lo], [b[0], b[1], lo], [b[0], b[1], hi], [a[0], a[1], hi]], SOLID.wall, meta);
    };
    // A block that goes into the ground (a basement) leaves a hole in the grid where it goes in
    for (const b of this.scene.massing.blocks) {
      if (solid || b.z0 > -0.01) continue;
      const y0 = b.y0 || 0, y1 = y0 + b.depth;
      const hole = [P(b.x0, y0, 0), P(b.x1, y0, 0), P(b.x1, y1, 0), P(b.x0, y1, 0)];
      this.poly(hole, col.bg, 0.92, col.line2, 1);
    }
    const cut = this.scene.cutZ ?? Infinity;
    const selB = this.scene.massing.blocks.find((q) => q.id === this.scene.selBlock);
    const picks = this.scene.blockPicks || [];
    this.scene.massing.blocks.forEach((b, bi) => {
      const { x0, x1, z0, z1 } = b;
      if (z0 >= cut - 0.05) return;
      const y0 = b.y0 || 0, y1 = y0 + b.depth;
      const W = { y0: side(bi, [0, -1], [(x0 + x1) / 2, y0]), y1: side(bi, [0, 1], [(x0 + x1) / 2, y1]), x0: side(bi, [-1, 0], [x0, (y0 + y1) / 2]), x1: side(bi, [1, 0], [x1, (y0 + y1) / 2]) };
      // the faces it shares with a block it's joined to aren't walls
      const inner = joinedFaces(b, this.scene.massing.blocks);
      const inGroup = selB && b.id !== selB.id && b.group && b.group === selB.group;
      if (inGroup || (picks.includes(b.id) && b.id !== this.scene.selBlock)) {
        const P8 = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(([x, y, z]) => P(x, y, z));
        const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
        items.push({ depth: -1e9, draw: () => { for (const [i, j] of E) this.line(P8[i], P8[j], inGroup ? "#ffd166" : "#ffffff", inGroup ? 1.5 : 2, inGroup ? [5, 4] : []); } });
      }
      if (b.id && b.id === this.scene.selBlock) {
        // the block picked in Shape: its outline in the accent colour
        const P8 = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(([x, y, z]) => P(x, y, z));
        const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
        items.push({ depth: -1e9, draw: () => { for (const [i, j] of E) this.line(P8[i], P8[j], "#ffd166", 2); } });
      }
      if (solid) {
        // walls cut off at the level shown, like a dollhouse with the floors above lifted off
        const top = Math.min(z1, cut);
        if (!inner.y0) wallFace([x0, y0], [x1, y0], z0, top, W.y0);
        if (!inner.y1) wallFace([x1, y1], [x0, y1], z0, top, W.y1);
        if (!inner.x0) wallFace([x0, y1], [x0, y0], z0, top, W.x0);
        if (!inner.x1) wallFace([x1, y0], [x1, y1], z0, top, W.x1);
        solidFace([[x0, y0, z0 + 0.005], [x1, y0, z0 + 0.005], [x1, y1, z0 + 0.005], [x0, y1, z0 + 0.005]], SOLID.floor, { room: bi, rank: 0 });
      } else {
        if (!inner.y0) face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], WALL, 0.08, 0.7, W.y0);
        if (!inner.y1) face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], WALL, 0.06, 0.45, W.y1);
        if (!inner.x0) face([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], WALL, 0.06, 0.55, W.x0);
        if (!inner.x1) face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], WALL, 0.06, 0.55, W.x1);
      }
      const lab = P(x0 + 0.2, y0, z1 + 0.15);
      if (lab && b.name) items.push({ depth: lab.depth - 0.01, draw: () => this.text(b.name, lab.x, lab.y, col.muted, 11, "left") });
    });
    // Roofs: the outline seen from the street, taken back as each one says
    for (const r of this.scene.massing.roofs || []) {
      const zs = r.pts.map((q) => q[1]);
      // the solid view is a dollhouse: roofs off, to look down into the rooms
      if (solid || Math.min(...zs) >= cut - 0.05) continue;
      const ze = Math.min(...zs), h = Math.max(...zs) - ze || 1;
      const y0 = r.y0 || 0, d = r.depth;
      const ry = r.back === "shed" ? d : r.ridge_y;
      const front = r.pts.map(([x, z]) => [x, r.back === "extrude" ? y0 : y0 + ((z - ze) / h) * ry, z]);
      const back = r.pts.map(([x, z]) => [x, r.back === "ridge" ? y0 + d - ((z - ze) / h) * (d - ry) : y0 + d, z]);
      face(front, ROOF, 0.12);
      face(back, ROOF, 0.08, 0.45);
      for (let i = 0; i < front.length; i++) {
        const j = (i + 1) % front.length;
        face([front[i], front[j], back[j], back[i]], ROOF, 0.07, 0.4);
      }
      const top = front.reduce((a, b) => (b[2] > a[2] ? b : a));
      const lab = P(top[0], top[1], top[2] + 0.2);
      if (lab && r.name) items.push({ depth: lab.depth - 0.01, draw: () => this.text(r.name, lab.x, lab.y, col.muted, 11, "center") });
    }
    // Spaces with their own floor (a landing, storage over the entry): a slab at that height
    const levels = new Map(this.scene.floors.map((f) => [f.id, f]));
    for (const b of this.scene.massing.blocks) {
      if (!b.level || !b.offset || !levels.has(b.level)) continue;
      const z = levels.get(b.level).elevation + b.offset;
      const y0 = b.y0 || 0, y1 = y0 + b.depth;
      face([[b.x0, y0, z], [b.x1, y0, z], [b.x1, y1, z], [b.x0, y1, z]], "#f0b429", 0.12, 0.8);
    }
    // The front of the house along the ground, from the ground line's bends
    const foot = this.scene.massing.footprint;
    if (foot && foot.length > 1) {
      const q = foot.map(([x, y]) => P(x, y, 0.02));
      items.push({ depth: avgDepth(q) - 0.02, draw: () => { for (let i = 0; i + 1 < q.length; i++) this.line(q[i], q[i + 1], "#7bc47f", 2); } });
    }
    // windows and doors sit on the front wall of the block they're in
    for (const o of this.scene.massing.openings) {
      if (o.z0 >= cut - 0.05) continue;
      const y = this.openingY(o) - 0.02;
      const sel = this.scene.selOpening && o.id === this.scene.selOpening;
      const room = this.roomOf((o.x0 + o.x1) / 2, y + 0.05, (o.z0 + o.z1) / 2);
      face([[o.x0, y, o.z0], [o.x1, y, o.z0], [o.x1, y, o.z1], [o.x0, y, o.z1]], sel ? "#ff8a3d" : GLASS, sel ? 0.4 : o.kind === "window" ? 0.22 : 0.14, 0.9, { room, rank: 5 });
    }
  }

  // The top view's drawing: the yard on the ground, the outside walls, each level's walls
  topView(items, P, col) {
    const t = this.scene.top;
    const COLORS = { path: "#c9c2b4", driveway: "#9aa0a6", patio: "#d4a373", pool: "#4cc3f0", bed: "#8d6e4f", lawn: "#6fbf73", tree: "#3f9d4a", bush: "#7cc576", other: "#b0b8c4" };
    const later = (fn) => (this._flat ? this._flat.push(fn) : fn());
    const ground = (pts, color, alpha) => { const q = pts.map(([x, y]) => P(x, y, 0.01)); if (q.every(Boolean)) later(() => this.poly(q, color, alpha, color, 0.8)); };
    // flat things first, drawn straight onto the ground
    for (const y of t.yard) {
      const c = COLORS[y.kind] || "#b0b8c4";
      if (y.c) continue;
      const sel = this.scene.selYard === y.id || (this.scene.yardPicks || []).includes(y.id);
      const polys = flatPolys(y).map((poly) => poly.map(([x, yy]) => P(x, yy, 0.01)));
      if (polys.some((q) => !q.every(Boolean))) continue;
      const alpha = (y.kind === "path" ? 0.55 : y.kind === "pool" ? 0.45 : 0.3) + (sel ? 0.2 : 0);
      later(() => unionPolys(this.ctx, polys, hexA(c, alpha), sel ? "#ff8a3d" : hexA(c, 0.8), sel ? 2.5 : 1));
    }
    for (const y of t.yard) {
      if (!y.c) continue;
      const c = COLORS[y.kind];
      const ring = (z, r) => Array.from({ length: 16 }, (_, i) => [y.c[0] + Math.cos(i / 16 * Math.PI * 2) * r, y.c[1] + Math.sin(i / 16 * Math.PI * 2) * r, z]);
      const h = y.h ?? (y.kind === "tree" ? Math.max(3, y.r * 1.6) : Math.max(0.6, y.r));
      const trunk = [P(y.c[0], y.c[1], 0), P(y.c[0], y.c[1], h * 0.45)];
      items.push({ depth: depthOf(trunk[0], trunk[1]), draw: () => { if (y.kind === "tree") this.line(trunk[0], trunk[1], "#8d6e4f", 2); } });
      for (const z of [h * (y.kind === "tree" ? 0.55 : 0.2), h * 0.8]) {
        const q = ring(z, y.r * (z === h * 0.8 ? 0.7 : 1)).map(([a, b, cz]) => P(a, b, cz));
        items.push({ depth: avgDepth(q), draw: () => this.poly(q, c, 0.18, c, 0.6) });
      }
    }
    // the outside walls from above: an outline on the ground (the blocks show the walls)
    if (t.plan) {
      const q = t.plan.map(([x, y]) => P(x, y, 0.02));
      if (q.every(Boolean)) items.push({ depth: avgDepth(q) + 0.05, draw: () => this.poly(q, col.card2, 0, "#dce2ea", 0.7) });
    }
    const levels = new Map(this.scene.floors.map((f) => [f.id, f]));
    // stairs: a flight of steps from one level's floor to the other's
    for (const st of t.stairs || []) {
      const f0 = st.z0 != null ? { elevation: st.z0 } : levels.get(st.level), f1 = st.z1 != null ? { elevation: st.z1 } : levels.get(st.to);
      if (!f0 || !f1) continue;
      if (Math.min(f0.elevation, f1.elevation) >= (this.scene.cutZ ?? Infinity) - 0.05) continue;
      const pickedStair = this.scene.selStair && st.id === this.scene.selStair;
      const along = st.dir[0], sign = st.dir[1] === "+" ? 1 : -1;
      const lo = along === "x" ? st.x0 : st.y0, hi = along === "x" ? st.x1 : st.y1;
      // as the Top view's panel has them: typed steps and step height, else from the levels
      const z0 = f0.elevation, z1 = f1.elevation, rise = Math.abs(z1 - z0);
      const n = st.steps || (rise ? Math.max(1, Math.round(rise / 0.19) - 1) : 1);
      const riser = (st.riser || rise / (n + 1)) * Math.sign(z1 - z0 || 1);
      const run = (hi - lo) / n;
      for (let k = 0; k < n; k++) {
        const s0 = sign > 0 ? lo + k * run : hi - (k + 1) * run, s1 = s0 + run;
        const z = z0 + riser * (k + 1);
        const q = along === "x"
          ? [P(s0, st.y0, z), P(s1, st.y0, z), P(s1, st.y1, z), P(s0, st.y1, z)]
          : [P(st.x0, s0, z), P(st.x1, s0, z), P(st.x1, s1, z), P(st.x0, s1, z)];
        if (q.every(Boolean)) items.push({ depth: avgDepth(q), room: this.roomOf((st.x0 + st.x1) / 2, (st.y0 + st.y1) / 2, Math.min(z0, z1) + 0.1), rank: 3, draw: () => this.poly(q, pickedStair ? "#ff8a3d" : "#f0b429", pickedStair ? 0.5 : 0.22, pickedStair ? "#ff8a3d" : "#f0b429", 0.8) });
      }
    }
    // interior walls: a see-through panel from each level's floor to its ceiling
    const cutW = this.scene.cutZ ?? Infinity;
    for (const w of t.walls) {
      const f = levels.get(w.level);
      if (!f || f.elevation >= cutW - 0.05) continue;
      // the solid view shows the plan of the level it's cut at, not those under its floor
      if (this.scene.solid && !f.active && this.scene.cutZ != null) continue;
      const z0 = f.elevation, z1 = Math.min(f.elevation + f.ceiling, cutW);
      const q = [P(w.a[0], w.a[1], z0), P(w.b[0], w.b[1], z0), P(w.b[0], w.b[1], z1), P(w.a[0], w.a[1], z1)];
      const active = f.active;
      const room = this.roomOf((w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2, z0 + 0.1);
      items.push({ depth: avgDepth(q), room, rank: 3, draw: () => this.poly(q, "#dce2ea", active ? 0.14 : 0.05, "#dce2ea", active ? 0.6 : 0.2) });
    }
  }

  // A light that is several fixtures on one switch: each fixture an orb with its drop line, all
  // joined by a dashed line in order
  fixtures(items, P, l, col) {
    const pts = l.parts.map((p) => ({ p, top: P(p.x, p.y, p.z), base: P(p.x, p.y, l.floorZ) })).filter((q) => q.top);
    l._screen = null;
    l._parts = [];
    if (pts.length > 1) items.push({ depth: avgDepth(pts.map((q) => q.top)) - 0.02, draw: () => {
      const ctx = this.ctx;
      ctx.save(); ctx.globalAlpha = l.dim ? 0.3 : 0.9; ctx.setLineDash([6, 5]); ctx.lineWidth = l.sel ? 2 : 1.5;
      ctx.strokeStyle = l.sel ? col.accent : "#d9a441";
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.top.x, q.top.y) : ctx.moveTo(q.top.x, q.top.y))); ctx.stroke();
      ctx.restore();
    } });
    for (const q of pts) {
      items.push({ depth: q.top.depth, draw: () => {
        const ctx = this.ctx, top = q.top, sel = l.sel && q.p.sel;
        ctx.globalAlpha = l.dim ? 0.3 : 1;
        if (q.base) this.line(q.base, top, sel ? col.accent : col.faint, 1, [3, 3]);
        const r = Math.max(4, (sel ? 0.24 : 0.17) * top.scale);
        if (l.on || l.sel) {
          const glow = ctx.createRadialGradient(top.x, top.y, 0, top.x, top.y, r * 2.6);
          glow.addColorStop(0, hexA(l.sel ? col.accent : "#f5c25a", 0.4)); glow.addColorStop(1, hexA(l.sel ? col.accent : "#f5c25a", 0));
          ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(top.x, top.y, r * 2.6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(top.x, top.y, r, 0, Math.PI * 2);
        ctx.fillStyle = sel ? col.accent : l.sel ? "#e6a466" : l.on ? "#d9a441" : col.faint; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = col.bg; ctx.stroke();
        this.glyph(l.icon, top.x, top.y, r);
        ctx.globalAlpha = 1;
        l._parts.push({ index: q.p.index, x: top.x, y: top.y, r: r + 6 });
      } });
    }
    const first = pts[0];
    if (first && (l.sel || this.scene.labels)) items.push({ depth: first.top.depth - 0.03, draw: () => this.text(l.label, first.top.x, first.top.y - 16, col.text, 12, "center", true) });
  }

  // What a screen point looks at: the nearest of the ground, a house block's walls, a tree or
  // bush. Returns { p: {x, y, z}, what } or null.
  raycast(sx, sy) {
    const cam = this.cam, s = this.scene;
    if (!cam || !s) return null;
    const o = cam.pos, d = this.ray(sx, sy, cam);
    let best = null;
    const take = (t, what) => { if (t > 0.05 && (!best || t < best.t)) best = { t, what }; };
    if (Math.abs(d.z) > 1e-9) take(-o.z / d.z, "the ground");
    for (const b of (s.massing && s.massing.blocks) || []) {
      const y0 = b.y0 || 0;
      const t = rayBox(o, d, [b.x0, y0, b.z0], [b.x1, y0 + b.depth, b.z1]);
      if (t !== null) take(t, `the ${b.name || "house"} wall`);
    }
    for (const y of (s.top && s.top.yard) || []) {
      if (!y.c) continue;
      const h = y.h ?? (y.kind === "tree" ? Math.max(3, y.r * 1.6) : Math.max(0.6, y.r));
      const t = raySphere(o, d, { x: y.c[0], y: y.c[1], z: h * (y.kind === "tree" ? 0.65 : 0.5) }, y.r * (y.kind === "tree" ? 0.8 : 1));
      if (t !== null) take(t, y.name ? `the ${y.name}` : `the ${y.kind}`);
    }
    if (!best) return null;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return { p: { x: r3(o.x + d.x * best.t), y: r3(o.y + d.y * best.t), z: r3(Math.max(0, o.z + d.z * best.t)) }, what: best.what };
  }

  // A light's beam: a faint cone from the light the way it points
  beam(items, P, l) {
    const a = l.aim;
    const h = (a.heading || 0) * Math.PI / 180, t = (a.tilt || 0) * Math.PI / 180;
    const dir = [-Math.sin(h) * Math.cos(t), -Math.cos(h) * Math.cos(t), Math.sin(t)];
    // two directions square to it, for the cone's rim
    const up = Math.abs(dir[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nrm = (v) => { const n = Math.hypot(...v) || 1; return v.map((c) => c / n); };
    const e1 = nrm(cr(dir, up)), e2 = nrm(cr(dir, e1));
    const len = 2.5, half = Math.min(75, a.beam / 2) * Math.PI / 180, r = Math.tan(half) * len;
    // each line out of the light stops at the first wall (or the floor) in its way
    const walls = this.obstacles(l.floor, l.floorZ);
    const clip = (v, max) => { const n = Math.hypot(...v) || 1, u = v.map((c) => c / n); const t = Math.min(max, this.rayHit3d(l, u, max, walls, l.floorZ)); return P(l.x + u[0] * t, l.y + u[1] * t, l.z + u[2] * t); };
    const rim = Array.from({ length: 18 }, (_, i) => {
      const k = (i / 18) * Math.PI * 2, c = Math.cos(k) * r, s = Math.sin(k) * r;
      const v = [dir[0] * len + e1[0] * c + e2[0] * s, dir[1] * len + e1[1] * c + e2[1] * s, dir[2] * len + e1[2] * c + e2[2] * s];
      return clip(v, Math.hypot(...v));
    });
    const apex = P(l.x, l.y, l.z);
    if (!apex || rim.some((q) => !q)) return;
    if (a.at) {
      const spot = P(a.at.x, a.at.y, a.at.z);
      if (spot) items.push({ depth: spot.depth - 0.05, draw: () => {
        const ctx = this.ctx;
        ctx.save(); ctx.strokeStyle = l.sel ? "#ff8a3d" : "#f5c25a"; ctx.globalAlpha = l.sel ? 0.9 : 0.5;
        ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(apex.x, apex.y); ctx.lineTo(spot.x, spot.y); ctx.stroke(); ctx.setLineDash([]);
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(spot.x, spot.y, Math.max(5, 0.25 * spot.scale), 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(spot.x, spot.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
        ctx.restore();
      } });
    }
    const color = l.sel ? "#ff8a3d" : "#f5c25a";
    items.push({ depth: avgDepth(rim) + 0.1, draw: () => {
      const ctx = this.ctx;
      ctx.save(); ctx.globalAlpha = l.sel ? 0.22 : 0.12; ctx.fillStyle = color;
      for (let i = 0; i < rim.length; i++) { const b = rim[i], c = rim[(i + 1) % rim.length]; ctx.beginPath(); ctx.moveTo(apex.x, apex.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.fill(); }
      ctx.globalAlpha = l.sel ? 0.8 : 0.4; ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); rim.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
      // the middle of the beam
      const mid = clip(dir, len);
      if (mid) { ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(apex.x, apex.y); ctx.lineTo(mid.x, mid.y); ctx.stroke(); }
      ctx.restore();
    } });
  }

  // What light can't pass on a level: its interior walls (floor to ceiling) and every block's
  // walls, as upright rectangles {a, b, z0, z1}
  obstacles(level, floorZ) {
    const out = [];
    const t = this.scene.top, m = this.scene.massing;
    const f = this.scene.floors.find((q) => q.id === level);
    if (t && f) for (const w of t.walls || []) if (w.level === level) out.push({ a: w.a, b: w.b, z0: f.elevation, z1: f.elevation + f.ceiling });
    if (m) for (const b of m.blocks) {
      if (b.z1 <= floorZ + 0.05 || b.z0 > floorZ + 2.5) continue;
      const y0 = b.y0 || 0, y1 = y0 + b.depth;
      const c = [[b.x0, y0], [b.x1, y0], [b.x1, y1], [b.x0, y1]];
      for (let i = 0; i < 4; i++) out.push({ a: c[i], b: c[(i + 1) % 4], z0: b.z0, z1: b.z1 });
    }
    return out;
  }
  // How far a flat ray from (x, y) goes before a wall at height z (up to max)
  wallHit2d(x, y, dx, dy, max, walls, z) {
    let best = max;
    for (const w of walls) {
      if (z < w.z0 || z > w.z1) continue;
      const t = segT(x, y, dx, dy, w.a, w.b);
      if (t > 0.02 && t < best) best = t;
    }
    return best;
  }
  // How far a ray from the light (unit u) goes before a wall it meets at a height the wall has,
  // or the floor under it
  rayHit3d(o, u, max, walls, floorZ) {
    let best = max;
    if (u[2] < -1e-6) best = Math.min(best, (floorZ - o.z) / u[2]);
    const flat = Math.hypot(u[0], u[1]);
    if (flat < 1e-6) return best;
    for (const w of walls) {
      const s = segT(o.x, o.y, u[0] / flat, u[1] / flat, w.a, w.b);
      if (!(s > 0.02)) continue;
      const t = s / flat, z = o.z + u[2] * t;
      if (t < best && z >= w.z0 - 0.01 && z <= w.z1 + 0.01) best = t;
    }
    return best;
  }
  // A bar or strip light: drawn its length, the way it lies, with short marks the way it shines
  drawBar(l, P, col) {
    const f = l.form, th = (f.rot || 0) * Math.PI / 180;
    const ux = Math.cos(th), uy = -Math.sin(th), h = f.length / 2;
    const a = P(l.x - ux * h, l.y - uy * h, l.z), b = P(l.x + ux * h, l.y + uy * h, l.z);
    if (!a || !b) return;
    const ctx = this.ctx, color = l.sel ? col.accent : l.on ? "#ffd28a" : col.faint;
    ctx.save(); ctx.lineCap = "round"; ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(4, 0.07 * (a.scale + b.scale) / 2);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // which way it shines: down, up, or out to one side
    const out = f.face === "up" ? [0, 0, 0.18] : f.face === "side" ? [-Math.sin(th) * 0.18, -Math.cos(th) * 0.18, 0] : [0, 0, -0.18];
    ctx.lineWidth = 1.5; ctx.globalAlpha = 0.8;
    const n = Math.max(2, Math.min(9, Math.round(f.length / 0.3)));
    for (let i = 0; i <= n; i++) {
      const k = -h + (2 * h * i) / n, p0 = P(l.x + ux * k, l.y + uy * k, l.z), p1 = P(l.x + ux * k + out[0], l.y + uy * k + out[1], l.z + out[2]);
      if (p0 && p1) { ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke(); }
    }
    ctx.restore();
  }
  // A small icon on a light's orb for what kind of light it is
  glyph(name, x, y, r) {
    const d = GLYPHS[name];
    if (!d || r < 7) return;
    const ctx = this.ctx, k = (r * 1.25) / 24;
    ctx.save(); ctx.translate(x - 12 * k, y - 12 * k); ctx.scale(k, k);
    ctx.strokeStyle = "#1b2027"; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.stroke(new Path2D(d));
    ctx.restore();
  }

  line(a, b, color, width = 1, dash = []) {
    if (!a || !b) return;
    const ctx = this.ctx;
    ctx.save(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore();
  }
  poly(pts, fill, alpha, stroke, strokeAlpha = 1) {
    if (pts.some((p) => !p)) return;
    const ctx = this.ctx;
    ctx.beginPath(); pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
    if (alpha > 0) { ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.fill(); }
    ctx.globalAlpha = strokeAlpha; ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
  }
  dot(p, r, color, dim) {
    const ctx = this.ctx;
    ctx.globalAlpha = dim ? 0.3 : 1; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  }
  text(t, x, y, color, size, align, halo) {
    const ctx = this.ctx;
    ctx.font = `500 ${size}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = align; ctx.textBaseline = "alphabetic";
    if (halo) { ctx.lineWidth = 4; ctx.strokeStyle = this.colors().bg; ctx.strokeText(t, x, y); }
    ctx.fillStyle = color; ctx.fillText(t, x, y);
  }

  // ---- input -----------------------------------------------------------------------------------

  local(e) {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  hit(pt) {
    let best = null;
    for (const l of this.scene.lights) {
      if (!l._screen || l.dim) continue;
      const d = Math.hypot(pt.x - l._screen.x, pt.y - l._screen.y);
      if (d <= l._screen.r && (!best || d < best.d)) best = { id: l.id, d };
    }
    if (best) return { id: best.id, part: null };
    for (const l of this.scene.lights) {
      if (!l.linked || l.dim || !l._parts) continue;
      for (const q of l._parts) if (Math.hypot(pt.x - q.x, pt.y - q.y) <= q.r) return { id: l.id, part: q.index };
    }
    // parts of the picked light
    const sel = this.scene.lights.find((l) => l.sel);
    if (sel) for (const p of sel.parts) {
      const pp = this.project(p);
      if (pp && Math.hypot(pt.x - pp.x, pt.y - pp.y) <= 10) return { id: sel.id, part: p.index };
    }
    return null;
  }

  down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this.local(e);
    this.pointers.set(e.pointerId, pt);
    if (e.button === 0 && this.pointers.size === 1) {
      // the view cube and home
      if (this._home && Math.hypot(pt.x - this._home.x, pt.y - this._home.y) <= 10) { this.drag = { kind: "cube", home: true, start: pt }; return; }
      const dir = this.cubeHit(pt);
      if (dir) { this.drag = { kind: "cube", dir, start: pt }; return; }
      // Shape: a face handle of the picked block (its axis arrows come first, below)
      if (this.mode === "shape") {
        const sb = this.selectedBlock();
        // an axis arrow (first: it's on a corner, away from the face handles): that way only
        const ax = sb && sb.behind ? this.hitAxis(pt) : null;
        if (ax) {
          const p = this.project(ax.from), q = this.project(add(ax.from, ax.axis));
          const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          this.drag = { kind: "axisMove", axis: ax, start: pt, dir: { x: (q.x - p.x) / len, y: (q.y - p.y) / len }, ppm: len, block: sb.id };
          return;
        }
        const h = this.hitHandle(pt);
        if (h) {
          const p = this.project(h.at), q = this.project(add(h.at, h.axis));
          const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          this.drag = { kind: "face", face: h, start: pt, dir: { x: (q.x - p.x) / len, y: (q.y - p.y) / len }, ppm: len, block: this.scene.selBlock };
          return;
        }
        // the picked stairs: across, at their height
        if (this.scene.selStair && !e.ctrlKey && !e.metaKey) {
          const hs = this.hitStairs(pt.x, pt.y);
          if (hs && hs.id === this.scene.selStair) { const at = this.onPlane(pt.x, pt.y, hs.z); if (at) { this.drag = { kind: "stairMove", start: pt, at0: at, z: hs.z, id: hs.id, moved: false }; return; } }
        }
        // a corner of the picked flat shape, or the shape itself: across the ground
        const yc = this.scene.selYard ? this.hitYardCorner(pt) : null;
        if (yc) { this.drag = { kind: "yardPoint", start: pt, id: this.scene.selYard, part: yc.part, i: yc.i, moved: false }; return; }
        if (this.scene.selYard && !e.ctrlKey && !e.metaKey && this.hitYard(pt.x, pt.y) === this.scene.selYard && !(sb && this.rayHitsBlock(pt.x, pt.y, sb))) {
          const at = this.onPlane(pt.x, pt.y, 0.01);
          if (at) { this.drag = { kind: "yardMove", start: pt, at0: at, id: this.scene.selYard, moved: false }; return; }
        }
        // the picked window or door: along its wall
        const so = this.scene.selOpening && this.scene.massing && this.scene.massing.openings.find((o) => o.id === this.scene.selOpening);
        if (so && this.hitOpening(pt.x, pt.y) === so.id) {
          const y = this.openingY(so), at = this.onWall(pt.x, pt.y, y);
          if (at) { this.drag = { kind: "openingMove", start: pt, at0: at, y, id: so.id, moved: false }; return; }
        }
        // the block itself: across the ground, or with Shift up and down
        if (sb && this.rayHitsBlock(pt.x, pt.y, sb)) {
          if (e.shiftKey) {
            const c = { x: (sb.x0 + sb.x1) / 2, y: (sb.y0 || 0) + sb.depth / 2, z: sb.z0 };
            const p = this.project(c), q = this.project(add(c, { x: 0, y: 0, z: 1 }));
            this.drag = { kind: "blockLift", start: pt, ppm: Math.abs(q.y - p.y) || 1, block: sb.id, moved: false };
            return;
          }
          const at = this.onPlane(pt.x, pt.y, sb.z0);
          if (at) { this.drag = { kind: "blockMove", start: pt, at0: at, block: sb.id, z: sb.z0, moved: false }; return; }
        }
      }
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      // two fingers: pinch to zoom, move together to slide the view
      this.drag = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, pan: { ...this.pan } };
      return;
    }
    // the wheel (middle button) or the right button: slide the view
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      this.drag = { kind: "pan", start: pt, pan: { ...this.pan }, moved: false };
      return;
    }
    const hit = this.mode === "shape" ? null : this.hit(pt);
    const sel = this.scene.lights.find((l) => l.sel);
    if (hit && sel && hit.id === sel.id && (hit.part === null ? this.scene.selPart === null : hit.part === this.scene.selPart)) {
      this.drag = { kind: this.mode === "raise" && hit.part === null ? "raise" : "move", start: pt, part: hit.part, light: sel, moved: false,
        z: hit.part === null ? sel.z : sel.parts.find((p) => p.index === hit.part).z, h0: sel.z - sel.floorZ };
      return;
    }
    this.drag = { kind: "orbit", start: pt, yaw: this.yaw, pitch: this.pitch, hit, moved: false, ctrl: e.ctrlKey || e.metaKey };
  }

  move(e) {
    const pt = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pt);
    const d = this.drag;
    if (!d) {
      // the cube shows what a click would turn to
      const hov = this.cubeHit(pt);
      if (JSON.stringify(hov) !== JSON.stringify(this._cubeHover || null)) { this._cubeHover = hov; this.canvas.style.cursor = hov ? "pointer" : ""; this.render(); }
      return;
    }
    if (d.kind === "cube") return;
    d.alt = e.altKey; // Alt: no snapping
    if (d.kind === "blockMove") {
      if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 3) d.moved = true;
      const at = this.onPlane(pt.x, pt.y, d.z);
      if (at && d.moved) { d.dx = at.x - d.at0.x; d.dy = at.y - d.at0.y; d.dz = 0; this.h.onBlockMove && this.h.onBlockMove(d.block, d.dx, d.dy, 0, false, d.alt); }
      return;
    }
    if (d.kind === "stairMove") {
      if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 3) d.moved = true;
      const at = this.onPlane(pt.x, pt.y, d.z);
      if (at && d.moved) { d.at = at; this.h.onStairMove && this.h.onStairMove(d.id, at.x - d.at0.x, at.y - d.at0.y, false, d.alt); }
      return;
    }
    if (d.kind === "yardMove" || d.kind === "yardPoint") {
      if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 3) d.moved = true;
      const at = this.onPlane(pt.x, pt.y, 0.01);
      if (!at || !d.moved) return;
      d.at = at;
      if (d.kind === "yardMove") this.h.onYardMove && this.h.onYardMove(d.id, at.x - d.at0.x, at.y - d.at0.y, false, d.alt);
      else this.h.onYardPoint && this.h.onYardPoint(d.id, d.part, d.i, at.x, at.y, false, d.alt);
      return;
    }
    if (d.kind === "openingMove") {
      if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 3) d.moved = true;
      const at = this.onWall(pt.x, pt.y, d.y);
      if (at && d.moved) { d.dx = at.x - d.at0.x; d.dz = at.z - d.at0.z; this.h.onOpeningMove && this.h.onOpeningMove(d.id, d.dx, d.dz, false, d.alt); }
      return;
    }
    if (d.kind === "blockLift") {
      if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 3) d.moved = true;
      d.dx = 0; d.dy = 0; d.dz = L.snapLen(-(pt.y - d.start.y) / d.ppm);
      if (d.moved) this.h.onBlockMove && this.h.onBlockMove(d.block, 0, 0, d.dz, false, d.alt);
      return;
    }
    if (d.kind === "axisMove") {
      const along = L.snapLen(((pt.x - d.start.x) * d.dir.x + (pt.y - d.start.y) * d.dir.y) / d.ppm);
      d.moved = true; d.delta = along;
      d.dx = d.axis.axis.x * along; d.dy = d.axis.axis.y * along; d.dz = d.axis.axis.z * along;
      this.h.onBlockMove && this.h.onBlockMove(d.block, d.dx, d.dy, d.dz, false, d.alt);
      return;
    }
    if (d.kind === "face") {
      const along = (pt.x - d.start.x) * d.dir.x + (pt.y - d.start.y) * d.dir.y;
      d.delta = L.snapLen(along / d.ppm);
      this.h.onFace && this.h.onFace(d.block, d.face.face, d.delta, false, d.alt);
      return;
    }
    if (d.kind === "pinch" && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.zoom = Math.min(4, Math.max(0.35, d.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / d.dist)));
      this.slide(d.pan, (a.x + b.x) / 2 - d.mid.x, (a.y + b.y) / 2 - d.mid.y);
      this.render();
      return;
    }
    if (d.kind === "pan") {
      if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 2) d.moved = true;
      this.slide(d.pan, pt.x - d.start.x, pt.y - d.start.y);
      this.render();
      return;
    }
    if (d.start && Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 4) d.moved = true;
    if (!d.moved) return;
    if (d.kind === "orbit") {
      this.yaw = d.yaw - (pt.x - d.start.x) * 0.008;
      this.pitch = Math.min(1.52, Math.max(0.02, d.pitch + (pt.y - d.start.y) * 0.006));
      this.render();
    } else if (d.kind === "move") {
      const at = this.onPlane(pt.x, pt.y, d.z);
      if (!at) return;
      d.at = at;
      this.h.onMove(d.light.id, d.part, at.x, at.y, false);
    } else if (d.kind === "raise") {
      // metres per pixel at the light's distance
      const top = this.project({ x: d.light.x, y: d.light.y, z: d.z });
      const above = this.project({ x: d.light.x, y: d.light.y, z: d.z + 1 });
      if (!top || !above) return;
      const ppm = Math.abs(above.y - top.y) || 1;
      d.h = Math.max(0, d.h0 - (pt.y - d.start.y) / ppm);
      this.h.onRaise(d.light.id, d.h, false);
    }
  }

  // Slide the view so what was under the pointer follows it: dx, dy in screen px from pan0
  slide(pan0, dx, dy) {
    const cam = this.cam || this.camera();
    // metres per pixel at the view's middle
    const target = { x: this.scene.W / 2 + pan0.x, y: this.scene.D / 2 - 2 + pan0.y, z: (this.scene.zMin + this.scene.zMax) / 2 + pan0.z };
    const dist = len(sub(target, cam.pos));
    const k = dist / cam.focal;
    this.pan = {
      x: pan0.x - cam.r.x * dx * k + cam.u.x * dy * k,
      y: pan0.y - cam.r.y * dx * k + cam.u.y * dy * k,
      z: pan0.z - cam.r.z * dx * k + cam.u.z * dy * k,
    };
  }

  up(e, cancel = false) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pinch") { if (this.pointers.size === 0) this.drag = null; return; }
    this.drag = null;
    if (cancel) return;
    if (d.kind === "cube") {
      const pt = this.local(e);
      if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 6) return;
      if (d.home) return this.animateTo(-0.55, 0.62, { x: 0, y: 0, z: 0 });
      return this.lookFrom(d.dir);
    }
    if (d.kind === "face") { if (d.delta) this.h.onFace && this.h.onFace(d.block, d.face.face, d.delta, true, d.alt); return; }
    if (d.kind === "stairMove" && d.moved && d.at) { this.h.onStairMove && this.h.onStairMove(d.id, d.at.x - d.at0.x, d.at.y - d.at0.y, true, d.alt); return; }
    if (d.kind === "yardMove" && d.moved && d.at) { this.h.onYardMove && this.h.onYardMove(d.id, d.at.x - d.at0.x, d.at.y - d.at0.y, true, d.alt); return; }
    if (d.kind === "yardPoint" && d.moved && d.at) { this.h.onYardPoint && this.h.onYardPoint(d.id, d.part, d.i, d.at.x, d.at.y, true, d.alt); return; }
    if (d.kind === "openingMove") { if (d.moved && d.dx !== undefined && this.h.onOpeningMove) this.h.onOpeningMove(d.id, d.dx, d.dz, true, d.alt); return; }
    if (d.kind === "blockMove" || d.kind === "blockLift" || d.kind === "axisMove") {
      if (d.moved && d.dx !== undefined && this.h.onBlockMove) this.h.onBlockMove(d.block, d.dx, d.dy, d.dz || 0, true, d.alt);
      return;
    }
    if (d.kind === "move" && d.moved && d.at) return this.h.onMove(d.light.id, d.part, d.at.x, d.at.y, true);
    if (d.kind === "raise" && d.moved) return this.h.onRaise(d.light.id, d.h, true);
    if (d.kind === "orbit" && !d.moved) {
      if (this.mode === "shape") {
        const ctrl = d.ctrl;
        const op = ctrl ? null : this.hitOpening(d.start.x, d.start.y);
        if (op && this.h.onOpening) { this.h.onOpening(op); return; }
        const hs = ctrl ? null : this.hitStairs(d.start.x, d.start.y);
        if (hs && this.h.onStair) { this.h.onStair(hs.id); return; }
        const id = this.hitBlock(d.start.x, d.start.y);
        if (ctrl && id && this.h.onBlock) { this.h.onBlock(id, true); return; }
        const yd = id ? null : this.hitYard(d.start.x, d.start.y);
        if (yd && this.h.onYard) { this.h.onYard(yd, ctrl); return; }
        if (this.h.onBlock) this.h.onBlock(id);
        return;
      }
      // aiming: what's under the tap is where the picked light points
      if (this.aimMode) {
        const hit = this.raycast(d.start.x, d.start.y);
        if (hit && this.h.onAimAt) this.h.onAimAt(hit.p, hit.what);
        return;
      }
      if (d.hit) return this.h.onPick(d.hit.id, d.hit.part);
      // a tap on empty space: place the picked light (or part) on the shown floor there
      const at = this.onPlane(d.start.x, d.start.y, this.scene.placeZ);
      if (at) this.h.onPlace(at.x, at.y);
    }
  }
};

// Points along a smooth curve through pts (Catmull-Rom), in the ground's metres
// Where a ray from (x, y) along (dx, dy) crosses the segment a-b: its distance, or -1
function segT(x, y, dx, dy, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((a[0] - x) * ey - (a[1] - y) * ex) / den;
  const s = ((a[0] - x) * dy - (a[1] - y) * dx) / den;
  return s >= 0 && s <= 1 ? t : -1;
}
// Light icons, drawn on the orbs (24-unit boxes)
const GLYPHS = {
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z",
  ceiling: "M4 7h16M7 7a5 5 0 0 0 10 0M12 15v3M8 14l-2 2M16 14l2 2",
  pendant: "M12 2v7M6 15a6 6 0 0 1 12 0zM12 18v2",
  wall: "M6 4v16M6 8h4l5 4-5 4H6",
  lamp: "M8 3h8l3 7H5zM12 10v9M8 21h8",
  spot: "M4 9v6l6-1v-4zM10 10l10-5v14l-10-5",
  post: "M12 3v3M9 6h6l-1 4h-4zM12 10v10M9 21h6",
  soffit: "M3 5h18M8 5v2a4 4 0 0 0 8 0V5M12 13v3M8 14l-1 2M16 14l1 2",
  bar: "M3 12h18M6 9v6M18 9v6",
  fan: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 10V3M14 12l6 3M10 12l-6 3",
  can: "M5 8h14M7 8v3a5 5 0 0 0 10 0V8M12 17v3",
  flush: "M3 9h18M5 9a7 6 0 0 0 14 0M12 15v.01",
};
// Which faces of a block it shares with a block it's joined to (the same group)
function joinedFaces(b, blocks) {
  const out = { x0: false, x1: false, y0: false, y1: false };
  if (!b.group) return out;
  const by0 = b.y0 || 0, by1 = by0 + b.depth;
  const over = (a0, a1, c0, c1) => Math.min(a1, c1) - Math.max(a0, c0) > 0.05;
  for (const o of blocks) {
    if (o === b || o.group !== b.group) continue;
    const oy0 = o.y0 || 0, oy1 = oy0 + o.depth;
    if (over(by0, by1, oy0, oy1) && Math.abs(o.x1 - b.x0) < 0.03) out.x0 = true;
    if (over(by0, by1, oy0, oy1) && Math.abs(o.x0 - b.x1) < 0.03) out.x1 = true;
    if (over(b.x0, b.x1, o.x0, o.x1) && Math.abs(oy1 - by0) < 0.03) out.y0 = true;
    if (over(b.x0, b.x1, o.x0, o.x1) && Math.abs(oy0 - by1) < 0.03) out.y1 = true;
  }
  return out;
}
// A flat yard shape as ground outlines: an area's outline (and any merged in), a path's strips
function flatPolys(y) {
  const pieces = [y.pts, ...(y.parts || [])];
  if (y.kind === "path") return pieces.map((line) => stripAround(y.smooth && !y.parts ? curvePoints(line, false) : line, (y.width ?? 1.2) / 2));
  return pieces.map((q) => (y.smooth && !y.parts ? curvePoints(q, true) : q));
}
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Screen outlines filled as one shape (overlaps once), each stroked only outside the others
function unionPolys(ctx, polys, fill, stroke, width) {
  const area = (q) => q.reduce((a, p, i) => { const n = q[(i + 1) % q.length]; return a + p.x * n.y - n.x * p.y; }, 0);
  const one = polys.map((q) => (area(q) < 0 ? [...q].reverse() : q));
  const trace = (q) => q.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.save();
  ctx.beginPath(); one.forEach(trace); ctx.fillStyle = fill; ctx.fill("nonzero");
  ctx.lineWidth = width; ctx.strokeStyle = stroke;
  one.forEach((q, i) => {
    ctx.save();
    if (one.length > 1) { ctx.beginPath(); ctx.rect(-1e5, -1e5, 2e5, 2e5); one.forEach((o, j) => { if (j !== i) trace(o); }); ctx.clip("evenodd"); }
    ctx.beginPath(); trace(q); ctx.closePath(); ctx.stroke();
    ctx.restore();
  });
  ctx.restore();
}
function curvePoints(pts, closed, steps = 8) {
  const n = pts.length;
  if (n < 3) return pts;
  const P = (i) => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  const out = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}
// A strip `half` either side of a line on the ground: its outline, as one polygon
function stripAround(line, half) {
  const left = [], right = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * half, ny = dx / len * half;
    left.push([line[i][0] + nx, line[i][1] + ny]);
    right.push([line[i][0] - nx, line[i][1] - ny]);
  }
  return [...left, ...right.reverse()];
}

// Where a ray first meets an axis-aligned box (min, max as [x, y, z]), or null
function rayBox(o, d, lo, hi) {
  let t0 = -Infinity, t1 = Infinity;
  for (const [k, i] of [["x", 0], ["y", 1], ["z", 2]]) {
    if (Math.abs(d[k]) < 1e-12) { if (o[k] < lo[i] || o[k] > hi[i]) return null; continue; }
    let a = (lo[i] - o[k]) / d[k], b = (hi[i] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0 > 0 ? t0 : t1 > 0 ? t1 : null;
}
function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
function dotv(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function scale(a, k) { return { x: a.x * k, y: a.y * k, z: a.z * k }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function len(a) { return Math.hypot(a.x, a.y, a.z); }
function norm(a) { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; }
function depthOf(a, b) { return a && b ? (a.depth + b.depth) / 2 : 0; }
function avgDepth(ps) { const v = ps.filter(Boolean); return v.length ? v.reduce((s, p) => s + p.depth, 0) / v.length : 0; }
function hexA(color, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
