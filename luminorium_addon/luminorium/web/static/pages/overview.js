// Overview: what's on, what's playing, how the drivers are, and what happened lately.
"use strict";

(function () {
  const { el, icon, api, run, toast, onData, start, DRIVER } = L;
  const page = document.getElementById("page");
  let palettes = [];
  let running = [];

  function targetsOptions(inv) {
    const floors = new Map(inv.floors.map((f) => [f.id, f.name]));
    const used = new Set(inv.lights.filter((l) => l.included).map((l) => l.area_id));
    const areas = inv.areas.filter((a) => used.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
    return [["all", "Every light"], ...areas.map((a) => [`area:${a.id}`, `${a.name} · ${floors.get(a.floor_id) || ""}`])];
  }

  function targetOf(value) {
    return value === "all" ? { all: true } : { areas: [value.slice(5)] };
  }

  async function loadOnce() {
    palettes = (await run(() => api("api/palettes"))) || [];
  }

  async function loadRunning() {
    running = (await run(() => api("api/running"))) || [];
  }

  function drivable(l) {
    return l.included && (l.kind === "light" || l.kind === "switch");
  }

  function render({ status, inventory }) {
    if (!status || !inventory) return;
    const lights = inventory.lights.filter(drivable);
    const on = lights.filter((l) => l.state === "on");
    const drivers = Object.entries(status.drivers || {});
    const connected = drivers.filter(([, d]) => d.connected).length;
    const where = document.getElementById("quick-where")?.value || "all";

    const tiles = el("section.grid", { "aria-label": "Summary", style: { "--min": "150px" } },
      tile("Lights", lights.length, `+${status.counts.segments} segments`, "lights"),
      tile("On now", on.length, `of ${lights.length}`, "lights"),
      tile("Fixtures", inventory.fixtures.length, "grouped", "lights"),
      tile("Playing", running.length, running.length === 1 ? "show" : "shows", "palettes"),
      tile("Drivers", `${connected}/${drivers.length}`, "connected", "drivers"));

    const now = el("section.card", { "aria-labelledby": "now" },
      el("div.card-head", el("h2#now", "Now playing"), el("a", { href: "palettes" }, "Palettes & shows")),
      running.length
        ? running.map((r) => el("div.list-row",
          el("span", { style: { flex: "1", minWidth: "0" } }, el("b", r.name), el("span.muted.small", ` · ${r.lights.length} light(s) · ${Math.round(r.elapsed_s / 60)} min`)),
          el("button.btn.small", { type: "button", on: { click: () => stopRun(r.id) } }, "Stop")))
        : el("div.empty", "Nothing is playing. Play a palette below, or a show from Palettes & shows."),
      el("div.row",
        el("label.field", { style: { flex: "1 1 220px" } }, el("span", "Quick play on"),
          el("select#quick-where", targetsOptions(inventory).map(([v, t]) => el("option", { value: v, selected: v === where }, t)))),
      ),
      el("div.chips", palettes.slice(0, 8).map((p) => el("button.btn.quiet", {
        type: "button", disabled: status.read_only,
        on: { click: () => play(p) },
      }, swatches(p), p.name))));

    const drv = el("section.card", { "aria-labelledby": "drv" },
      el("div.card-head", el("h2#drv", "Drivers"), el("a", { href: "drivers" }, "Details")),
      el("div.grid", { style: { "--min": "200px", gap: "10px" } },
        drivers.map(([name, d]) => el("div", { style: { display: "flex", alignItems: "center", gap: "12px", padding: "12px 14px", borderRadius: "12px", background: "var(--card2)" } },
          el("span.sdot", { style: { width: "10px", height: "10px", background: d.connected ? "var(--ok)" : d.enabled ? "var(--warn)" : "var(--faint)" } }),
          el("span", { style: { display: "flex", flexDirection: "column", minWidth: "0" } },
            el("b", { style: { fontWeight: "500" } }, DRIVER[name] || name),
            el("span.muted.small", driverLine(name, d)))))));

    const byFloor = new Map();
    for (const l of lights) {
      const f = byFloor.get(l.floor_id) || { lights: 0, on: 0, rooms: new Set() };
      f.lights += 1;
      if (l.state === "on") f.on += 1;
      f.rooms.add(l.area_id);
      byFloor.set(l.floor_id, f);
    }
    const floors = el("section", { "aria-labelledby": "floors", style: { display: "flex", flexDirection: "column", gap: "12px" } },
      el("div.section-head", el("h2#floors", "Around the house"), el("a", { href: "lights" }, "All lights")),
      el("div.grid", { style: { "--min": "190px", gap: "12px" } },
        inventory.floors.filter((f) => byFloor.has(f.id)).map((f) => {
          const s = byFloor.get(f.id);
          return el("a.tile", { href: `lights#floor-${f.id}` },
            el("span.row", { style: { justifyContent: "space-between" } }, el("b", f.name), el("span.muted.small", `${s.rooms.size} ${s.rooms.size === 1 ? "room" : "rooms"}`)),
            el("span", el("span.value", { style: { fontSize: "24px" } }, s.lights), el("span.muted.small", " lights")),
            el("span.meter", el("span", { style: { width: `${(s.on / s.lights) * 100}%` } })),
            el("span.small", { style: { color: "var(--text2)" } }, s.on ? `${s.on} on` : "All off"));
        })));

    const act = el("section.card", { "aria-labelledby": "act" },
      el("div.card-head", el("h2#act", "Recent activity"), el("a", { href: "activity" }, "Full log")),
      (status.activity || []).length
        ? status.activity.slice(0, 8).map(activityRow)
        : el("div.empty", "Nothing yet."));

    L.set(page, tiles, el("div.cols", now, drv), floors, act);
  }

  function tile(label, value, sub, href) {
    return el("a.tile", { href }, el("span.label", label),
      el("span", el("span.value", String(value)), " ", el("span.sub", sub)));
  }

  function swatches(p) {
    return el("span.swatches", (p.colors || []).slice(0, 5).map((c) => el("span", { style: { background: L.colorHex(c) } })));
  }

  function driverLine(name, d) {
    if (!d.connected) return d.error || (d.enabled ? "Not connected" : "Off");
    if (name === "ha") return "Fallback for every light";
    if (name === "z2m") return `${d.devices} devices, ${d.groups} groups`;
    if (name === "zwave_js") return `${d.nodes} nodes${d.unicast_only && d.unicast_only.length ? ` · ${d.unicast_only.length} unicast only` : ""}`;
    if (name === "wiz") return `${d.bulbs} bulb(s)`;
    if (name === "wled") return `${d.devices} controller(s)`;
    if (name === "govee") return d.devices ? `${d.devices} device(s)` : "Listening · none found";
    return "Connected";
  }

  async function play(p) {
    const where = document.getElementById("quick-where").value;
    await run(async () => {
      await api(`api/palettes/${encodeURIComponent(p.id)}/play`, { method: "POST", body: { targets: targetOf(where) } });
      toast(`Playing ${p.name}`);
    });
    await loadRunning();
    L.refresh(true);
  }

  async function stopRun(id) {
    await run(() => api(`api/running/${encodeURIComponent(id)}/stop`, { method: "POST", body: {} }));
    await loadRunning();
    L.refresh(true);
  }

  function activityRow(a) {
    const kind = /^Test|Testing/.test(a.message) ? ["Test", "test"] : /Playing|Stopped|show/i.test(a.message) ? ["Show", "show"]
      : /outside|failed|missed/i.test(a.message) ? ["Note", "warn"] : ["Info", "info"];
    return el("div.list-row",
      el("span.mono.small.muted", { style: { width: "64px", flex: "none" } }, new Date(a.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
      el(`span.tag.${kind[1]}`, kind[0]),
      el("span", { style: { minWidth: "0" } }, a.message));
  }

  window.activityRow = activityRow;
  onData(async (d) => { await loadRunning(); render(d); }, { inventory: true });
  loadOnce().then(() => start());
})();
