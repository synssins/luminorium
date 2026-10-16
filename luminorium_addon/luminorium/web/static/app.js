// Luminorium UI. All URLs are relative: HA Ingress serves the app under a per-session prefix.
"use strict";

const state = { inventory: null, status: null, filter: "included", search: "" };
const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || res.statusText);
  return body;
}

const INTEGRATION = {
  zigbee2mqtt: "Zigbee", govee2mqtt: "Govee", zwave_js: "Z-Wave", wiz: "WiZ", wled: "WLED",
  esphome: "ESPHome", matter: "Matter", mqtt: "MQTT", group: "Group", browser_mod: "Browser",
};

function badges(light) {
  const out = [];
  const p = light.profile || {};
  const c = p.capabilities || {};
  out.push([INTEGRATION[light.integration] || light.integration]);
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

function render() {
  const inv = state.inventory;
  if (!inv) return;
  const root = $("#floors");
  root.replaceChildren();
  const tpl = $("#light-row");
  const readOnly = state.status && state.status.read_only;
  const busy = new Set((state.status && state.status.touched) || []);
  const byArea = new Map();
  for (const light of inv.lights) {
    if (!visible(light)) continue;
    if (!byArea.has(light.area_id)) byArea.set(light.area_id, []);
    byArea.get(light.area_id).push(light);
  }
  for (const floor of inv.floors) {
    const areas = inv.areas.filter((a) => a.floor_id === floor.id && byArea.has(a.id));
    if (!areas.length) continue;
    const fEl = document.createElement("section");
    fEl.className = "floor";
    fEl.innerHTML = `<h2></h2>`;
    fEl.querySelector("h2").textContent = floor.name;
    for (const area of areas) {
      const aEl = document.createElement("div");
      aEl.className = "area";
      aEl.innerHTML = `<h3></h3>`;
      aEl.querySelector("h3").textContent = area.name;
      const lights = byArea.get(area.id).sort((a, b) => a.name.localeCompare(b.name));
      for (const light of lights) {
        const row = tpl.content.firstElementChild.cloneNode(true);
        row.classList.toggle("excluded", !light.included);
        row.querySelector(".name").textContent = light.name;
        const dot = row.querySelector(".dot");
        dot.classList.toggle("on", light.state === "on");
        dot.classList.toggle("unavailable", !light.available);
        dot.title = light.state;
        const box = row.querySelector("input");
        box.checked = light.included;
        box.disabled = light.kind === "group" || light.kind === "setting";
        box.addEventListener("change", () => setInclude(light, box.checked));
        const test = row.querySelector(".test");
        const testable = light.included && light.available && (light.kind === "light" || light.kind === "switch");
        test.disabled = !testable || readOnly || busy.has(light.entity_id);
        test.title = readOnly ? "Read-only mode" : busy.has(light.entity_id) ? "In use" : "On, off, then restore";
        test.addEventListener("click", () => testLight(light, test));
        const bEl = row.querySelector(".badges");
        for (const [text, cls] of badges(light)) {
          const b = document.createElement("span");
          b.className = "badge" + (cls ? " " + cls : "");
          b.textContent = text;
          bEl.append(b);
        }
        row.querySelector(".meta").textContent = meta(light);
        aEl.append(row);
      }
      fEl.append(aEl);
    }
    root.append(fEl);
  }
  if (!root.children.length) root.innerHTML = `<p class="muted">Nothing matches.</p>`;
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
  const ul = $("#activity");
  ul.replaceChildren();
  for (const a of s.activity) {
    const li = document.createElement("li");
    li.textContent = `${new Date(a.at * 1000).toLocaleTimeString()} ${a.message}`;
    ul.append(li);
  }
}

async function setInclude(light, include) {
  try {
    await api(`api/lights/${encodeURIComponent(light.entity_id)}/include`, {
      method: "PUT", body: JSON.stringify({ include }),
    });
  } catch (e) { alert(e.message); }
  await refresh();
}

async function testLight(light, button) {
  button.disabled = true;
  try {
    await api(`api/lights/${encodeURIComponent(light.entity_id)}/test`, { method: "POST" });
  } catch (e) { alert(e.message); }
  setTimeout(refresh, 300);
}

async function refresh() {
  try {
    const [status, inventory] = await Promise.all([api("api/status"), api("api/inventory")]);
    state.status = status;
    state.inventory = inventory;
    renderStatus();
    render();
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
$("#stopall").addEventListener("click", async () => {
  try {
    const r = await api("api/stop_all", { method: "POST" });
    $("#stopall").textContent = `Stopped · ${r.restored} restored`;
    setTimeout(() => ($("#stopall").textContent = "Stop all"), 2500);
  } catch (e) { alert(e.message); }
  refresh();
});

refresh();
setInterval(refresh, 3000);
