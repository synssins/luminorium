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
    // the house volume: outline from the lowest floor to the top of the highest
    const box = [[0, 0], [s.W, 0], [s.W, s.D], [0, s.D]];
    for (const [x, y] of box) items.push({ depth: depthOf(P(x, y, s.zMin), P(x, y, s.zMax)), draw: () => this.line(P(x, y, s.zMin), P(x, y, s.zMax), col.faint, 1) });
    for (const z of [s.zMin, s.zMax]) for (let k = 0; k < 4; k++) {
      const a = box[k], b = box[(k + 1) % 4];
      items.push({ depth: depthOf(P(a[0], a[1], z), P(b[0], b[1], z)), draw: () => this.line(P(a[0], a[1], z), P(b[0], b[1], z), col.faint, 1) });
    }
    // floors: a slab at each elevation over its span, and a faint ceiling
    for (const f of s.floors) {
      const x0 = f.x0 ?? 0, x1 = f.x1 ?? s.W;
      const quad = (z) => [P(x0, 0, z), P(x1, 0, z), P(x1, s.D, z), P(x0, s.D, z)];
      const floorQ = quad(f.elevation), ceilQ = quad(f.elevation + f.ceiling);
      items.push({ depth: avgDepth(floorQ) + 0.01, draw: () => {
        this.poly(floorQ, f.active ? col.accent : col.card2, f.active ? 0.18 : 0.55, f.active ? col.accent : col.line2);
        const lab = P(x0 + 0.3, 0.2, f.elevation);
        if (lab) this.text(`${f.name}  ${f.label}`, lab.x, lab.y - 4, f.active ? col.accent : col.muted, 11, "left");
      } });
      items.push({ depth: avgDepth(ceilQ), draw: () => this.poly(ceilQ, col.card2, 0, f.active ? col.accent : col.line, 0.5) });
    }
    // The structure first (back to front), then the lights on top of it, so slabs never hide them
    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) it.draw();
    items.length = 0;
    // lights: a drop line to the floor, a shadow, the orb; parts as small dots
    for (const l of s.lights) {
      const top = P(l.x, l.y, l.z), base = P(l.x, l.y, l.floorZ);
      if (!top) continue;
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
