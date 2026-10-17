// A small volumetric view of the house for the house map: floors as slabs at their real heights,
// lights as orbs with a line down to their floor, a ground grid. Drag to orbit, wheel or pinch to
// zoom; tap a light to pick it; drag the picked light across its floor (Move) or up and down
// (Raise). Plain canvas 2D with a perspective camera: no 3D library to download.
"use strict";

window.House3D = class House3D {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.h = handlers; // onPick(id, part), onPlace(x, y), onMove(id, part, x, y, done), onRaise(id, h, done)
    this.scene = null;
    this.yaw = -0.55;     // around the vertical axis
    this.pitch = 0.62;    // above the horizon
    this.zoom = 1;
    this.mode = "move";   // "move" | "raise"
    this.pointers = new Map();
    this.drag = null;
    const ro = new ResizeObserver(() => this.render());
    ro.observe(canvas);
    canvas.style.touchAction = "none";
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
    this.render();
  }

  // ---- camera ------------------------------------------------------------------------------

  camera() {
    const s = this.scene;
    const target = { x: s.W / 2, y: s.D / 2 - 2, z: (s.zMin + s.zMax) / 2 };
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
    let i = 0;
    for (let x = gx0; x <= gx1 + 1e-6; x += g, i++) this.line(P(x, gy0, 0), P(x, gy1, 0), Math.round(x / g) % 5 ? col.line : col.line2);
    for (let y = gy0; y <= gy1 + 1e-6; y += g) this.line(P(gx0, y, 0), P(gx1, y, 0), Math.round(y / g) % 5 ? col.line : col.line2);

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
    for (const f of s.floors) {
      const x0 = f.x0 ?? 0, x1 = f.x1 ?? s.W;
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
    // The structure first (back to front), then the lights on top of it, so slabs never hide them
    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) it.draw();
    items.length = 0;
    // lights: a drop line to the floor, a shadow, the orb; parts as small dots
    for (const l of s.lights) {
      const top = P(l.x, l.y, l.z), base = P(l.x, l.y, l.floorZ);
      if (!top) continue;
      if (l.aim && !l.dim) this.beam(items, P, l);
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
        ctx.beginPath(); ctx.arc(top.x, top.y, r, 0, Math.PI * 2);
        ctx.fillStyle = l.sel ? col.accent : l.on ? "#d9a441" : col.faint;
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = col.bg; ctx.stroke();
        if (l.sel || l.hover || (!l.dim && this.scene.labels)) this.text(l.label, top.x, top.y - r - 6, col.text, 12, "center", true);
        ctx.globalAlpha = 1;
        l._screen = { x: top.x, y: top.y, r: r + 6, ppm: base && l.z !== l.floorZ ? Math.abs(base.y - top.y) / Math.abs(l.z - l.floorZ) : null };
      } });
    }
    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) it.draw();
    // a hint (the page shows it under the view on narrow screens)
    if (W >= 520) this.text(this.mode === "raise" ? "Raise: drag the picked light up or down" : "Drag to turn · scroll or pinch to zoom · drag the picked light to move it",
      12, H - 12, col.muted, 12, "left");
  }

  // Each block as translucent faces: four walls, and a gable (point to the street) or a ridge
  // (along the front) roof
  massing(items, P, col) {
    const WALL = "#5aa9e6", ROOF = "#8fb3d9", GLASS = "#9ad0f5";
    const face = (pts, color, alpha, strokeAlpha = 0.7) => {
      const q = pts.map(([x, y, z]) => P(x, y, z));
      items.push({ depth: avgDepth(q), draw: () => this.poly(q, color, alpha, color, strokeAlpha) });
    };
    // A block that goes into the ground (a basement) leaves a hole in the grid where it goes in
    for (const b of this.scene.massing.blocks) {
      if (b.z0 > -0.01) continue;
      const y0 = b.y0 || 0, y1 = y0 + b.depth;
      const hole = [P(b.x0, y0, 0), P(b.x1, y0, 0), P(b.x1, y1, 0), P(b.x0, y1, 0)];
      this.poly(hole, col.bg, 0.92, col.line2, 1);
    }
    for (const b of this.scene.massing.blocks) {
      const { x0, x1, z0, z1 } = b;
      const y0 = b.y0 || 0, y1 = y0 + b.depth;
      face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], WALL, 0.08);
      face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], WALL, 0.06, 0.45);
      face([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], WALL, 0.06, 0.55);
      face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], WALL, 0.06, 0.55);
      const lab = P(x0 + 0.2, y0, z1 + 0.15);
      if (lab && b.name) items.push({ depth: lab.depth - 0.01, draw: () => this.text(b.name, lab.x, lab.y, col.muted, 11, "left") });
    }
    // Roofs: the outline seen from the street, taken back as each one says
    for (const r of this.scene.massing.roofs || []) {
      const zs = r.pts.map((q) => q[1]);
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
      const blk = this.scene.massing.blocks.find((b) => (o.x0 + o.x1) / 2 >= b.x0 && (o.x0 + o.x1) / 2 <= b.x1);
      const y = (blk ? blk.y0 || 0 : 0) - 0.02;
      face([[o.x0, y, o.z0], [o.x1, y, o.z0], [o.x1, y, o.z1], [o.x0, y, o.z1]], GLASS, o.kind === "window" ? 0.22 : 0.14, 0.9);
    }
  }

  // The top view's drawing: the yard on the ground, the outside walls, each level's walls
  topView(items, P, col) {
    const t = this.scene.top;
    const COLORS = { path: "#c9c2b4", driveway: "#9aa0a6", patio: "#d4a373", pool: "#4cc3f0", bed: "#8d6e4f", lawn: "#6fbf73", tree: "#3f9d4a", bush: "#7cc576", other: "#b0b8c4" };
    const ground = (pts, color, alpha) => { const q = pts.map(([x, y]) => P(x, y, 0.01)); if (q.every(Boolean)) this.poly(q, color, alpha, color, 0.8); };
    // flat things first, drawn straight onto the ground
    for (const y of t.yard) {
      const c = COLORS[y.kind] || "#b0b8c4";
      if (y.c) continue;
      if (y.kind === "path") {
        const q = y.pts.map(([x, yy]) => P(x, yy, 0.01));
        if (q.every(Boolean)) for (let i = 0; i + 1 < q.length; i++) this.line(q[i], q[i + 1], hexA(c, 0.8), Math.max(2, (y.width ?? 1.2) * q[i].scale * 0.9));
      } else ground(y.pts, c, y.kind === "pool" ? 0.45 : 0.3);
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
    // interior walls: a see-through panel from each level's floor to its ceiling
    const levels = new Map(this.scene.floors.map((f) => [f.id, f]));
    for (const w of t.walls) {
      const f = levels.get(w.level);
      if (!f) continue;
      const z0 = f.elevation, z1 = f.elevation + f.ceiling;
      const q = [P(w.a[0], w.a[1], z0), P(w.b[0], w.b[1], z0), P(w.b[0], w.b[1], z1), P(w.a[0], w.a[1], z1)];
      const active = f.active;
      items.push({ depth: avgDepth(q), draw: () => this.poly(q, "#dce2ea", active ? 0.14 : 0.05, "#dce2ea", active ? 0.6 : 0.2) });
    }
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
    const rim = Array.from({ length: 18 }, (_, i) => {
      const k = (i / 18) * Math.PI * 2, c = Math.cos(k) * r, s = Math.sin(k) * r;
      return P(l.x + dir[0] * len + e1[0] * c + e2[0] * s, l.y + dir[1] * len + e1[1] * c + e2[1] * s, l.z + dir[2] * len + e1[2] * c + e2[2] * s);
    });
    const apex = P(l.x, l.y, l.z);
    if (!apex || rim.some((q) => !q)) return;
    const color = l.sel ? "#ff8a3d" : "#f5c25a";
    items.push({ depth: avgDepth(rim) + 0.1, draw: () => {
      const ctx = this.ctx;
      ctx.save(); ctx.globalAlpha = l.sel ? 0.22 : 0.12; ctx.fillStyle = color;
      for (let i = 0; i < rim.length; i++) { const b = rim[i], c = rim[(i + 1) % rim.length]; ctx.beginPath(); ctx.moveTo(apex.x, apex.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.fill(); }
      ctx.globalAlpha = l.sel ? 0.8 : 0.4; ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); rim.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
      // the middle of the beam
      const mid = P(l.x + dir[0] * len, l.y + dir[1] * len, l.z + dir[2] * len);
      if (mid) { ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(apex.x, apex.y); ctx.lineTo(mid.x, mid.y); ctx.stroke(); }
      ctx.restore();
    } });
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
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom };
      return;
    }
    const hit = this.hit(pt);
    const sel = this.scene.lights.find((l) => l.sel);
    if (hit && sel && hit.id === sel.id && (hit.part === null ? this.scene.selPart === null : hit.part === this.scene.selPart)) {
      this.drag = { kind: this.mode === "raise" && hit.part === null ? "raise" : "move", start: pt, part: hit.part, light: sel, moved: false,
        z: hit.part === null ? sel.z : sel.parts.find((p) => p.index === hit.part).z, h0: sel.z - sel.floorZ };
      return;
    }
    this.drag = { kind: "orbit", start: pt, yaw: this.yaw, pitch: this.pitch, hit, moved: false };
  }

  move(e) {
    const pt = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pt);
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pinch" && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.zoom = Math.min(4, Math.max(0.35, d.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / d.dist)));
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

  up(e, cancel = false) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pinch") { if (this.pointers.size === 0) this.drag = null; return; }
    this.drag = null;
    if (cancel) return;
    if (d.kind === "move" && d.moved && d.at) return this.h.onMove(d.light.id, d.part, d.at.x, d.at.y, true);
    if (d.kind === "raise" && d.moved) return this.h.onRaise(d.light.id, d.h, true);
    if (d.kind === "orbit" && !d.moved) {
      if (d.hit) return this.h.onPick(d.hit.id, d.hit.part);
      // a tap on empty space: place the picked light (or part) on the shown floor there
      const at = this.onPlane(d.start.x, d.start.y, this.scene.placeZ);
      if (at) this.h.onPlace(at.x, at.y);
    }
  }
};

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
