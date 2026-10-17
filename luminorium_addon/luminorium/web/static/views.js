// Views: a photo of the house with lights placed on it (by hand, or from camera mapping), planes,
// and the review editor (merge, split, reorder, rename, assign planes). Relative URLs (Ingress).
// No prompt()/confirm()/alert(): the HA companion app's webview may not show them.
"use strict";

const $ = (s) => document.querySelector(s);
// The shell has no page links of its own: put "Map with the camera" in its top bar
if (window.L) L.topExtra().append(L.el("a.btn.small#to-capture", { href: "capture" }, L.icon("camera", 16), "Map with the camera"));
const S = {
  views: [],
  view: null,
  units: [], // {id, name, area, floor, kind}
  unitName: {},
  areas: [],
  mode: "place", // place | plane
  armed: null, // a unit to place with the next tap
  placing: null, // an element without a position, placed with the next tap
  sel: null, // selected element id
  merging: false,
  mergePick: new Set(),
  planePts: [],
  linePts: null, // drawing a segment line: [] then [p] then done
  drag: null,
  search: "",
  vh: 1000, // viewBox height for the photo's aspect
};

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || res.statusText);
  return body;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}
async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
  }
}
const vpath = (p) => `api/views/${S.view.id}${p}`;

// ---- data --------------------------------------------------------------------------------------

async function loadInventory() {
  const inv = await api("api/inventory");
  const areaName = Object.fromEntries(inv.areas.map((a) => [a.id, a.name]));
  const floorName = Object.fromEntries(inv.floors.map((f) => [f.id, f.name]));
  const units = [];
  for (const f of inv.fixtures) {
    units.push({ id: f.id, name: f.name, area: f.area_id, floor: f.floor_id, kind: "fixture" });
  }
  for (const l of inv.lights) {
    if (!l.included || l.fixture || !["light", "switch"].includes(l.kind)) continue;
    units.push({ id: l.entity_id, name: l.name, area: l.area_id, floor: l.floor_id, kind: l.kind,
      segments: l.segments || [] });
    for (const s of l.segments || []) S.unitName[s] = `${l.name} ${s.split("_").pop()}`;
  }
  for (const u of units) S.unitName[u.id] = u.name;
  const order = inv.floors.map((f) => f.id);
  const byArea = new Map();
  for (const u of units) {
    const key = `${u.floor}|${u.area}`;
    if (!byArea.has(key)) byArea.set(key, { floor: u.floor, area: u.area, units: [] });
    byArea.get(key).units.push(u);
  }
  S.areas = [...byArea.values()].sort(
    (a, b) => (order.indexOf(a.floor) - order.indexOf(b.floor)) || String(areaName[a.area]).localeCompare(areaName[b.area]),
  );
  for (const a of S.areas) {
    a.label = `${areaName[a.area] || "No area"} · ${floorName[a.floor] || "no floor"}`;
    a.units.sort((x, y) => x.name.localeCompare(y.name));
  }
  S.units = units;
}

async function loadViews(select) {
  S.views = await api("api/views");
  const want = select || new URLSearchParams(location.search).get("view") || (S.view && S.view.id);
  const id = S.views.find((v) => v.id === want) ? want : S.views.length ? S.views[0].id : null;
  S.view = id ? await api(`api/views/${id}`) : null;
  render();
}
async function reload() {
  S.view = await api(`api/views/${S.view.id}`);
  const summary = S.views.find((v) => v.id === S.view.id);
  if (summary) summary.elements = S.view.elements.length;
  render();
}

// ---- rendering ---------------------------------------------------------------------------------

function render() {
  const pick = $("#view-pick");
  pick.innerHTML = "";
  for (const v of S.views) {
    const o = new Option(`${v.name} (${v.elements})`, v.id);
    pick.append(o);
  }
  $("#empty").hidden = !!S.view;
  $("#editor").hidden = !S.view;
  $("#view-delete").hidden = !S.view;
  if (!S.view) return;
  pick.value = S.view.id;
  if (document.activeElement !== $("#view-name")) $("#view-name").value = S.view.name;
  $("#to-capture").href = `capture?view=${S.view.id}`;
  const img = $("#photo");
  const src = S.view.photo ? `${vpath("/photo")}?f=${S.view.photo.file}` : "";
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    if (src) img.src = src;
    else img.removeAttribute("src");
  }
  img.hidden = !src;
  $("#nophoto").hidden = !!src;
  if (S.view.photo) S.vh = (1000 * S.view.photo.height) / S.view.photo.width;
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
  $("#plane-form").hidden = S.mode !== "plane";
  $("#plane-save").disabled = S.planePts.length !== 4;
  hint();
  drawOverlay();
  renderPalette();
  renderPlanes();
  renderElementPanel();
  const m = S.view.mapping;
  $("#mapping-info").hidden = !m;
  if (m) {
    const missing = (m.missing || []).map((u) => S.unitName[u] || u);
    $("#mapping-text").textContent =
      `From capture ${m.session}: focal length ${m.focal_px} px, ` +
      `${m.metric ? "positions in metres" : "positions to scale, not in metres (no known distance)"}.` +
      (missing.length ? ` Not found by the camera: ${missing.join(", ")}.` : "");
  }
}

function hint() {
  let h = "";
  if (S.armed) h = `Tap where ${S.unitName[S.armed]} is.`;
  else if (S.placing) h = "Tap where this element is.";
  else if (S.linePts) h = S.linePts.length ? "Tap the end of the line." : "Tap the start of the line (the first segment).";
  else if (S.merging) h = "Tap the elements to merge with.";
  else if (S.mode === "plane") h = `Corner ${Math.min(S.planePts.length + 1, 4)} of 4.`;
  $("#hint").textContent = h;
}

const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent.append(el);
  return el;
}
const X = (p) => p[0] * 1000;
const Y = (p) => p[1] * S.vh;
const pts = (poly) => poly.map((p) => `${X(p)},${Y(p)}`).join(" ");

function drawOverlay() {
  const o = $("#overlay");
  o.setAttribute("viewBox", `0 0 1000 ${S.vh}`);
  o.innerHTML = "";
  const r = 9;
  for (const pl of S.view.planes) svg("polygon", { points: pts(pl.points), class: "plane" }, o);
  for (const el of S.view.elements) {
    if (!el.centroid) continue;
    const cls = ["region"];
    if (el.id === S.sel) cls.push("sel");
    if (S.mergePick.has(el.id) && el.id !== S.sel) cls.push("pick");
    if (el.note && el.note.startsWith("check")) cls.push("check");
    if (el.region && el.region.length >= 3) svg("polygon", { points: pts(el.region), class: cls.join(" "), "data-el": el.id }, o);
    if (el.line) svg("line", { x1: X(el.line[0]), y1: Y(el.line[0]), x2: X(el.line[1]), y2: Y(el.line[1]), class: "line" }, o);
    if (el.mode === "segments" || el.parts.length > 1) {
      el.parts.forEach((p) => p.centroid && svg("circle", { cx: X(p.centroid), cy: Y(p.centroid), r: 5, class: "part" }, o));
    }
    svg("circle", { cx: X(el.centroid), cy: Y(el.centroid), r, class: "handle", "data-handle": el.id }, o);
  }
  for (const p of S.planePts) svg("circle", { cx: X(p), cy: Y(p), r: 8, class: "tap" }, o);
  if (S.linePts) for (const p of S.linePts) svg("circle", { cx: X(p), cy: Y(p), r: 8, class: "tap" }, o);
}

function placedSet() {
  return new Set(S.view.elements.flatMap((e) => e.parts.map((p) => p.member)));
}

function renderPalette() {
  const box = $("#palette");
  box.innerHTML = "";
  const placed = placedSet();
  const placedParents = new Set(S.units.filter((u) => (u.segments || []).some((s) => placed.has(s))).map((u) => u.id));
  $("#placed-count").textContent = `${S.units.filter((u) => placed.has(u.id) || placedParents.has(u.id)).length} of ${S.units.length} placed`;
  const unplaced = S.view.elements.filter((e) => !e.centroid);
  if (unplaced.length) {
    const d = document.createElement("div");
    d.innerHTML = `<p class="small"><b>Found by the camera, not on this photo yet:</b></p>`;
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const el of unplaced) {
      const b = document.createElement("button");
      b.className = "chip" + (S.placing === el.id ? " armed" : "");
      b.textContent = el.name;
      b.title = el.note;
      b.onclick = () => { S.placing = S.placing === el.id ? null : el.id; S.armed = null; render(); };
      chips.append(b);
    }
    d.append(chips);
    box.append(d);
  }
  const q = S.search.toLowerCase();
  for (const a of S.areas) {
    const units = a.units.filter((u) => !q || `${u.name} ${u.id}`.toLowerCase().includes(q));
    if (!units.length) continue;
    const det = document.createElement("details");
    det.className = "palette-area";
    det.open = !!q || units.some((u) => u.id === S.armed);
    const n = units.filter((u) => placed.has(u.id) || placedParents.has(u.id)).length;
    det.innerHTML = `<summary></summary><div class="chips"></div>`;
    det.querySelector("summary").innerHTML = `${a.label} <span class="muted small">${n}/${units.length}</span>`;
    const chips = det.querySelector(".chips");
    for (const u of units) {
      const b = document.createElement("button");
      const isPlaced = placed.has(u.id) || placedParents.has(u.id);
      b.className = "chip" + (isPlaced ? " placed" : "") + (S.armed === u.id ? " armed" : "");
      b.textContent = u.kind === "fixture" ? `${u.name} (fixture)` : u.name;
      b.onclick = () => {
        if (isPlaced) {
          const el = S.view.elements.find((e) => e.parts.some((p) => p.member === u.id || (u.segments || []).includes(p.member)));
          S.sel = el ? el.id : null;
          S.armed = null;
        } else {
          S.armed = S.armed === u.id ? null : u.id;
          S.placing = null;
          S.mode = "place";
        }
        render();
      };
      chips.append(b);
    }
    box.append(det);
  }
}

function renderPlanes() {
  const ul = $("#planes");
  ul.innerHTML = "";
  if (!S.view.planes.length) {
    ul.innerHTML = `<li class="muted small">None. Mark the lawn (ground) or the house front so lights
      on them get real positions.</li>`;
  }
  for (const pl of S.view.planes) {
    const li = document.createElement("li");
    li.innerHTML = `<b></b><span class="muted small"></span>
      <input type="number" min="0" step="0.1" class="num" placeholder="w m">×<input type="number" min="0" step="0.1" class="num" placeholder="h m">
      <button class="link small">Save size</button><button class="link small danger">Delete</button>`;
    li.querySelector("b").textContent = pl.name;
    li.querySelector("span").textContent = pl.kind;
    const [w, h] = li.querySelectorAll("input");
    if (pl.size) { w.value = pl.size[0]; h.value = pl.size[1]; }
    const [save, del] = li.querySelectorAll("button");
    save.onclick = () => run(async () => {
      const size = w.value && h.value ? [Number(w.value), Number(h.value)] : null;
      await api(vpath(`/planes/${pl.id}`), { method: "PUT", body: JSON.stringify({ size }) });
      await reload();
    });
    del.onclick = () => run(async () => { await api(vpath(`/planes/${pl.id}`), { method: "DELETE" }); await reload(); });
    ul.append(li);
  }
}

function fmtWorld(w) {
  if (!w) return "no real-world position";
  const u = w.metric ? " m" : "";
  if (w.method === "triangulated") return `3D: ${w.x.toFixed(2)}, ${w.y.toFixed(2)}, ${w.z.toFixed(2)}${u} (from the stations)`;
  if (w.method === "plane") return `on the plane: ${w.u.toFixed(2)}${u} across, ${w.v.toFixed(2)}${u} along`;
  if (w.method === "ray") return "seen from one station only: direction known, distance not";
  return w.method;
}

function renderElementPanel() {
  const el = S.view.elements.find((e) => e.id === S.sel);
  $("#element-panel").hidden = !el;
  if (!el) return;
  if (document.activeElement !== $("#el-name")) $("#el-name").value = el.name;
  $("#el-mode").value = el.mode;
  const pick = $("#el-plane");
  pick.innerHTML = "";
  pick.append(new Option("Free (no plane)", ""));
  for (const pl of S.view.planes) pick.append(new Option(`On ${pl.name}`, pl.id));
  pick.value = el.plane || "";
  const conf = el.confidence != null ? ` · confidence ${Math.round(el.confidence * 100)} %` : "";
  $("#el-info").textContent = `${el.source === "mapping" ? "Mapped" : "Placed by hand"}${conf} · ${fmtWorld(el.world)}${el.note ? ` · ${el.note}` : ""}`;
  const ol = $("#el-parts");
  ol.innerHTML = "";
  el.parts.forEach((p, i) => {
    const li = document.createElement("li");
    const lat = p.latency_ms != null ? ` · ${p.latency_ms} ms` : "";
    li.textContent = `${S.unitName[p.member] || p.member}${lat}`;
    if (el.parts.length > 1) {
      for (const [label, d] of [["↑", -1], ["↓", 1]]) {
        const b = document.createElement("button");
        b.className = "link";
        b.textContent = label;
        b.disabled = (d < 0 && i === 0) || (d > 0 && i === el.parts.length - 1);
        b.onclick = () => run(async () => {
          const m = el.parts.map((x) => x.member);
          [m[i], m[i + d]] = [m[i + d], m[i]];
          await api(vpath(`/elements/${el.id}/order`), { method: "PUT", body: JSON.stringify({ members: m }) });
          await reload();
        });
        li.append(b);
      }
    }
    ol.append(li);
  });
  $("#el-split").disabled = el.parts.length < 2;
  $("#merge-bar").hidden = !S.merging;
  $("#merge-count").textContent = `${S.mergePick.size} picked`;
}

// ---- interaction -------------------------------------------------------------------------------

function toNorm(ev) {
  const r = $("#overlay").getBoundingClientRect();
  return [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
}
function hit(p) {
  const r = $("#overlay").getBoundingClientRect();
  let best = null;
  for (const el of S.view.elements) {
    if (!el.centroid) continue;
    const d = Math.hypot((el.centroid[0] - p[0]) * r.width, (el.centroid[1] - p[1]) * r.height);
    if (d < 24 && (!best || d < best.d)) best = { el, d, handle: true };
  }
  if (best) return best;
  for (const el of S.view.elements) if (el.region && el.region.length >= 3 && inside(p, el.region)) return { el, handle: false };
  return null;
}
function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function onDown(ev) {
  if (!S.view.photo) return;
  const p = toNorm(ev);
  if (S.mode === "plane") {
    if (S.planePts.length < 4) S.planePts.push(p);
    return render();
  }
  if (S.linePts) {
    S.linePts.push(p);
    if (S.linePts.length === 2) {
      const line = S.linePts;
      S.linePts = null;
      run(async () => {
        await api(vpath(`/elements/${S.sel}`), { method: "PUT", body: JSON.stringify({ line, mode: "segments" }) });
        await reload();
      });
    }
    return render();
  }
  if (S.armed) {
    const member = S.armed;
    S.armed = null;
    run(async () => {
      const el = await api(vpath("/elements"), { method: "POST", body: JSON.stringify({ members: [member], centroid: p }) });
      S.sel = el.id;
      await reload();
    });
    return;
  }
  if (S.placing) {
    const id = S.placing;
    S.placing = null;
    run(async () => {
      await api(vpath(`/elements/${id}`), { method: "PUT", body: JSON.stringify({ centroid: p }) });
      S.sel = id;
      await reload();
    });
    return;
  }
  const h = hit(p);
  if (S.merging) {
    if (h && h.el.id !== S.sel) {
      if (S.mergePick.has(h.el.id)) S.mergePick.delete(h.el.id);
      else S.mergePick.add(h.el.id);
    }
    return render();
  }
  S.sel = h ? h.el.id : null;
  if (h && h.handle) {
    S.drag = { id: h.el.id, start: p, moved: false };
    $("#overlay").setPointerCapture(ev.pointerId);
  }
  render();
}
function onMove(ev) {
  if (!S.drag) return;
  const p = toNorm(ev);
  const el = S.view.elements.find((e) => e.id === S.drag.id);
  const dx = p[0] - el.centroid[0];
  const dy = p[1] - el.centroid[1];
  if (!S.drag.moved && Math.hypot(p[0] - S.drag.start[0], p[1] - S.drag.start[1]) < 0.004) return;
  S.drag.moved = true;
  const shift = (q) => [q[0] + dx, q[1] + dy];
  el.centroid = p;
  el.region = (el.region || []).map(shift);
  el.parts.forEach((x) => x.centroid && (x.centroid = shift(x.centroid)));
  if (el.line) el.line = el.line.map(shift);
  drawOverlay();
}
function onUp() {
  const d = S.drag;
  S.drag = null;
  if (!d || !d.moved) return;
  const el = S.view.elements.find((e) => e.id === d.id);
  run(async () => {
    await api(vpath(`/elements/${d.id}`), { method: "PUT", body: JSON.stringify({ centroid: el.centroid }) });
    await reload();
  });
}

function bind() {
  const o = $("#overlay");
  o.addEventListener("pointerdown", onDown);
  o.addEventListener("pointermove", onMove);
  o.addEventListener("pointerup", onUp);
  o.addEventListener("pointercancel", onUp);
  $("#view-pick").onchange = (e) => { S.sel = null; loadViews(e.target.value); };
  $("#view-new").onclick = () => run(async () => {
    const v = await api("api/views", { method: "POST", body: JSON.stringify({ name: $("#view-name").value.trim() || "Front of house" }) });
    await loadViews(v.id);
  });
  $("#view-name").onchange = (e) => S.view && run(async () => {
    await api(`api/views/${S.view.id}`, { method: "PUT", body: JSON.stringify({ name: e.target.value }) });
    await loadViews(S.view.id);
  });
  let deleteArmed = false;
  $("#view-delete").onclick = (e) => {
    if (!deleteArmed) {
      deleteArmed = true;
      e.target.textContent = "Tap again to delete this view";
      setTimeout(() => { deleteArmed = false; e.target.textContent = "Delete view"; }, 4000);
      return;
    }
    run(async () => { await api(`api/views/${S.view.id}`, { method: "DELETE" }); S.view = null; await loadViews(); });
  };
  $("#photo-file").onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    run(async () => {
      const res = await fetch(vpath("/photo"), { method: "PUT", body: f });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || res.statusText);
      if (S.view.elements.length) toast(body.registered ? "Photo replaced; placements moved to match it." : "Photo replaced; check the placements.");
      await reload();
    });
    e.target.value = "";
  };
  document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => {
    S.mode = b.dataset.mode;
    S.planePts = [];
    S.armed = S.placing = null;
    render();
  }));
  $("#plane-cancel").onclick = () => { S.mode = "place"; S.planePts = []; render(); };
  $("#plane-save").onclick = () => run(async () => {
    const w = Number($("#plane-w").value);
    const h = Number($("#plane-h").value);
    await api(vpath("/planes"), { method: "POST", body: JSON.stringify({
      name: $("#plane-name").value.trim() || ($("#plane-kind").value === "ground" ? "Ground" : "Wall"),
      kind: $("#plane-kind").value, points: S.planePts, size: w > 0 && h > 0 ? [w, h] : null,
    }) });
    S.planePts = [];
    S.mode = "place";
    await reload();
  });
  const put = (body) => run(async () => { await api(vpath(`/elements/${S.sel}`), { method: "PUT", body: JSON.stringify(body) }); await reload(); });
  $("#el-name").onchange = (e) => put({ name: e.target.value });
  $("#el-mode").onchange = (e) => put({ mode: e.target.value });
  $("#el-plane").onchange = (e) => put({ plane: e.target.value || null });
  $("#el-line").onclick = () => { S.linePts = []; render(); };
  $("#el-split").onclick = () => run(async () => { await api(vpath(`/elements/${S.sel}/split`), { method: "POST" }); S.sel = null; await reload(); });
  $("#el-delete").onclick = () => run(async () => { await api(vpath(`/elements/${S.sel}`), { method: "DELETE" }); S.sel = null; await reload(); });
  $("#el-close").onclick = () => { S.sel = null; S.merging = false; S.mergePick.clear(); render(); };
  $("#el-merge").onclick = () => { S.merging = true; S.mergePick = new Set([S.sel]); render(); };
  $("#merge-cancel").onclick = () => { S.merging = false; S.mergePick.clear(); render(); };
  const merge = (mode) => run(async () => {
    if (S.mergePick.size < 2) throw new Error("Tap at least one more element on the photo");
    const el = await api(vpath("/elements/merge"), { method: "POST", body: JSON.stringify({ ids: [...S.mergePick], mode }) });
    S.merging = false;
    S.mergePick.clear();
    S.sel = el.id;
    await reload();
  });
  $("#merge-single").onclick = () => merge("single");
  $("#merge-segments").onclick = () => merge("segments");
  $("#light-search").oninput = (e) => { S.search = e.target.value.trim(); renderPalette(); };
  $("#stopall").onclick = () => run(async () => { const r = await api("api/stop_all", { method: "POST" }); toast(`Stopped; ${r.restored} light(s) restored`); });
}

bind();
run(async () => {
  await loadInventory();
  await loadViews();
});
