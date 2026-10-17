// Guided camera mapping (DESIGN.md section 8). The phone streams 640-wide JPEG frames at about
// 15 fps with its own timestamps, plus motion and orientation samples, over a websocket; the
// add-on runs the flash pass and the analysis. Relative URLs only (HA Ingress).
// No prompt()/confirm()/alert(): the HA companion app's webview may not show them.
"use strict";

const $ = (s) => document.querySelector(s);
// The shell has no page links of its own: put "Views" in its top bar
if (window.L) L.topExtra().append(L.el("a.btn.small#to-view", { href: "views" }, L.icon("views", 16), "Views"));
const FPS = 15;
const WIDTH = 640;
const MAX_IN_FLIGHT = 3; // frames sent but not yet acknowledged
const STATIONS = ["centre", "left", "right"];
const TARGET = { centre: 0, left: 45, right: -45 }; // compass turn from the centre station
const LABEL = { centre: "centre", left: "left (about 45°)", right: "right (about 45°)" };

const C = {
  readOnly: false,
  views: [],
  units: [],
  name: {},
  areas: [],
  picked: new Set(),
  search: "",
  session: null,
  ws: null,
  video: null,
  canvas: document.createElement("canvas"),
  seq: 0,
  inFlight: 0,
  lastSent: 0,
  motion: [],
  orientation: [],
  rot: 0,
  heading: null,
  h0: null,
  running: null, // the station being captured
  cameraOk: false,
  phase: "",
};

const now = () => (performance.timeOrigin + performance.now()) / 1000;

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
  toast.timer = setTimeout(() => (t.hidden = true), 5000);
}
async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
  }
}
function say(text) {
  $("#say").textContent = text;
}

// ---- 1. what's visible --------------------------------------------------------------------------

async function loadSetup() {
  const [status, views, inv] = await Promise.all([api("api/status"), api("api/views"), api("api/inventory")]);
  C.readOnly = status.read_only;
  if (C.readOnly) {
    $("#banner").hidden = false;
    $("#banner").textContent = "Luminorium is read-only: mapping flashes lights, so it is switched off.";
  }
  C.views = views;
  const pick = $("#view-pick");
  pick.innerHTML = "";
  if (!views.length) pick.append(new Option("Make a view first (Views page)", ""));
  for (const v of views) pick.append(new Option(v.name, v.id));
  const want = new URLSearchParams(location.search).get("view");
  if (want && views.some((v) => v.id === want)) pick.value = want;

  const areaName = Object.fromEntries(inv.areas.map((a) => [a.id, a.name]));
  const floorName = Object.fromEntries(inv.floors.map((f) => [f.id, f.name]));
  const units = inv.fixtures.map((f) => ({ id: f.id, name: `${f.name} (fixture)`, area: f.area_id, floor: f.floor_id, on: false }));
  for (const l of inv.lights) {
    if (!l.included || l.fixture || !["light", "switch"].includes(l.kind) || !l.available) continue;
    units.push({ id: l.entity_id, name: l.name, area: l.area_id, floor: l.floor_id, on: l.state === "on" });
  }
  C.units = units;
  for (const u of units) C.name[u.id] = u.name;
  const order = inv.floors.map((f) => f.id);
  const groups = new Map();
  for (const u of units) {
    const k = `${u.floor}|${u.area}`;
    if (!groups.has(k)) groups.set(k, { label: `${areaName[u.area] || "No area"} · ${floorName[u.floor] || "no floor"}`, floor: u.floor, units: [] });
    groups.get(k).units.push(u);
  }
  C.areas = [...groups.values()].sort((a, b) => (order.indexOf(a.floor) - order.indexOf(b.floor)) || a.label.localeCompare(b.label));
  renderPickers();
}

function renderPickers() {
  const box = $("#pickers");
  box.innerHTML = "";
  const q = C.search.toLowerCase();
  for (const a of C.areas) {
    const units = a.units.filter((u) => !q || `${u.name} ${u.id}`.toLowerCase().includes(q));
    if (!units.length) continue;
    const det = document.createElement("details");
    det.className = "palette-area area-box";
    det.open = !!q || units.some((u) => C.picked.has(u.id));
    const n = units.filter((u) => C.picked.has(u.id)).length;
    det.innerHTML = `<summary></summary>`;
    const sum = det.querySelector("summary");
    sum.textContent = `${a.label} `;
    const count = document.createElement("span");
    count.className = "muted small";
    count.textContent = `${n}/${units.length}`;
    sum.append(count);
    const all = document.createElement("label");
    all.className = "small";
    all.innerHTML = `<input type="checkbox"> <span>All in this area</span>`;
    all.querySelector("input").checked = n === units.length;
    all.querySelector("input").onchange = (e) => {
      for (const u of units) e.target.checked ? C.picked.add(u.id) : C.picked.delete(u.id);
      renderPickers();
    };
    det.append(all);
    for (const u of units) {
      const lab = document.createElement("label");
      lab.innerHTML = `<input type="checkbox"> <span></span>`;
      lab.querySelector("span").textContent = u.name + (u.on ? " (on)" : "");
      const box2 = lab.querySelector("input");
      box2.checked = C.picked.has(u.id);
      box2.onchange = () => {
        box2.checked ? C.picked.add(u.id) : C.picked.delete(u.id);
        renderPickers();
      };
      det.append(lab);
    }
    box.append(det);
  }
  const picked = [...C.picked];
  $("#picked").textContent = picked.length ? `${picked.length} picked.` : "Nothing picked yet.";
  for (const id of ["#kd-a", "#kd-b"]) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = "";
    sel.append(new Option("—", ""));
    for (const uid of picked) sel.append(new Option(C.name[uid], uid));
    sel.value = picked.includes(keep) ? keep : "";
  }
  $("#begin").disabled = C.readOnly || !picked.length || !$("#view-pick").value;
}

// ---- 2. camera, sensors, websocket --------------------------------------------------------------

async function sensors() {
  try {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      await DeviceMotionEvent.requestPermission();
    }
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch {
    // no permission: mapping still works, without jolt retakes and compass guidance
  }
  window.addEventListener("devicemotion", (e) => {
    const r = e.rotationRate || {};
    const a = e.acceleration || {};
    const t = (performance.timeOrigin + e.timeStamp) / 1000;
    C.motion.push([t, r.alpha || 0, r.beta || 0, r.gamma || 0, a.x || 0, a.y || 0, a.z || 0]);
    const mag = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
    C.rot = 0.85 * C.rot + 0.15 * mag;
  });
  const onOrient = (e) => {
    let h = e.webkitCompassHeading;
    if (h == null && e.alpha != null) h = compassHeading(e.alpha, e.beta || 0, e.gamma || 0);
    if (h == null) return;
    C.heading = h;
    C.orientation.push([(performance.timeOrigin + e.timeStamp) / 1000, e.alpha, e.beta, e.gamma]);
  };
  if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", onOrient);
  else window.addEventListener("deviceorientation", onOrient);
  setInterval(flushSensors, 100);
  setInterval(guidance, 150);
}

// The direction the back of the phone faces, from the orientation angles (W3C example).
function compassHeading(alpha, beta, gamma) {
  const d = Math.PI / 180;
  const [x, y, z] = [beta * d, gamma * d, alpha * d];
  const vx = -Math.cos(z) * Math.sin(y) - Math.sin(z) * Math.sin(x) * Math.cos(y);
  const vy = -Math.sin(z) * Math.sin(y) + Math.cos(z) * Math.sin(x) * Math.cos(y);
  let h = Math.atan(vx / vy);
  if (vy < 0) h += Math.PI;
  else if (vx < 0) h += 2 * Math.PI;
  return h / d;
}

function flushSensors() {
  if (!C.ws || C.ws.readyState !== 1) return;
  if (C.motion.length) C.ws.send(JSON.stringify({ type: "motion", samples: C.motion.splice(0) }));
  if (C.orientation.length) C.ws.send(JSON.stringify({ type: "orientation", samples: C.orientation.splice(0) }));
}

function meter(el, frac, cls) {
  el.className = `meter ${cls}`;
  el.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}

function guidance() {
  const rot = C.rot;
  meter($("#steady"), 1 - rot / 45, rot < 15 ? "" : rot < 30 ? "warn" : "bad");
  const next = nextStation();
  const target = next ? TARGET[next] : 0;
  if (C.heading == null) {
    $("#compass-text").textContent = "Compass: not available";
    return;
  }
  if (C.h0 == null || !target) {
    $("#compass-text").textContent = C.h0 == null ? "Compass: ready" : "Compass: at the centre";
    meter($("#turn"), 0, "");
    return;
  }
  let turned = C.heading - C.h0;
  turned = ((turned + 540) % 360) - 180;
  const toward = Math.sign(target) === Math.sign(turned) ? Math.abs(turned) : 0;
  const left = target > 0 ? "left" : "right";
  $("#compass-text").textContent = `Walk ${left}, keeping the anchor in the circle: ${Math.round(toward)}° of 45°`;
  meter($("#turn"), toward / 45, Math.abs(toward - 45) < 8 ? "" : "warn");
}

async function camera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  const v = $("#video");
  v.srcObject = stream;
  await v.play().catch(() => {});
  C.video = v;
  C.cameraOk = true;
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    const loop = (_t, meta) => {
      const ts = meta && (meta.captureTime || meta.expectedDisplayTime);
      sendFrame(ts ? (performance.timeOrigin + ts) / 1000 : now());
      v.requestVideoFrameCallback(loop);
    };
    v.requestVideoFrameCallback(loop);
  } else {
    setInterval(() => sendFrame(now()), 1000 / FPS);
  }
}

function sendFrame(t) {
  const v = C.video;
  if (!v || !v.videoWidth || !C.ws || C.ws.readyState !== 1) return;
  if (t - C.lastSent < 1 / FPS - 0.008 || C.inFlight >= MAX_IN_FLIGHT) return;
  C.lastSent = t;
  const h = Math.round((WIDTH * v.videoHeight) / v.videoWidth);
  C.canvas.width = WIDTH;
  C.canvas.height = h;
  C.canvas.getContext("2d").drawImage(v, 0, 0, WIDTH, h);
  const seq = C.seq++;
  C.inFlight++;
  C.canvas.toBlob((jpeg) => {
    if (!jpeg || !C.ws || C.ws.readyState !== 1) {
      C.inFlight = Math.max(0, C.inFlight - 1);
      return;
    }
    const head = new ArrayBuffer(16);
    const dv = new DataView(head);
    "LMF1".split("").forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
    dv.setUint32(4, seq, true);
    dv.setFloat64(8, t, true);
    C.ws.send(new Blob([head, jpeg]));
  }, "image/jpeg", 0.92);
}

function sendPhoto() {
  const v = C.video;
  if (!v || !v.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  c.toBlob((jpeg) => {
    if (jpeg && C.ws && C.ws.readyState === 1) C.ws.send(new Blob([new TextEncoder().encode("LMP1"), jpeg]));
  }, "image/jpeg", 0.92);
}

function connect() {
  const url = new URL(`api/mapping/sessions/${C.session.id}/ws`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  C.ws = ws;
  ws.onopen = () => {
    $("#link").textContent = "connected";
    ws.send(JSON.stringify({ type: "hello" }));
  };
  ws.onclose = () => {
    $("#link").textContent = "disconnected";
    C.inFlight = 0;
    if (C.running) say("Connection lost: the lights were put back. Start this station again.");
    C.running = null;
    renderStations();
    setTimeout(() => C.ws === ws && connect(), 3000);
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
}

async function refresh() {
  C.session = await api(`api/mapping/sessions/${C.session.id}`);
  renderStations();
  if (C.session.results) showResults(C.session.results);
}

function onMessage(m) {
  switch (m.type) {
    case "ack":
      C.inFlight = Math.max(0, C.inFlight - 1);
      break;
    case "ping":
      C.ws.send(JSON.stringify({ type: "pong", server: m.server, phone: now() }));
      break;
    case "photo":
      sendPhoto();
      break;
    case "state":
      C.session = m.session;
      renderStations();
      break;
    case "phase":
      C.phase = m.phase;
      say(m.message || m.phase);
      break;
    case "station_done":
      C.running = null;
      say(m.next ? `Done. Now walk to the ${LABEL[m.next]} station, keeping the anchor in the circle.` : "All stations done. Analysing…");
      run(refresh);
      break;
    case "analysis":
    case "results":
      run(refresh);
      break;
    case "stopped":
      C.running = null;
      say(m.message || "Stopped; the lights were put back.");
      run(refresh);
      break;
    case "error":
      toast(m.message);
      break;
  }
}

function nextStation() {
  if (!C.session) return "centre";
  const st = C.session.stations.find((s) => ["pending", "failed"].includes(s.state));
  return st ? st.name : null;
}

function renderStations() {
  const box = $("#stations");
  box.innerHTML = "";
  const next = nextStation();
  for (const s of (C.session && C.session.stations) || []) {
    const d = document.createElement("div");
    d.className = "station" + (s.name === next ? " next" : "");
    d.innerHTML = `<b></b><span class="small muted"></span>`;
    d.querySelector("b").textContent = LABEL[s.name] || s.name;
    d.querySelector("span").textContent = `${s.state}${s.message ? `: ${s.message}` : ""}`;
    box.append(d);
  }
  const go = $("#go");
  go.disabled = !C.cameraOk || !!C.running || !next || !C.ws || C.ws.readyState !== 1;
  go.textContent = next ? (nextFailed(next) ? `Redo the ${LABEL[next]} station` : `Start the ${LABEL[next]} station`) : "All stations captured";
  renderRecordRows();
}
function nextFailed(name) {
  const s = C.session && C.session.stations.find((x) => x.name === name);
  return s && s.state === "failed";
}

function renderRecordRows() {
  const box = $("#record-rows");
  if (!C.session) return;
  box.innerHTML = "";
  for (const s of C.session.stations) {
    const row = document.createElement("div");
    row.className = "row small";
    row.innerHTML = `<b style="min-width:70px"></b><button class="test">Run pass</button>
      <label class="test file">Upload video…<input type="file" accept="video/*" capture="environment" hidden></label>
      <span class="muted"></span>`;
    row.querySelector("b").textContent = s.name;
    const status = row.querySelector("span");
    status.textContent = s.mode === "record" ? s.state : "";
    row.querySelector("button").onclick = () => run(async () => {
      await api(`api/mapping/sessions/${C.session.id}/stations/${s.name}/record`, { method: "POST" });
      say("Start recording now");
      await refresh();
    });
    row.querySelector("input").onchange = (e) => {
      const f = e.target.files[0];
      if (f) upload(s.name, f, status);
    };
    box.append(row);
  }
}

function upload(station, file, status) {
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `api/mapping/sessions/${C.session.id}/stations/${station}/video`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) status.textContent = `uploading ${Math.round((100 * e.loaded) / e.total)} %`; };
  xhr.onload = () => {
    if (xhr.status >= 300) {
      let msg = xhr.statusText;
      try { msg = JSON.parse(xhr.responseText).detail || msg; } catch { /* keep the status text */ }
      toast(msg);
      status.textContent = "upload failed";
    } else {
      status.textContent = "uploaded; analysing";
      run(refresh);
    }
  };
  xhr.onerror = () => toast("Upload failed");
  xhr.send(file);
}

function showResults(r) {
  $("#results").hidden = false;
  const found = new Set(r.elements.flatMap((e) => e.parts.map((p) => p.member)));
  const missing = r.missing.map((u) => C.name[u] || u);
  const segs = r.elements.filter((e) => e.mode === "segments").length;
  $("#results-text").textContent =
    `Found ${found.size} of ${C.session.targets.length} lights in ${r.elements.length} elements` +
    `${segs ? ` (${segs} in segments)` : ""}. ` +
    `${r.solution.metric ? "Positions are in metres." : "Positions are to scale (no known distance)."}` +
    `${missing.length ? ` Not seen: ${missing.join(", ")}.` : ""}`;
}

// ---- wiring ------------------------------------------------------------------------------------

function bind() {
  $("#search").oninput = (e) => { C.search = e.target.value.trim(); renderPickers(); };
  $("#view-pick").onchange = renderPickers;
  $("#begin").onclick = () => run(async () => {
    if (!window.isSecureContext) throw new Error("The camera needs HTTPS: open Home Assistant through its https:// address");
    $("#begin").disabled = true;
    const kd = $("#kd-a").value && $("#kd-b").value && Number($("#kd-m").value) > 0
      ? { a: $("#kd-a").value, b: $("#kd-b").value, metres: Number($("#kd-m").value) } : null;
    const view = $("#view-pick").value;
    C.session = await api("api/mapping/sessions", { method: "POST", body: JSON.stringify({ view_id: view, targets: [...C.picked], known_distance: kd }) });
    $("#to-view").href = `views?view=${view}`;
    $("#setup").hidden = true;
    $("#live").hidden = false;
    await sensors();
    try {
      await camera();
      say("Point at the anchor and keep it in the circle, then start the centre station.");
    } catch (e) {
      say("The camera didn't start here. Use \"Record a video instead\" below, or open this page in the phone's browser.");
      $("#fallback").open = true;
    }
    connect();
    renderStations();
  });
  $("#go").onclick = () => {
    const next = nextStation();
    if (!next || !C.ws) return;
    if (next === "centre" && C.heading != null) C.h0 = C.heading;
    C.running = next;
    C.ws.send(JSON.stringify({ type: "start", station: next }));
    renderStations();
  };
  $("#stop").onclick = () => C.ws && C.ws.send(JSON.stringify({ type: "stop" }));
  $("#apply").onclick = () => run(async () => {
    await api(`api/mapping/sessions/${C.session.id}/apply`, { method: "POST" });
    location.href = `views?view=${C.session.view_id}`;
  });
  $("#stopall").onclick = () => run(async () => {
    const r = await api("api/stop_all", { method: "POST" });
    toast(`Stopped; ${r.restored} light(s) restored`);
  });
}

bind();
run(loadSetup);
