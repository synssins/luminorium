// The solid view drawn with WebGL (three.js, bundled in static/vendor): real solids with a depth
// buffer, so walls, floors, stairs and windows hide each other properly from any angle, lit by the
// sun and by the house's lights that are on. The 2D canvas (house3d.js) keeps the camera, the
// picking and everything drawn on top (lights, labels, handles, the view cube); this draws the
// house under it with the same camera. Uses house3d.js's helpers (wallPieces, flight, flatPolys,
// TEXTURES, BEIGE...), which are globals of that script.
"use strict";

window.HouseGL = class HouseGL {
  // Whether WebGL can be used, checked once (a test context each call would use up the
  // browser's handful of WebGL contexts, and it drops the oldest, ours)
  static ok() {
    if (HouseGL._ok !== undefined) return HouseGL._ok;
    if (!window.THREE) return false;
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (gl) { const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); HouseGL._ok = true; return true; }
      HouseGL.why = "This browser won't give the page WebGL (hardware acceleration off?): drawing in 2D";
    } catch (err) { HouseGL.why = `WebGL check failed: ${err.message}`; }
    HouseGL._ok = false;
    return false;
  }

  constructor(host) {
    const T = THREE;
    this.host = host; // the 2D canvas: this canvas sits right under it
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", pointerEvents: "none", left: "0", top: "0" });
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // a phone or tablet: fewer lights and a smaller shadow map
    this.small = Math.min(screen.width, screen.height) < 900 || /Android|iPad|iPhone|Mobile/i.test(navigator.userAgent);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false; // redrawn only when the house or its lights change
    this.renderer.shadowMap.type = this.small ? T.PCFShadowMap : T.PCFSoftShadowMap;
    // if the GPU drops the context (out of memory on a tablet), go back to the 2D drawing
    this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; HouseGL.why = "WebGL: the graphics chip dropped the view (out of memory?): drawing in 2D"; HouseGL._ok = false; this.hide(); if (this.onLost) this.onLost(); });
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(40, 1, 0.05, 600);
    this.camera.up.set(0, 0, 1);
    this.house = new T.Group();
    this.scene.add(this.house);
    this.lamps = new T.Group();
    this.scene.add(this.lamps);
    // daylight: a soft sky and the sun (from above, front left: as the 2D view shades)
    this.hemi = new T.HemisphereLight(0xe6eef8, 0x5a4a35, 1.1);
    this.scene.add(this.hemi);
    const sun = (this.sun = new T.DirectionalLight(0xfff3e0, 1.7));
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.small ? 1024 : 2048, this.small ? 1024 : 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);
    this.textures = {};
    this.mats = {};
    this.key = null;
    this.shadowsDirty = true;
  }

  // ---- materials ---------------------------------------------------------------------------

  tex(name, redraw) {
    if (!this.textures[name]) {
      const t = new THREE.TextureLoader().load(TEXTURES[name].src, () => redraw && redraw());
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const m = TEXTURES[name].m;
      t.repeat.set(1 / m, 1 / m); // geometry UVs are in metres
      this.textures[name] = t;
    }
    return this.textures[name];
  }
  mat(key, redraw) {
    if (this.mats[key]) return this.mats[key];
    const T = THREE, rgb = (c) => new T.Color(`rgb(${c.join(",")})`);
    const std = (o) => new T.MeshStandardMaterial({ side: T.DoubleSide, ...o });
    const make = {
      plaster: () => std({ color: rgb(BEIGE), roughness: 0.92 }),
      foundation: () => std({ color: 0x9a958c, roughness: 1 }),
      siding: () => std({ map: this.tex("siding", redraw), roughness: 0.75 }),
      floor: () => std({ color: rgb(FLOOR), roughness: 0.8 }),
      hardwood: () => std({ map: this.tex("hardwood", redraw), roughness: 0.38, metalness: 0.02 }),
      vinyl: () => std({ map: this.tex("vinyl", redraw), roughness: 0.45 }),
      tile: () => std({ map: this.tex("tile", redraw), roughness: 0.35 }),
      concrete: () => std({ map: this.tex("concrete", redraw), roughness: 0.95 }),
      grass: () => std({ map: this.tex("grass", redraw), roughness: 1 }),
      wood: () => std({ color: rgb(WOOD), roughness: 0.6 }),
      stoop: () => std({ map: this.tex("concrete", redraw), roughness: 0.95 }),
      mulch: () => std({ color: 0x5a3d26, roughness: 1 }),
      pool: () => std({ color: 0x3fa7d6, roughness: 0.1, metalness: 0.1 }),
      lawn: () => std({ color: 0x5c8a3a, roughness: 1 }),
      other: () => std({ color: 0xb0b8c4, roughness: 1 }),
      glass: () => std({ color: 0x9fc2dc, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.28, depthWrite: false }),
      frame: () => std({ color: 0xf4f1ea, roughness: 0.6 }),
      door: () => std({ color: 0x6b4a2e, roughness: 0.6 }),
      garage: () => std({ color: 0xf0eee8, roughness: 0.7 }),
      trunk: () => std({ color: 0x6b4c30, roughness: 1 }),
      leaves: () => std({ color: 0x2f6b34, roughness: 1 }),
      tvbody: () => std({ color: 0x141518, roughness: 0.5, metalness: 0.3 }),
      screen: () => std({ color: 0x07090c, roughness: 0.12, metalness: 0.6 }),
    };
    this.mats[key] = (make[key] || make.other)();
    return this.mats[key];
  }

  // ---- building the house ------------------------------------------------------------------

  build(s, redraw) {
    // rebuilt only when the house changes: the same drawing (by reference) and cut skip the work
    const fl = s.floors.map((f) => `${f.id}:${f.elevation}:${f.ceiling}`).join("|");
    if (this.built && this.built.m === s.massing && this.built.t === s.top && this.built.cut === (s.cutZ ?? null) && this.built.fl === fl) return;
    this.built = { m: s.massing, t: s.top, cut: s.cutZ ?? null, fl };
    this.shadowsDirty = true;
    for (const c of [...this.house.children]) { c.geometry && c.geometry.dispose(); this.house.remove(c); }
    const T = THREE;
    const cut = s.cutZ ?? Infinity;
    const levels = new Map(s.floors.map((f) => [f.id, f]));
    const t = s.top || { walls: [], doors: [], stairs: [], yard: [], finishes: [], windows: [] };
    const blocks = (s.massing && s.massing.blocks) || [];
    const B = new QuadBuilder();
    const th = t.ext_thick || 0.13;

    // a closed box along a→b: half thickness each side of the line, z0..z1; the face on the left
    // of a→b gets `sideL`, the right `sideR`, the rest `rest`
    const box = (a, b, half, z0, z1, rest, sideL = rest, sideR = rest, bottom = false) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.005 || z1 - z0 < 0.005) return;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy, ny = ux;
      const A = (k) => [a[0] + nx * half * k, a[1] + ny * half * k], Bp = (k) => [b[0] + nx * half * k, b[1] + ny * half * k];
      const al = A(1), ar = A(-1), bl = Bp(1), br = Bp(-1);
      B.wall(sideL, al, bl, z0, z1, [nx, ny, 0]);
      B.wall(sideR, br, ar, z0, z1, [-nx, -ny, 0]);
      B.wall(rest, ar, al, z0, z1, [-ux, -uy, 0]);
      B.wall(rest, bl, br, z0, z1, [ux, uy, 0]);
      B.flat(rest, [al, bl, br, ar], z1, 1);
      if (bottom) B.flat(rest, [al, bl, br, ar], z0, -1);
    };

    // every window and outside door, as a line along a wall and its sill and top: the outside walls
    // leave a hole for each, so light goes through the glass
    const holesIn = [];
    for (const o of (s.massing && s.massing.openings) || []) {
      const y = o.y !== undefined ? o.y : (blocks.find((q) => (o.x0 + o.x1) / 2 >= q.x0 && (o.x0 + o.x1) / 2 <= q.x1) || {}).y0 || 0;
      holesIn.push({ a: [o.x0, y], b: [o.x1, y], z0: o.z0, z1: o.z1 });
    }
    for (const w of t.windows || []) holesIn.push({ a: w.a, b: w.b, z0: w.z0, z1: w.z1 });
    // the stretches of a face's line (from a, along u) a hole takes: [s0, s1, z0, z1]
    const holesOn = (a, ux, uy, L) => holesIn.flatMap((h) => {
      const d = (p) => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux); // distance off the line
      if (d(h.a) > th + 0.06 || d(h.b) > th + 0.06) return [];
      const s0 = (h.a[0] - a[0]) * ux + (h.a[1] - a[1]) * uy, s1 = (h.b[0] - a[0]) * ux + (h.b[1] - a[1]) * uy;
      const p = Math.max(0, Math.min(s0, s1)), q = Math.min(L, Math.max(s0, s1));
      return q - p > 0.05 ? [[p, q, h.z0, h.z1]] : [];
    });

    // outside walls: each block's faces as solid walls `th` thick, inward from the face; siding
    // outside where the face is out in the open, plaster against another part of the house,
    // foundation below the ground
    for (const b of blocks) {
      if (b.z0 >= cut - 0.05) continue;
      const y0 = b.y0 || 0, y1 = y0 + b.depth, top = Math.min(b.z1, cut);
      const faces = [[[b.x0, y0], [b.x1, y0]], [[b.x1, y0], [b.x1, y1]], [[b.x1, y1], [b.x0, y1]], [[b.x0, y1], [b.x0, y0]]];
      for (const [a, c] of faces) {
        const L = Math.hypot(c[0] - a[0], c[1] - a[1]), ux = (c[0] - a[0]) / L, uy = (c[1] - a[1]) / L;
        // these run round the block anticlockwise, so the left of a→c is inside: the box's
        // centre line is half the wall in from the face; its right side is the outside face
        const ia = [a[0] - uy * th / 2, a[1] + ux * th / 2], ic = [c[0] - uy * th / 2, c[1] + ux * th / 2];
        // a block whose floor is just above the ground (the ground floor, an entry): its walls go
        // on down into the ground as foundation, so the house sits on the ground
        const bottom = b.z0 > 0 && b.z0 < 0.9 ? -0.2 : b.z0;
        // in bands of height where the blocks beside it change, and only where it's out in the
        // open: where it's against another block it isn't a wall at all (the plan's own walls are
        // there, with their doorways)
        const zs = new Set([bottom, b.z0, top, 0]);
        for (const o of blocks) for (const z of [o.z0, o.z1]) if (z > bottom && z < top) zs.add(z);
        const bands = [...zs].filter((z) => z >= bottom && z <= top).sort((p, q) => p - q);
        for (let k = 0; k + 1 < bands.length; k++) {
          const lo = bands[k], hi = bands[k + 1];
          if (hi - lo < 0.01) continue;
          const holes = holesOn(a, ux, uy, L);
          for (const [s0, s1, open] of stretches(b, a, c, Math.max(lo, b.z0), hi, blocks)) {
            if (!open) continue;
            const p = (s) => [ia[0] + ux * s, ia[1] + uy * s];
            const outer = hi <= 0.001 ? "foundation" : "siding";
            // cut round the windows: full height between them, under the sill and over the top
            const cuts = holes.filter(([h0, h1, z0, z1]) => h1 > s0 && h0 < s1 && z1 > lo && z0 < hi).sort((m, n) => m[0] - n[0]);
            let at = s0;
            for (const [h0, h1, z0, z1] of cuts) {
              const q0 = Math.max(s0, h0), q1 = Math.min(s1, h1);
              if (q0 > at + 0.005) box(p(at), p(q0), th / 2, lo, hi, "plaster", "plaster", outer);
              if (z0 > lo + 0.005) box(p(q0), p(q1), th / 2, lo, Math.min(z0, hi), "plaster", "plaster", outer);
              if (z1 < hi - 0.005) box(p(q0), p(q1), th / 2, Math.max(z1, lo), hi, "plaster", "plaster", outer, true);
              at = Math.max(at, q1);
            }
            if (s1 > at + 0.005) box(p(at), p(s1), th / 2, lo, hi, "plaster", "plaster", outer);
          }
        }
      }
      // its floor, open where stairs come up through it, in what it's finished in
      const lv = (s.floors.find((f) => Math.abs(f.elevation - b.z0) < 0.06) || {}).id;
      // the floor is open over stairs coming up through it, and where another part of the house
      // runs up through this floor's height (an entry, its landing and the storage over it)
      const holes = stairHoles(t, levels, b.z0);
      for (const o of blocks) {
        if (o === b || !(o.z0 < b.z0 - 0.05 && o.z1 > b.z0 + 0.05)) continue;
        holes.push({ x0: o.x0, x1: o.x1, y0: o.y0 || 0, y1: (o.y0 || 0) + o.depth });
      }
      const rect = { x0: b.x0, x1: b.x1, y0, y1 };
      const fins = (t.finishes || []).filter((f) => f.level === lv);
      const whole = fins.find((f) => f.x0 == null);
      B.slab(whole ? FINISH_KEY[whole.kind] || "floor" : "floor", rect, holes, b.z0 + 0.004);
      for (const f of fins.filter((q) => q.x0 != null)) {
        const r = { x0: Math.max(rect.x0, f.x0), x1: Math.min(rect.x1, f.x1), y0: Math.max(rect.y0, f.y0), y1: Math.min(rect.y1, f.y1) };
        if (r.x1 - r.x0 > 0.05 && r.y1 - r.y0 > 0.05) B.slab(FINISH_KEY[f.kind] || "floor", r, holes, b.z0 + 0.008);
      }
    }

    // interior walls: solid, open under each doorway with a header over it; a wall carries on
    // through the floor framing above (no gap between storeys); a stairwell's sides run their
    // own height
    for (const w of t.walls || []) {
      const f = levels.get(w.level);
      if (!f) continue;
      const z0 = w.z0 ?? f.elevation, z1 = Math.min(w.z1 ?? f.elevation + f.ceiling + FLOOR_T, cut);
      if (z1 - z0 < 0.05 || z0 >= cut - 0.05) continue;
      for (const pc of wallPieces(w, t.doors || [], z0, z1)) box(pc.a, pc.b, (w.thick || 0.12) / 2, pc.z0, pc.z1, "plaster", "plaster", "plaster", pc.header);
    }

    // stairs: inside, each step is a tread on a slab that follows the flight's slope (head room
    // under it, as a real stair has); outside, solid down to the ground (a stoop). Where a flight
    // drops through a floor, the well's sides are walled from the floor below up to the floor above
    // (unless a plan wall is already there)
    const wallAlong = (along, c, s0, s1, z0, z1) => (t.walls || []).some((w) => {
      const f = levels.get(w.level); if (!f) return false;
      const wz0 = w.z0 ?? f.elevation, wz1 = w.z1 ?? f.elevation + f.ceiling + FLOOR_T;
      if (wz1 < z0 + 0.1 || wz0 > z1 - 0.1) return false;
      const ax = along === "x", wa = ax ? w.a[1] : w.a[0], wb = ax ? w.b[1] : w.b[0];
      if (Math.abs(wa - wb) > 0.02 || Math.abs(wa - c) > 0.15) return false;
      const p0 = Math.min(ax ? w.a[0] : w.a[1], ax ? w.b[0] : w.b[1]), p1 = Math.max(ax ? w.a[0] : w.a[1], ax ? w.b[0] : w.b[1]);
      return Math.min(p1, s1) - Math.max(p0, s0) > (s1 - s0) * 0.6;
    });
    for (const st of t.stairs || []) {
      const fl = flight(st, levels);
      if (!fl || Math.min(fl.z0, fl.z1) >= cut - 0.05) continue;
      const out = st.level === "outside" || st.to === "outside";
      const base = Math.min(fl.z0, fl.z1), topZ = Math.max(fl.z0, fl.z1);
      const [c0, c1] = fl.along === "x" ? [st.y0, st.y1] : [st.x0, st.x1];
      const slab = 0.2; // the stair's own thickness under the nosings
      for (const step of fl.steps) {
        const r = fl.along === "x" ? { x0: Math.min(step.s0, step.s1), x1: Math.max(step.s0, step.s1), y0: c0, y1: c1 } : { x0: c0, x1: c1, y0: Math.min(step.s0, step.s1), y1: Math.max(step.s0, step.s1) };
        const bottom = out ? base : Math.max(base, step.z - step.rise - slab);
        B.block(out ? "stoop" : "wood", r, bottom, Math.min(step.z, cut));
      }
      if (out) continue;
      const lo = Math.min(...fl.steps.map((q) => Math.min(q.s0, q.s1))), hi = Math.max(...fl.steps.map((q) => Math.max(q.s0, q.s1)));
      const ztop = Math.min(topZ, cut);
      for (const c of [c0, c1]) {
        if (wallAlong(fl.along, c, lo, hi, base, ztop)) continue;
        const a = fl.along === "x" ? [lo, c] : [c, lo], b2 = fl.along === "x" ? [hi, c] : [c, hi];
        box(a, b2, 0.05, base, ztop, "plaster");
      }
    }

    // windows and doors: glass (or a door) set in the wall with a white frame, outside and in
    this.garages = [];
    const win = (a, b, z0, z1, n, panes, kind, id, lite) => {
      if (z0 >= cut - 0.05) return;
      z1 = Math.min(z1, cut);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      const fill = kind === "window" ? "glass" : kind === "garage" ? "garage" : "door";
      // the glass (or the door) in the middle of the wall's thickness, a frame on each face; a
      // garage door is drawn on its own (it opens); a door with a lite has glass in its top part
      const d = -th / 2, A = [a[0] + n[0] * d, a[1] + n[1] * d], C = [b[0] + n[0] * d, b[1] + n[1] * d];
      if (kind === "garage") this.garages.push({ id, a: A, b: C, z0, z1, n, th });
      else if (fill === "door" && lite > 0) {
        const zl = z1 - (z1 - z0) * lite;
        B.wall("door", A, C, z0, zl, [n[0], n[1], 0]); B.wall("glass", A, C, zl, z1, [n[0], n[1], 0]);
        for (const dd of [0.012, -(th + 0.012)]) {
          const off = dd + Math.sign(dd) * 0.012, at = (q) => [a[0] + ux * q + n[0] * off, a[1] + uy * q + n[1] * off];
          box(at(0), at(L), 0.012, zl - 0.03, zl + 0.03, "frame");
        }
      } else B.wall(fill, A, C, z0, z1, [n[0], n[1], 0]);
      for (const d of [0.012, -(th + 0.012)]) {
        // the frame: four sides and the mullions, a little proud of the glass
        const fw = 0.05, off = d + Math.sign(d) * 0.012;
        const at = (s) => [a[0] + ux * s + n[0] * off, a[1] + uy * s + n[1] * off];
        box(at(0), at(L), 0.012, z0, z0 + fw, "frame"); box(at(0), at(L), 0.012, z1 - fw, z1, "frame");
        box(at(0), at(fw), 0.012, z0, z1, "frame"); box(at(L - fw), at(L), 0.012, z0, z1, "frame");
        for (let k = 1; k < panes; k++) box(at(L * k / panes - fw / 2), at(L * k / panes + fw / 2), 0.012, z0, z1, "frame");
      }
    };
    for (const o of (s.massing && s.massing.openings) || []) {
      const y = o.y !== undefined ? o.y : window.openingFace(o, blocks);
      win([o.x0, y], [o.x1, y], o.z0, o.z1, [0, -1], o.kind === "window" ? Math.max(1, Math.round((o.x1 - o.x0) / 1.1)) : 1, o.kind, o.id, o.lite || 0);
    }
    for (const w of t.windows || []) {
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
      let n = [(w.b[1] - w.a[1]) / L, -(w.b[0] - w.a[0]) / L];
      const mx = (w.a[0] + w.b[0]) / 2, my = (w.a[1] + w.b[1]) / 2;
      if (n[0] * (mx - s.W / 2) + n[1] * (my - s.D / 2) < 0) n = [-n[0], -n[1]];
      win(w.a, w.b, w.z0, w.z1, n, w.panes || 1, w.kind || "window", w.id, w.lite || 0);
    }

    // sloped and odd surfaces: a stairwell's sloped ceiling, a crawl space's floor
    for (const pl of t.planes || []) {
      if (Math.min(...pl.pts.map((p) => p[2])) >= cut - 0.05) continue;
      B.plane3("plaster", pl.pts.map((p) => [p[0], p[1], Math.min(p[2], cut)]));
    }

    // the ground: the lawn, with a hole where a block goes into it; the yard on it
    const gx0 = -8, gx1 = s.W + 8, gy0 = -14, gy1 = s.D + 6;
    const pits = blocks.filter((b) => b.z0 < -0.01).map((b) => ({ x0: b.x0, x1: b.x1, y0: b.y0 || 0, y1: (b.y0 || 0) + b.depth }));
    B.slab("grass", { x0: gx0, x1: gx1, y0: gy0, y1: gy1 }, pits, 0);
    const YARD = { path: "concrete", driveway: "concrete", patio: "concrete", bed: "mulch", pool: "pool", lawn: "lawn", other: "other" };
    for (const y of t.yard || []) {
      if (y.c) continue;
      for (const poly of flatPolys(y)) B.poly(YARD[y.kind] || "other", poly, y.kind === "path" ? 0.012 : 0.01);
    }
    const meshes = B.meshes((k) => this.mat(k, redraw));
    for (const m of meshes) {
      const glass = m.material === this.mats.glass;
      m.castShadow = !glass; m.receiveShadow = !glass; m.renderOrder = glass ? 2 : 0;
      this.house.add(m);
    }
    // things in the house: a TV (a thin black panel, its screen glossy), a plain box
    for (const o of t.objects || []) {
      if (o.z >= cut - 0.05) continue;
      const g = new T.Group();
      g.position.set(o.x, o.y, o.z);
      g.rotation.z = (o.rot || 0) * Math.PI / 180;
      const bodyMat = o.kind === "tv" ? this.mat("tvbody") : o.kind === "bar" ? this.mat("frame") : this.mat("plaster");
      const body = new T.Mesh(new T.BoxGeometry(o.w, o.d, o.h), bodyMat);
      body.position.set(0, 0, o.h / 2);
      g.add(body);
      if (o.kind === "tv") {
        // the screen on the front (toward -y before turning), inset in a thin bezel
        const scr = new T.Mesh(new T.PlaneGeometry(o.w - 0.02, o.h - 0.02), this.mat("screen"));
        scr.rotation.x = Math.PI / 2; scr.position.set(0, -o.d / 2 - 0.001, o.h / 2);
        g.add(scr);
      }
      g.traverse((m) => { m.castShadow = m.receiveShadow = true; });
      this.house.add(g);
    }
    // trees and bushes
    for (const y of t.yard || []) {
      if (!y.c) continue;
      const h = y.h ?? (y.kind === "tree" ? Math.max(3, y.r * 1.6) : Math.max(0.6, y.r));
      if (y.kind === "tree") {
        const trunk = new T.Mesh(new T.CylinderGeometry(0.12, 0.16, h * 0.25, 8), this.mat("trunk"));
        trunk.rotation.x = Math.PI / 2; trunk.position.set(y.c[0], y.c[1], h * 0.125);
        const crown = new T.Mesh(new T.ConeGeometry(y.r, h * 0.85, 14), this.mat("leaves"));
        crown.rotation.x = Math.PI / 2; crown.position.set(y.c[0], y.c[1], h * 0.15 + h * 0.425);
        for (const m of [trunk, crown]) { m.castShadow = m.receiveShadow = true; this.house.add(m); }
      } else {
        const bush = new T.Mesh(new T.SphereGeometry(y.r, 14, 10), this.mat("leaves"));
        bush.scale.set(1, 1, h / (2 * y.r)); bush.position.set(y.c[0], y.c[1], h / 2);
        bush.castShadow = bush.receiveShadow = true; this.house.add(bush);
      }
    }
    // the sun's shadow box: round the house
    const cx = s.W / 2, cy = s.D / 2, span = Math.max(s.W, s.D) + 16;
    this.center = [cx, cy];
    this.sky = null; // placed again by setSky
    this.sun.target.position.set(cx, cy, 0);
    const sc = this.sun.shadow.camera;
    sc.left = -span / 2; sc.right = span / 2; sc.top = span / 2; sc.bottom = -span / 2; sc.near = 1; sc.far = 120;
    sc.updateProjectionMatrix();
  }

  // the house's lights that are on: a light of their colour at each, lighting the walls round
  // them. A fixed set of lights, only changed when the lights do (a different number of lights
  // makes the GPU rebuild its shaders: slow, and too much for a tablet every frame)
  lights(glows) {
    // The nearest-together glows are joined into one light (a strip, a room's cans), so every room
    // lit gets one. The brightest cast shadows (walls stop their light); the rest light their room
    // without them, over a shorter reach
    const T = THREE, NS = this.small ? 4 : 8, NP = this.small ? 6 : 12;
    if (!this.pool) {
      const ms = this.small ? 256 : 512;
      this.pool = Array.from({ length: NS + NP }, (_, i) => {
        const l = new T.PointLight(0xffffff, 0, i < NS ? 7 : 4.5, 2);
        l.castShadow = i < NS;
        if (i < NS) { l.shadow.mapSize.set(ms, ms); l.shadow.bias = -0.002; l.shadow.camera.near = 0.05; l.shadow.camera.far = 8; }
        this.lamps.add(l); return l;
      });
    }
    const groups = [];
    for (const g of [...(glows || [])].sort((a, b) => (b.level || 0) - (a.level || 0))) {
      const z = g.z ?? g.floorZ + 2.1;
      const near = groups.find((q) => q.floorZ === g.floorZ && Math.hypot(q.x - g.x, q.y - g.y) < 1.6);
      if (near) {
        const w = near.w + (g.level || 0.5);
        near.x = (near.x * near.w + g.x * (g.level || 0.5)) / w; near.y = (near.y * near.w + g.y * (g.level || 0.5)) / w;
        near.w = w; near.level = Math.min(1.2, near.level + (g.level || 0.5) * 0.35);
      } else groups.push({ x: g.x, y: g.y, z, floorZ: g.floorZ, color: g.color, level: g.level || 0.5, w: g.level || 0.5 });
    }
    const on = groups.slice(0, NS + NP);
    const key = JSON.stringify(on.map((g) => [g.x, g.y, g.z, g.color, g.level]));
    if (key === this.lightKey) return;
    this.lightKey = key;
    this.shadowsDirty = true;
    this.pool.forEach((l, i) => {
      const g = on[i];
      if (!g) { l.intensity = 0; return; }
      l.color.set(g.color);
      l.intensity = (6 + 26 * Math.min(1, g.level)) * (i < NS ? 1 : 0.7) * (this.nightBoost || 1);
      l.position.set(g.x, g.y, g.z);
    });
  }

  // Garage doors: down in the opening, or (open) up under the ceiling, run back into the garage
  doors(s) {
    const T = THREE, open = new Set(s.open || []);
    const key = JSON.stringify([(this.garages || []).map((g) => [g.id, g.a, g.b, g.z0, g.z1]), [...open]]);
    if (key === this.doorKey) return;
    this.doorKey = key;
    this.shadowsDirty = true;
    if (!this.doorGroup) { this.doorGroup = new T.Group(); this.scene.add(this.doorGroup); }
    for (const c of [...this.doorGroup.children]) { c.geometry && c.geometry.dispose(); this.doorGroup.remove(c); }
    for (const g of this.garages || []) {
      const L = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]), H = g.z1 - g.z0;
      const mx = (g.a[0] + g.b[0]) / 2, my = (g.a[1] + g.b[1]) / 2, ang = Math.atan2(g.b[1] - g.a[1], g.b[0] - g.a[0]);
      const up = open.has(g.id);
      const m = new T.Mesh(up ? new T.BoxGeometry(L, H, 0.04) : new T.BoxGeometry(L, 0.04, H), this.mat("garage"));
      m.rotation.z = ang;
      if (up) m.position.set(mx - g.n[0] * (g.th / 2 + H / 2), my - g.n[1] * (g.th / 2 + H / 2), g.z1 - 0.04);
      else m.position.set(mx, my, g.z0 + H / 2);
      m.castShadow = m.receiveShadow = true;
      this.doorGroup.add(m);
    }
  }

  // A TV's light (an Ambilight strip behind it) when it's on: a glow of its colour on the wall
  // round the TV, and a few lights just behind its edges that wash the wall and the room
  ambilight(s) {
    const T = THREE;
    const objs = ((s.top && s.top.objects) || []).filter((o) => o.kind === "tv" && o.light);
    const state = new Map((s.ambi || []).map((a) => [a.id, a]));
    const key = JSON.stringify(objs.map((o) => [o.id, o.x, o.y, o.z, o.w, o.h, o.rot, state.get(o.id)]));
    if (key === this.ambiKey) return;
    this.ambiKey = key;
    this.shadowsDirty = true;
    if (!this.ambiGroup) { this.ambiGroup = new T.Group(); this.scene.add(this.ambiGroup); }
    if (!this.ambiPool) this.ambiPool = Array.from({ length: 4 }, () => { const l = new T.PointLight(0xffffff, 0, 3.5, 2); l.castShadow = !this.small; l.shadow.mapSize.set(256, 256); l.shadow.bias = -0.002; this.scene.add(l); return l; });
    for (const c of [...this.ambiGroup.children]) { c.geometry && c.geometry.dispose(); this.ambiGroup.remove(c); }
    this.ambiPool.forEach((l) => { l.intensity = 0; });
    let used = 0;
    for (const o of objs) {
      const a = state.get(o.id);
      if (!a || !a.on || (a.level ?? 1) <= 0.01) continue;
      const col = new T.Color(a.color || "#8fb4ff"), lvl = a.level ?? 1;
      // the glow on the wall: a soft gradient, added onto what's there
      if (!this.glowTex) {
        const c = document.createElement("canvas"); c.width = c.height = 256;
        const x = c.getContext("2d"), g = x.createRadialGradient(128, 128, 30, 128, 128, 128);
        g.addColorStop(0, "rgba(255,255,255,0.95)"); g.addColorStop(0.45, "rgba(255,255,255,0.5)"); g.addColorStop(1, "rgba(255,255,255,0)");
        x.fillStyle = g; x.fillRect(0, 0, 256, 256);
        this.glowTex = new T.CanvasTexture(c);
      }
      const m = new T.MeshBasicMaterial({ map: this.glowTex, color: col.clone().multiplyScalar(0.6 + 0.6 * lvl), transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });
      const glow = new T.Mesh(new T.PlaneGeometry(o.w * 1.9, o.h * 2.1), m);
      const g = new T.Group();
      g.position.set(o.x, o.y, o.z);
      g.rotation.z = (o.rot || 0) * Math.PI / 180;
      glow.rotation.x = Math.PI / 2; glow.position.set(0, o.d / 2 + 0.004, o.h / 2); // on the wall behind it
      g.add(glow);
      this.ambiGroup.add(g);
      g.updateMatrixWorld(true);
      // lights behind the edges, just off the wall
      for (const [dx, dz] of [[-0.5, 0.5], [0.5, 0.5], [0, 1.05], [0, -0.05]]) {
        if (used >= this.ambiPool.length) break;
        const l = this.ambiPool[used++], p = new T.Vector3(dx * o.w, -0.12, dz * o.h);
        g.localToWorld(p);
        l.position.copy(p); l.color.copy(col); l.intensity = 3 + 8 * lvl;
      }
    }
  }

  // Noon (the sun high overhead: shadows only from the eaves and overhangs on the outside) or night
  // (a dim moon straight overhead; the house's lights do the lighting, through the windows too)
  setSky(kind) {
    if (this.sky === kind || !this.center) return;
    this.sky = kind;
    const [cx, cy] = this.center, night = kind === "night";
    if (night) this.sun.position.set(cx, cy, 40);
    else this.sun.position.set(cx + 4, cy - 9, 40); // noon: a little toward the street, so the eaves shade the front
    this.sun.color.set(night ? 0x8fa6d6 : 0xfffaf0);
    this.sun.intensity = night ? 0.6 : 2.1;
    this.hemi.color.set(night ? 0x4a5c86 : 0xeaf2fb);
    this.hemi.groundColor.set(night ? 0x08080a : 0x6a5a40);
    this.hemi.intensity = night ? 0.45 : 0.9;
    this.renderer.toneMappingExposure = night ? 1.25 : 1.0;
    this.nightBoost = night ? 1.7 : 1;
    this.lightKey = null; this.ambiKey = null; // lamps pick up the night boost
    this.shadowsDirty = true;
  }

  draw(s, cam, W, H, dpr, bg, redraw) {
    const c = this.canvas;
    // the page rebuilds the stage round the 2D canvas: keep this one right under it
    const parent = this.host.parentElement;
    if (parent && (c.parentElement !== parent || c.nextSibling !== this.host)) {
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
      parent.insertBefore(c, this.host);
    }
    // the 2D canvas (lights, labels, handles) stays on top of this one
    if (this.host.style.zIndex !== "1") Object.assign(this.host.style, { position: "relative", zIndex: "1" });
    c.style.zIndex = "0";
    Object.assign(c.style, { width: W + "px", height: H + "px", left: this.host.offsetLeft + "px", top: this.host.offsetTop + "px" });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(W, H, false);
    this.build(s, redraw);
    this.setSky(s.sky === "night" ? "night" : "day");
    this.lights(s.glows);
    this.ambilight(s);
    this.doors(s);
    this.scene.background = new THREE.Color(this.sky === "night" ? "#070b14" : "#b9d1e8");
    const camera = this.camera;
    camera.fov = (2 * Math.atan(H / 2 / cam.focal) * 180) / Math.PI;
    camera.aspect = W / H;
    camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
    camera.up.set(cam.u.x, cam.u.y, cam.u.z);
    camera.lookAt(cam.pos.x + cam.f.x, cam.pos.y + cam.f.y, cam.pos.z + cam.f.z);
    camera.updateProjectionMatrix();
    if (this.shadowsDirty) { this.renderer.shadowMap.needsUpdate = true; this.shadowsDirty = false; }
    this.renderer.render(this.scene, camera);
    c.style.display = "";
  }
  hide() { this.canvas.style.display = "none"; }
};

// Floors' finishes as material keys
const FINISH_KEY = { hardwood: "hardwood", vinyl: "vinyl", tile: "tile", concrete: "concrete", carpet: "floor" };

// The stretches of a block's face from a to c: [s0, s1, open] (open: out in the open, not against
// another block)
function stretches(blk, a, c, lo, hi, blocks) {
  const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1, ux = (c[0] - a[0]) / L, uy = (c[1] - a[1]) / L;
  const alongX = Math.abs(uy) < 1e-6, cov = [];
  for (const o of blocks) {
    if (o === blk || o.z0 >= hi - 0.05 || o.z1 <= lo + 0.05) continue;
    const oy0 = o.y0 || 0, oy1 = oy0 + o.depth;
    let s0, s1;
    // another block against this face, or one this face runs through (a part of the house
    // inside another: its face there is no wall)
    const touches = (lo2, hi2, v) => Math.abs(lo2 - v) <= 0.03 || Math.abs(hi2 - v) <= 0.03 || (lo2 < v && v < hi2);
    if (alongX) {
      if (!touches(oy0, oy1, a[1])) continue;
      s0 = (o.x0 - a[0]) * ux; s1 = (o.x1 - a[0]) * ux;
    } else {
      if (!touches(o.x0, o.x1, a[0])) continue;
      s0 = (oy0 - a[1]) * uy; s1 = (oy1 - a[1]) * uy;
    }
    const p = Math.max(0, Math.min(s0, s1)), q = Math.min(L, Math.max(s0, s1));
    if (q - p > 0.02) cov.push([p, q]);
  }
  cov.sort((p, q) => p[0] - q[0]);
  const out = [];
  let s = 0;
  for (const [p, q] of cov) {
    if (p > s + 0.02) out.push([s, p, true]);
    if (q > s) { out.push([Math.max(s, p), q, false]); s = q; }
  }
  if (L > s + 0.02) out.push([s, L, true]);
  return out;
}

// The holes stairs leave in the floor at their top (the floor at height z)
function stairHoles(t, levels, z) {
  const out = [];
  for (const st of t.stairs || []) {
    if (st.level === "outside" || st.to === "outside") continue;
    const fl = flight(st, levels);
    if (fl && Math.abs(Math.max(fl.z0, fl.z1) - z) < 0.06) out.push(fl.hole);
  }
  return out;
}

// Gathers quads and flat polygons by material, then makes one mesh per material. UVs are in
// metres (along a wall and up it; across and back on the flat), so textures keep their real size
class QuadBuilder {
  constructor() { this.parts = new Map(); }
  _p(key) { if (!this.parts.has(key)) this.parts.set(key, { pos: [], nor: [], uv: [] }); return this.parts.get(key); }
  tri(key, a, b, c, n, ua, ub, uc) {
    const p = this._p(key);
    p.pos.push(...a, ...b, ...c); p.nor.push(...n, ...n, ...n); p.uv.push(...ua, ...ub, ...uc);
  }
  // an upright quad from a to b (plan points), z0..z1, facing n
  wall(key, a, b, z0, z1, n) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // u along the wall from the world origin's side, so textures line up between pieces
    const u0 = a[0] * Math.abs(n[1]) + a[1] * Math.abs(n[0]), u1 = u0 + L * Math.sign((b[0] - a[0]) * Math.abs(n[1]) + (b[1] - a[1]) * Math.abs(n[0]) || 1);
    const A0 = [a[0], a[1], z0], B0 = [b[0], b[1], z0], B1 = [b[0], b[1], z1], A1 = [a[0], a[1], z1];
    this.tri(key, A0, B0, B1, n, [u0, z0], [u1, z0], [u1, z1]);
    this.tri(key, A0, B1, A1, n, [u0, z0], [u1, z1], [u0, z1]);
  }
  // a flat convex polygon (plan points) at z, facing up (dir 1) or down (-1)
  flat(key, pts, z, dir = 1) {
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = pts[0], b = pts[i], c = pts[i + 1];
      this.tri(key, [a[0], a[1], z], [b[0], b[1], z], [c[0], c[1], z], [0, 0, dir], [a[0], a[1]], [b[0], b[1]], [c[0], c[1]]);
    }
  }
  // any flat polygon (concave too) with holes, triangulated
  poly(key, outer, z, holes = []) {
    const tris = THREE.ShapeUtils.triangulateShape(outer.map(([x, y]) => new THREE.Vector2(x, y)), holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y))));
    const all = [...outer, ...holes.flat()];
    for (const [i, j, k] of tris) {
      const a = all[i], b = all[j], c = all[k];
      this.tri(key, [a[0], a[1], z], [b[0], b[1], z], [c[0], c[1], z], [0, 0, 1], [a[0], a[1]], [b[0], b[1]], [c[0], c[1]]);
    }
  }
  // a flat polygon at any slope (3D corners, in order), uv from x and y
  plane3(key, pts) {
    const [a, b, c] = pts, u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
    const nn = n.map((q) => q / l);
    for (let i = 1; i + 1 < pts.length; i++) this.tri(key, pts[0], pts[i], pts[i + 1], nn, [pts[0][0], pts[0][1]], [pts[i][0], pts[i][1]], [pts[i + 1][0], pts[i + 1][1]]);
  }
  // a rectangle at z with rectangular holes cut out of it (clipped to it)
  slab(key, r, holes, z) {
    const ring = (q) => [[q.x0, q.y0], [q.x1, q.y0], [q.x1, q.y1], [q.x0, q.y1]];
    const hs = holes
      .map((h) => ({ x0: Math.max(h.x0, r.x0 + 0.01), x1: Math.min(h.x1, r.x1 - 0.01), y0: Math.max(h.y0, r.y0 + 0.01), y1: Math.min(h.y1, r.y1 - 0.01) }))
      .filter((h) => h.x1 - h.x0 > 0.05 && h.y1 - h.y0 > 0.05);
    // holes that touch or overlap become one (their bounding box): the triangulator needs them apart
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < hs.length && !merged; i++) for (let j = i + 1; j < hs.length && !merged; j++) {
        const p = hs[i], q = hs[j];
        if (p.x0 <= q.x1 + 0.01 && q.x0 <= p.x1 + 0.01 && p.y0 <= q.y1 + 0.01 && q.y0 <= p.y1 + 0.01) {
          hs[i] = { x0: Math.min(p.x0, q.x0), x1: Math.max(p.x1, q.x1), y0: Math.min(p.y0, q.y0), y1: Math.max(p.y1, q.y1) };
          hs.splice(j, 1); merged = true;
        }
      }
    }
    const rings = hs.map((h) => ring(h).reverse());
    this.poly(key, ring(r), z, rings);
  }
  // a solid block over a rectangle from z0 to z1
  block(key, r, z0, z1) {
    if (z1 - z0 < 0.005) return;
    const c = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    const ns = [[0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]];
    for (let i = 0; i < 4; i++) this.wall(key, c[i], c[(i + 1) % 4], z0, z1, ns[i]);
    this.flat(key, c, z1, 1);
  }
  meshes(material) {
    const out = [];
    for (const [key, p] of this.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(p.pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(p.nor, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(p.uv, 2));
      out.push(new THREE.Mesh(g, material(key)));
    }
    return out;
  }
}
