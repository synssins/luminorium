// Luminorium UI. All URLs are relative: HA Ingress serves the app under a per-session prefix.
// No prompt()/confirm()/alert(): the HA companion app's webview may not show them.
"use strict";

// Collapsed floors ("f:<id>") and areas ("a:<id>"), remembered per browser.
const COLLAPSED_KEY = "luminorium.collapsed";
const state = {
  inventory: null,
  status: null,
  filter: "included",
  search: "",
  collapsed: loadCollapsed(),
  grouping: false, // picking lights for a new fixture
  selected: new Set(),
};
const $ = (sel) => document.querySelector(sel);

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsed]));
  } catch {
    // storage unavailable (private window): collapsing still works for this visit
  }
}
function toggleCollapsed(key) {
  if (state.collapsed.has(key)) state.collapsed.delete(key);
  else state.collapsed.add(key);
  saveCollapsed();
  render();
}

// A header that folds its section: chevron, name, and a count of lights (and how many are on).
function foldHeader(tag, key, name, lights) {
  const h = document.createElement(tag);
  const btn = document.createElement("button");
  btn.className = "fold";
  const open = !state.collapsed.has(key) || !!state.search;
  btn.setAttribute("aria-expanded", String(open));
  const on = lights.filter((l) => l.state === "on").length;
  btn.innerHTML = `<span class="chev" aria-hidden="true"></span><span class="fold-name"></span><span class="fold-count muted"></span>`;
  btn.querySelector(".fold-name").textContent = name;
  btn.querySelector(".fold-count").textContent = `${lights.length}${on ? ` · ${on} on` : ""}`;
  btn.addEventListener("click", () => toggleCollapsed(key));
  h.append(btn);
  return { header: h, open };
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || res.statusText);
  return body;
}

function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

const INTEGRATION = {
  zigbee2mqtt: "Zigbee", govee2mqtt: "Govee", zwave_js: "Z-Wave", wiz: "WiZ", wled: "WLED",
  esphome: "ESPHome", matter: "Matter", mqtt: "MQTT", group: "Group", browser_mod: "Browser",
};

const DRIVER = {
  ha: "HA", z2m: "Zigbee2MQTT", zwave_js: "Z-Wave JS", wiz: "WiZ LAN", wled: "WLED", govee: "Govee LAN",
};

function badges(light) {
  const out = [];
  const p = light.profile || {};
  const c = p.capabilities || {};
  out.push([INTEGRATION[light.integration] || light.integration]);
  if (p.driver && (light.kind === "light" || light.kind === "switch")) {
    const direct = p.driver !== "ha";
    out.push([`via ${DRIVER[p.driver] || p.driver}${p.driver_override ? " (pinned)" : ""}`, direct ? "drv" : "drv-ha"]);
    if (p.driver_note) out.push([p.driver_note, "warn"]);
  }
  if (light.kind === "group") out.push(["group"]);
  if (p.relay) out.push(["relay (on/off)"]);
  else {
    if (c.dimming) out.push(["dim"]);
    if (c.white) out.push([`white ${c.white[0]}–${c.white[1]} K`]);
    if (c.color_modes && c.color_modes.length) out.push(["colour"]);
    if (c.effects && c.effects.length) out.push([`${c.effects.length} effects`]);
    if (c.segments) out.push([`${c.segments} segments`]);
    if (c.transition === "none" && light.kind === "light") out.push(["no transition", "warn"]);
  }
  const d = p.details || {};
  if (d.node_status === "dead") out.push(["Z-Wave node dead", "warn"]);
  if (d.security && d.security !== "none") out.push([d.security]);
  if (light.hint) out.push([light.hint, "hint"]);
  if (light.duplicates && light.duplicates.length) out.push([`same light as ${light.duplicates.join(", ")}?`, "warn"]);
  return out;
}

function meta(light) {
  const p = light.profile || {};
  const parts = [light.entity_id];
  if (light.manufacturer || light.model) parts.push([light.manufacturer, light.model].filter(Boolean).join(" "));
  if (p.network) parts.push(`${p.network}, ~${p.latency_ms} ms, ≤${p.max_rate_hz} Hz`);
  if (p.endpoint) parts.push(p.endpoint);
  if (p.details && p.details.multilevel_switch_version) parts.push(`Multilevel Switch v${p.details.multilevel_switch_version}`);
  if (!light.included && light.exclude_reason) parts.push(`excluded: ${light.exclude_reason}`);
  return parts.join(" · ");
}

function visible(light) {
  const f = state.filter;
  if (f === "included" && !(light.included && light.kind !== "group")) return false;
  if (f === "excluded" && light.included) return false;
  if (f === "switches" && light.kind !== "switch") return false;
  if (state.search) {
    const hay = `${light.name} ${light.entity_id} ${light.model || ""}`.toLowerCase();
    if (!hay.includes(state.search)) return false;
  }
  return true;
}

function busySet() {
  return new Set((state.status && state.status.touched) || []);
}

function lightRow(light, { member = false } = {}) {
  const readOnly = state.status && state.status.read_only;
  const busy = busySet();
  const row = $("#light-row").content.firstElementChild.cloneNode(true);
  row.classList.toggle("excluded", !light.included);
  row.classList.toggle("member", member);
  row.querySelector(".name").textContent = light.name;
  const dot = row.querySelector(".dot");
  dot.classList.toggle("on", light.state === "on");
  dot.classList.toggle("unavailable", !light.available);
  dot.title = light.state;
  const box = row.querySelector(".toggle input");
  box.checked = light.included;
  box.disabled = light.kind === "group" || light.kind === "setting";
  box.addEventListener("change", () => setInclude(light, box.checked));
  const test = row.querySelector(".test");
  if (member) {
    test.remove(); // a fixture's lights are tested together, from the fixture
  } else {
    const testable = light.included && light.available && (light.kind === "light" || light.kind === "switch");
    test.disabled = !testable || readOnly || busy.has(light.entity_id);
    test.title = readOnly ? "Read-only mode" : busy.has(light.entity_id) ? "In use" : "On, off, then restore";
    test.addEventListener("click", () => testLight(light, test));
  }
  if (state.grouping && !member && (light.kind === "light" || light.kind === "switch")) {
    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.className = "pick";
    pick.title = "Part of the new fixture";
    pick.checked = state.selected.has(light.entity_id);
    pick.addEventListener("change", () => {
      if (pick.checked) state.selected.add(light.entity_id);
      else state.selected.delete(light.entity_id);
      renderGroupBar();
    });
    row.querySelector(".line1").prepend(pick);
  }
  const bEl = row.querySelector(".badges");
  for (const [text, cls] of badges(light)) {
    const b = document.createElement("span");
    b.className = "badge" + (cls ? " " + cls : "");
    b.textContent = text;
    bEl.append(b);
  }
  row.querySelector(".meta").textContent = meta(light);
  const options = light.driver_options || [];
  if (options.length > 1 && (light.kind === "light" || light.kind === "switch")) {
    row.querySelector(".meta").after(driverPicker(light, options));
  }
  return row;
}

// Automatic (the best driver that reaches the light), or pinned to HA or the direct driver
function driverPicker(light, options) {
  const wrap = document.createElement("label");
  wrap.className = "driver-pick small muted";
  wrap.textContent = "Driver ";
  const select = document.createElement("select");
  const p = light.profile || {};
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = `Automatic (${DRIVER[p.driver_override ? (p.drivers || ["ha"]).find((d) => d !== p.driver_override) || "ha" : p.driver] || p.driver})`;
  if (!p.driver_override) auto.textContent = `Automatic (now ${DRIVER[p.driver] || p.driver})`;
  else auto.textContent = "Automatic";
  select.append(auto);
  for (const name of options) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = `Always ${DRIVER[name] || name}`;
    select.append(o);
  }
  select.value = p.driver_override || "";
  select.addEventListener("change", () => setDriver(light, select.value || null));
  wrap.append(select);
  return wrap;
}

async function setDriver(light, driver) {
  try {
    await api(`api/lights/${encodeURIComponent(light.entity_id)}/driver`, {
      method: "PUT", body: JSON.stringify({ driver }),
    });
  } catch (e) { toast(e.message); }
  await refresh(true);
}

function fixtureBlock(fixture, members) {
  const readOnly = state.status && state.status.read_only;
  const busy = busySet();
  const el = document.createElement("div");
  el.className = "fixture";
  const head = document.createElement("div");
  head.className = "line1 fixture-head";
  head.innerHTML = `<span class="dot"></span><span class="name"></span>
    <span class="actions"><button class="link rename">Rename</button><button class="link ungroup">Ungroup</button><button class="test">Test</button></span>`;
  head.querySelector(".dot").classList.toggle("on", members.some((l) => l.state === "on"));
  const nameEl = head.querySelector(".name");
  nameEl.textContent = fixture.name;
  head.querySelector(".rename").addEventListener("click", () => renameFixture(fixture, nameEl));
  head.querySelector(".ungroup").addEventListener("click", async () => {
    await api(`api/fixtures/${fixture.id}`, { method: "DELETE" }).catch((e) => toast(e.message));
    refresh(true);
  });
  const test = head.querySelector(".test");
  const testable = members.some((l) => l.included && l.available);
  const inUse = members.some((l) => busy.has(l.entity_id));
  test.disabled = !testable || readOnly || inUse;
  test.title = readOnly ? "Read-only mode" : inUse ? "In use" : "All its lights on, off, then restore";
  test.addEventListener("click", () => testFixture(fixture, test));
  const sub = document.createElement("div");
  sub.className = "badges";
  sub.innerHTML = `<span class="badge fixture-badge"></span>`;
  sub.firstElementChild.textContent = `fixture · ${members.length} lights, tested and mapped as one`;
  el.append(head, sub);
  for (const light of members) el.append(lightRow(light, { member: true }));
  return el;
}

function renameFixture(fixture, nameEl) {
  const input = document.createElement("input");
  input.className = "inline-name";
  input.value = fixture.name;
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== fixture.name) {
      await api(`api/fixtures/${fixture.id}`, { method: "PUT", body: JSON.stringify({ name }) }).catch((e) => toast(e.message));
    }
    refresh(true);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

function suggestionRow(s, byId) {
  const el = document.createElement("div");
  el.className = "suggestion";
  el.innerHTML = `<div class="small"><strong>One fixture?</strong> <span class="names"></span></div>
    <div class="small muted why"></div>
    <div class="actions"><button class="test yes">Group as one</button><button class="link no">Not the same</button></div>`;
  el.querySelector(".names").textContent = s.members.map((id) => (byId.get(id) || { name: id }).name).join(" + ");
  el.querySelector(".why").textContent = s.reason;
  el.querySelector(".yes").addEventListener("click", async () => {
    await api("api/fixtures", { method: "POST", body: JSON.stringify({ name: s.name, members: s.members }) }).catch((e) => toast(e.message));
    refresh(true);
  });
  el.querySelector(".no").addEventListener("click", async () => {
    await api("api/fixture_suggestions/dismiss", { method: "POST", body: JSON.stringify({ members: s.members }) }).catch((e) => toast(e.message));
    refresh(true);
  });
  return el;
}

function render() {
  const inv = state.inventory;
  if (!inv) return;
  const root = $("#floors");
  root.replaceChildren();
  const byId = new Map(inv.lights.map((l) => [l.entity_id, l]));
  const fixtures = new Map((inv.fixtures || []).map((f) => [f.id, f]));
  // Per area: visible single lights, and fixtures with at least one visible light
  const byArea = new Map();
  const add = (areaId, item) => {
    if (!byArea.has(areaId)) byArea.set(areaId, []);
    byArea.get(areaId).push(item);
  };
  for (const light of inv.lights) {
    if (!visible(light) || (light.fixture && fixtures.has(light.fixture))) continue;
    add(light.area_id, { name: light.name, lights: [light], light });
  }
  for (const f of fixtures.values()) {
    const members = f.members.map((id) => byId.get(id)).filter(Boolean);
    if (!members.some(visible)) continue;
    add(f.area_id, { name: f.name, lights: members, fixture: f });
  }
  const suggestions = new Map();
  if (state.filter === "included" || state.filter === "all") {
    for (const s of inv.suggestions || []) {
      if (!suggestions.has(s.area_id)) suggestions.set(s.area_id, []);
      suggestions.get(s.area_id).push(s);
    }
  }
  for (const floor of inv.floors) {
    const areas = inv.areas.filter((a) => a.floor_id === floor.id && byArea.has(a.id));
    if (!areas.length) continue;
    const fEl = document.createElement("section");
    fEl.className = "floor";
    const floorLights = areas.flatMap((a) => byArea.get(a.id).flatMap((i) => i.lights));
    const floorFold = foldHeader("h2", `f:${floor.id}`, floor.name, floorLights);
    fEl.append(floorFold.header);
    root.append(fEl);
    if (!floorFold.open) continue;
    for (const area of areas) {
      const aEl = document.createElement("div");
      aEl.className = "area";
      const items = byArea.get(area.id).sort((a, b) => a.name.localeCompare(b.name));
      const areaFold = foldHeader("h3", `a:${area.id}`, area.name, items.flatMap((i) => i.lights));
      aEl.append(areaFold.header);
      aEl.classList.toggle("closed", !areaFold.open);
      fEl.append(aEl);
      if (!areaFold.open) continue;
      for (const s of suggestions.get(area.id) || []) aEl.append(suggestionRow(s, byId));
      for (const item of items) {
        aEl.append(item.fixture ? fixtureBlock(item.fixture, item.lights) : lightRow(item.light));
      }
    }
  }
  if (!root.children.length) root.innerHTML = `<p class="muted">Nothing matches.</p>`;
  renderGroupBar();
}

function renderGroupBar() {
  $("#groupbar").hidden = !state.grouping;
  $("#group-start").textContent = state.grouping ? "Cancel grouping" : "Group lights";
  if (!state.grouping) return;
  const n = state.selected.size;
  $("#group-count").textContent = n ? `${n} selected` : "Tick the lights that share one fixture";
  $("#group-make").disabled = n < 2;
}

function renderStatus() {
  const s = state.status;
  if (!s) return;
  $("#version").textContent = s.version;
  const link = $("#link");
  link.textContent = s.connected ? `HA ${s.ha_version || ""}` : "HA disconnected";
  link.className = "pill " + (s.connected ? "ok" : "bad");
  const banner = $("#banner");
  banner.hidden = !s.read_only;
  banner.textContent = s.read_only ? "Read-only mode: nothing is sent to any light. Test is disabled." : "";
  const c = s.counts;
  $("#counts").textContent =
    `${c.lights} lights (+${c.segments} segments), ${c.switches} switches included, ${c.excluded} excluded` +
    (s.touched.length ? ` · ${s.touched.length} in use` : "");
  renderDrivers(s.drivers || {});
  const ul = $("#activity");
  ul.replaceChildren();
  for (const a of s.activity) {
    const li = document.createElement("li");
    li.textContent = `${new Date(a.at * 1000).toLocaleTimeString()} ${a.message}`;
    ul.append(li);
  }
}

function renderDrivers(drivers) {
  const parts = [];
  for (const [name, d] of Object.entries(drivers)) {
    if (name === "ha") continue;
    const label = DRIVER[name] || name;
    if (!d.enabled) { parts.push(`${label}: off`); continue; }
    const count = d.devices ?? d.bulbs ?? d.nodes ?? 0;
    const what = name === "zwave_js" ? "node" : name === "wiz" ? "bulb" : "device";
    if (d.connected) parts.push(`${label}: ${count} ${what}${count === 1 ? "" : "s"}`);
    else parts.push(`${label}: ${d.error || "not connected"}`);
  }
  $("#drivers").textContent = parts.length ? `Drivers · ${parts.join(" · ")}` : "";
}

async function setInclude(light, include) {
  try {
    await api(`api/lights/${encodeURIComponent(light.entity_id)}/include`, {
      method: "PUT", body: JSON.stringify({ include }),
    });
  } catch (e) { toast(e.message); }
  await refresh(true);
}

async function testLight(light, button) {
  button.disabled = true;
  try {
    await api(`api/lights/${encodeURIComponent(light.entity_id)}/test`, { method: "POST" });
  } catch (e) { toast(e.message); }
  setTimeout(() => refresh(true), 300);
}

async function testFixture(fixture, button) {
  button.disabled = true;
  try {
    const r = await api(`api/fixtures/${fixture.id}/test`, { method: "POST" });
    if (r.skipped && r.skipped.length) toast(`Skipped (unavailable or excluded): ${r.skipped.join(", ")}`);
  } catch (e) { toast(e.message); }
  setTimeout(() => refresh(true), 300);
}

async function refresh(force = false) {
  try {
    const [status, inventory] = await Promise.all([api("api/status"), api("api/inventory")]);
    state.status = status;
    state.inventory = inventory;
    renderStatus();
    // Don't redraw under someone typing a fixture name or picking a driver
    const active = document.activeElement;
    const typing = active && (active.classList.contains("inline-name") || !!active.closest(".driver-pick"));
    if (force || !typing) render();
  } catch (e) {
    $("#link").textContent = "offline";
    $("#link").className = "pill bad";
  }
}

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === chip));
    state.filter = chip.dataset.filter;
    render();
  });
}
$("#search").addEventListener("input", (e) => { state.search = e.target.value.trim().toLowerCase(); render(); });
$("#group-start").addEventListener("click", () => {
  state.grouping = !state.grouping;
  state.selected.clear();
  $("#group-name").value = "";
  render();
});
$("#group-make").addEventListener("click", async () => {
  try {
    await api("api/fixtures", {
      method: "POST",
      body: JSON.stringify({ name: $("#group-name").value.trim(), members: [...state.selected] }),
    });
    state.grouping = false;
    state.selected.clear();
  } catch (e) { toast(e.message); }
  refresh(true);
});
$("#collapse-all").addEventListener("click", () => {
  const inv = state.inventory;
  if (!inv) return;
  // Floors and rooms both fold, so opening a level shows its rooms closed
  state.collapsed = new Set([...inv.floors.map((f) => `f:${f.id}`), ...inv.areas.map((a) => `a:${a.id}`)]);
  saveCollapsed();
  render();
});
$("#expand-all").addEventListener("click", () => {
  state.collapsed = new Set();
  saveCollapsed();
  render();
});
$("#stopall").addEventListener("click", async () => {
  try {
    const r = await api("api/stop_all", { method: "POST" });
    $("#stopall").textContent = `Stopped · ${r.restored} restored`;
    setTimeout(() => ($("#stopall").textContent = "Stop all"), 2500);
  } catch (e) { toast(e.message); }
  refresh(true);
});

refresh(true);
setInterval(refresh, 3000);
