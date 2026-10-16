// Palettes: play one on an area, see what's running, stop it. Uses api() and toast() from app.js.
// The colour designer and show editor come later; this is the minimal hook.
"use strict";

const shows = { loaded: false };

function option(value, text) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}

async function loadPaletteControls() {
  try {
    const [palettes, inventory] = await Promise.all([api("api/palettes"), api("api/inventory")]);
    const pal = document.querySelector("#palette-pick");
    pal.replaceChildren(...palettes.map((p) => option(p.id, p.name)));
    const where = document.querySelector("#palette-where");
    const floors = new Map(inventory.floors.map((f) => [f.id, f.name]));
    const used = new Set(inventory.lights.filter((l) => l.included).map((l) => l.area_id));
    const areas = inventory.areas
      .filter((a) => used.has(a.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    where.replaceChildren(
      option("all", "Every light"),
      ...areas.map((a) => option(`area:${a.id}`, `${a.name}${floors.has(a.floor_id) ? ` (${floors.get(a.floor_id)})` : ""}`)),
    );
    shows.loaded = true;
  } catch (e) {
    toast(e.message);
  }
}

async function playPalette() {
  const id = document.querySelector("#palette-pick").value;
  const where = document.querySelector("#palette-where").value;
  const targets = where === "all" ? { all: true } : { areas: [where.slice(5)] };
  try {
    await api(`api/palettes/${encodeURIComponent(id)}/play`, {
      method: "POST", body: JSON.stringify({ targets }),
    });
  } catch (e) { toast(e.message); }
  refreshRunning();
}

async function refreshRunning() {
  const ul = document.querySelector("#running");
  if (!ul) return;
  let running = [];
  try { running = await api("api/running"); } catch { return; }
  ul.replaceChildren();
  for (const r of running) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${r.name} · ${r.lights.length} light(s)`;
    const stop = document.createElement("button");
    stop.className = "link small";
    stop.textContent = "Stop";
    stop.addEventListener("click", async () => {
      try {
        await api(`api/running/${encodeURIComponent(r.id)}/stop`, { method: "POST", body: "{}" });
      } catch (e) { toast(e.message); }
      refreshRunning();
    });
    li.append(label, " ", stop);
    ul.append(li);
  }
  document.querySelector("#running-none").hidden = running.length > 0;
}

document.querySelector("#palettes").addEventListener("toggle", (e) => {
  if (e.target.open && !shows.loaded) loadPaletteControls();
});
document.querySelector("#palette-play").addEventListener("click", playPalette);
refreshRunning();
setInterval(refreshRunning, 3000);
