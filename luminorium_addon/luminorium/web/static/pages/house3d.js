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
    if (this.mode === "shape") this.drawBlockHandles(col);
    this.drawCube(col, W);
    // a hint (the page shows it under the view on narrow screens)
    if (W >= 520) this.text(this.aimMode ? "Aim: click what the light should point at (a wall, the ground, a tree)"
      : this.mode === "shape" ? "Shape: tap a block, then drag a handle to move that face · right-drag to slide"
      : this.mode === "raise" ? "Raise: drag the picked light up or down" : "Drag to turn · right-drag or wheel-drag to slide · scroll or pinch to zoom · drag the picked light to move it",
      12, H - 12, col.muted, 12, "left");
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
    if (this.drag && this.drag.kind === "face" && this.drag.delta !== undefined) {
      const d = this.drag, p = this.project(d.face.at);
      if (p) {
        const sign = d.delta >= 0 ? "+" : "−";
        this.text(`${d.face.label} ${sign}${L.fmtLen(Math.abs(d.delta))}`, p.x + 12, p.y - 12, "#ffd166", 13, "left", true);
      }
    }
  }
  hitHandle(pt) {
    for (const h of this._handles || []) {
      if (Math.hypot(pt.x - h.p.x, pt.y - h.p.y) <= 12 || Math.hypot(pt.x - h.q.x, pt.y - h.q.y) <= 12) return h;
    }
    return null;
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
      if (b.id && b.id === this.scene.selBlock) {
        // the block picked in Shape: its outline in the accent colour
        const P8 = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(([x, y, z]) => P(x, y, z));
        const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
        items.push({ depth: -1e9, draw: () => { for (const [i, j] of E) this.line(P8[i], P8[j], "#ffd166", 2); } });
      }
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
      // curves are followed in the ground's own metres, so they lie flat from any angle
      const line = y.smooth ? curvePoints(y.pts, y.kind !== "path") : y.pts;
      if (y.kind === "path") ground(stripAround(line, (y.width ?? 1.2) / 2), c, 0.55);
      else ground(line, c, y.kind === "pool" ? 0.45 : 0.3);
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
    // stairs: a flight of steps from one level's floor to the other's
    for (const st of t.stairs || []) {
      const f0 = levels.get(st.level), f1 = levels.get(st.to);
      if (!f0 || !f1) continue;
      const along = st.dir[0], sign = st.dir[1] === "+" ? 1 : -1;
      const lo = along === "x" ? st.x0 : st.y0, hi = along === "x" ? st.x1 : st.y1;
      const z0 = f0.elevation, z1 = f1.elevation;
      const n = Math.max(2, Math.round(Math.abs(z1 - z0) / 0.19));
      const run = (hi - lo) / n;
      for (let k = 0; k < n; k++) {
        const s0 = sign > 0 ? lo + k * run : hi - (k + 1) * run, s1 = s0 + run;
        const z = z0 + (z1 - z0) * (k + 1) / n;
        const q = along === "x"
          ? [P(s0, st.y0, z), P(s1, st.y0, z), P(s1, st.y1, z), P(s0, st.y1, z)]
          : [P(st.x0, s0, z), P(st.x1, s0, z), P(st.x1, s1, z), P(st.x0, s1, z)];
        if (q.every(Boolean)) items.push({ depth: avgDepth(q), draw: () => this.poly(q, "#f0b429", 0.22, "#f0b429", 0.7) });
      }
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
    const rim = Array.from({ length: 18 }, (_, i) => {
      const k = (i / 18) * Math.PI * 2, c = Math.cos(k) * r, s = Math.sin(k) * r;
      return P(l.x + dir[0] * len + e1[0] * c + e2[0] * s, l.y + dir[1] * len + e1[1] * c + e2[1] * s, l.z + dir[2] * len + e1[2] * c + e2[2] * s);
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
      // Shape: a face handle of the picked block
      if (this.mode === "shape") {
        const h = this.hitHandle(pt);
        if (h) {
          const p = this.project(h.at), q = this.project(add(h.at, h.axis));
          const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          this.drag = { kind: "face", face: h, start: pt, dir: { x: (q.x - p.x) / len, y: (q.y - p.y) / len }, ppm: len, block: this.scene.selBlock };
          return;
        }
      }
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      // two fingers: pinch to zoom, move together to slide the view
      this.drag = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, pan: { ...this.pan } };
      return;
    }
    // the wheel (middle button), the right button, or Shift with the left: slide the view
    if (e.button === 1 || e.button === 2 || e.shiftKey) {
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
    this.drag = { kind: "orbit", start: pt, yaw: this.yaw, pitch: this.pitch, hit, moved: false };
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
    if (d.kind === "face") {
      const along = (pt.x - d.start.x) * d.dir.x + (pt.y - d.start.y) * d.dir.y;
      d.delta = L.snapLen(along / d.ppm);
      this.h.onFace && this.h.onFace(d.block, d.face.face, d.delta, false);
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
    if (d.kind === "face") { if (d.delta) this.h.onFace && this.h.onFace(d.block, d.face.face, d.delta, true); return; }
    if (d.kind === "move" && d.moved && d.at) return this.h.onMove(d.light.id, d.part, d.at.x, d.at.y, true);
    if (d.kind === "raise" && d.moved) return this.h.onRaise(d.light.id, d.h, true);
    if (d.kind === "orbit" && !d.moved) {
      if (this.mode === "shape") {
        const id = this.hitBlock(d.start.x, d.start.y);
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
