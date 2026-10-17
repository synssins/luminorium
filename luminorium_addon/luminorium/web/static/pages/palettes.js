// Palettes & shows: what's playing, the palette library, saved shows, the effect names.
"use strict";

(function () {
  const { el, icon, api, run, toast, onData, start, store, save } = L;
  const page = document.getElementById("page");
  const ui = { tab: store("palettes.tab", "palettes"), where: store("palettes.where", "all"), white: store("palettes.white", false) };
  let palettes = [];
  let shows = [];
  let effects = [];
  let running = [];
  let last = null;

  function targets(inv) {
    const floors = new Map(inv.floors.map((f) => [f.id, f.name]));
    const used = new Set(inv.lights.filter((l) => l.included).map((l) => l.area_id));
    const usedFloors = new Set(inv.lights.filter((l) => l.included).map((l) => l.floor_id));
    const areas = inv.areas.filter((a) => used.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
    return [
      ["all", "Every light"],
      ...inv.floors.filter((f) => usedFloors.has(f.id)).map((f) => [`floor:${f.id}`, `${f.name} (whole level)`]),
      ...areas.map((a) => [`area:${a.id}`, `${a.name} · ${floors.get(a.floor_id) || ""}`]),
    ];
  }
  function targetOf(value, inv) {
    if (value === "all") return { all: true };
    if (value.startsWith("floor:")) {
      const id = value.slice(6);
      return { areas: inv.areas.filter((a) => a.floor_id === id).map((a) => a.id) };
    }
    return { areas: [value.slice(5)] };
  }

  async function load() {
    [palettes, shows, effects] = await Promise.all([
      api("api/palettes").catch(() => []), api("api/shows").catch(() => []), api("api/effects").catch(() => []),
    ]);
  }
  async function loadRunning() { running = (await api("api/running").catch(() => [])) || []; }

  function strip(p) {
    return el("div.pstrip", (p.colors || []).map((c) => el("span", { style: { flex: String(c.weight || 1), background: L.colorHex(c) } })));
  }
  function whiteCount(inv) { return inv.lights.filter((l) => l.included && l.white_only).length; }

  function describe(p) {
    const n = (p.colors || []).length;
    const t = p.transition_s ? `${p.transition_s[0]}–${p.transition_s[1]} s fades` : "";
    return [`${n} colour${n === 1 ? "" : "s"}`, t].filter(Boolean).join(" · ");
  }

  async function playPalette(p) {
    await run(async () => {
      await api(`api/palettes/${encodeURIComponent(p.id)}/play`, { method: "POST", body: { targets: targetOf(ui.where, last.inventory), include_white: !!ui.white } });
      toast(`Playing ${p.name}`);
    });
    await loadRunning(); paint();
  }
  async function playShow(s) {
    await run(async () => { await api(`api/shows/${encodeURIComponent(s.id)}/play`, { method: "POST", body: {} }); toast(`Playing ${s.name || s.id}`); });
    await loadRunning(); paint();
  }
  async function stopRun(id) {
    await run(() => api(`api/running/${encodeURIComponent(id)}/stop`, { method: "POST", body: {} }));
    await loadRunning(); paint();
  }

  function runningCard() {
    if (!running.length) return null;
    return el("section.card.accent", { "aria-labelledby": "run" },
      el("div.card-head", el("h2#run", "Playing now"),
        el("button.btn.small", { type: "button", on: { click: async () => { await run(() => api("api/stop", { method: "POST" })); await loadRunning(); paint(); } } }, "Stop all shows")),
      running.map((r) => {
        const pal = palettes.find((p) => p.id === r.source);
        return el("div.list-row",
          pal ? el("span.swatches", pal.colors.slice(0, 5).map((c) => el("span", { style: { background: L.colorHex(c) } }))) : icon("play", 18),
          el("span", { style: { flex: "1", minWidth: "0" } }, el("b", r.name),
            el("span.small.muted", ` · ${r.lights.length} light(s) · ${Math.max(1, Math.round(r.elapsed_s / 60))} min · ${r.on_end === "restore" ? "puts lights back when stopped" : `on end: ${r.on_end}`}`)),
          el("button.btn.small", { type: "button", on: { click: () => stopRun(r.id) } }, "Stop"));
      }));
  }

  function palettesTab(readOnly) {
    return el("section", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
      el("div.section-head", el("h2", "Palettes"),
        el("label.row", el("span.muted", "Play on"),
          el("select.input", { style: { width: "auto", minWidth: "240px" }, on: { change: (e) => { ui.where = e.target.value; save("palettes.where", ui.where); } } },
            targets(last.inventory).map(([v, t]) => el("option", { value: v, selected: v === ui.where }, t)))),
        whiteCount(last.inventory) ? el("label.check", { title: "Lights whose bulbs only give white, like the white LEDs on the pathway" },
          el("input", { type: "checkbox", checked: !!ui.white, on: { change: (e) => { ui.white = e.target.checked; save("palettes.white", ui.white); } } }),
          `Include white lights (${whiteCount(last.inventory)})`) : null),
      readOnly ? el("div.banner.warn", "Read-only mode: palettes can't be played.") : null,
      el("div.grid", { style: { "--min": "250px" } }, palettes.map((p) =>
        el("article.pcard", strip(p),
          el("div.pinfo", el("div.row", { style: { justifyContent: "space-between" } }, el("h3", p.name),
            el("span.small.muted", p.source === "builtin" ? "Built in" : "Yours")),
            el("span.small.muted", describe(p)),
            (p.category || []).length ? el("span.small.muted", p.category.join(", ")) : null),
          el("div.pacts", el("button.btn.primary", { type: "button", disabled: readOnly, on: { click: () => playPalette(p) } }, icon("play", 14), "Play"))))),
      el("p.small.muted", "Your own palettes go in the add-on's config folder (palettes/<id>.yaml); one with a built-in id replaces it. A palette editor comes with the colour designer."));
  }

  function showsTab(readOnly) {
    if (!shows.length) return el("div.empty", "No saved shows yet. Shows are YAML files in the add-on's config folder (shows/<id>.yaml); the show editor comes with the colour designer.");
    return el("section.card", el("h2", "Saved shows"),
      shows.map((s) => el("div.list-row",
        el("span", { style: { flex: "1" } }, el("b", s.name || s.id), el("span.small.muted", ` · ${(s.layers || []).length} layer(s)`)),
        el("button.btn.small.primary", { type: "button", disabled: readOnly, on: { click: () => playShow(s) } }, "Play"))));
  }

  function effectsTab() {
    return el("section.card", el("div.card-head", el("h2", "Effect names"),
      el("span.small.muted", "A show asks for one of these; each light uses its own built-in version where it has one")),
      el("div.grid", { style: { "--min": "240px", gap: "10px" } }, effects.map((e) =>
        el("div", { style: { display: "flex", gap: "12px", alignItems: "center", padding: "10px 12px", borderRadius: "10px", background: "var(--card2)" } },
          el("span", { style: { width: "28px", height: "28px", borderRadius: "8px", background: e.color, flex: "none" } }),
          el("span", { style: { display: "flex", flexDirection: "column", minWidth: "0" } }, el("b", { style: { fontWeight: "500" } }, e.name),
            el("span.small.muted", `Built in on ${e.integrations.length ? e.integrations.map((i) => L.INTEGRATION[i] || i).join(", ") : "none"}; otherwise ${e.software || "its colour"}`))))));
  }

  function paint() {
    if (!last) return;
    const readOnly = last.status.read_only;
    const tabs = [["palettes", "Palettes"], ["shows", "Shows"], ["effects", "Effects"]];
    L.set(page, 
      runningCard(),
      el("div.tabs", { role: "tablist", "aria-label": "Library" }, tabs.map(([k, label]) =>
        el("button", { type: "button", role: "tab", "aria-selected": String(ui.tab === k),
          on: { click: () => { ui.tab = k; save("palettes.tab", k); paint(); } } }, label))),
      ui.tab === "shows" ? showsTab(readOnly) : ui.tab === "effects" ? effectsTab() : palettesTab(readOnly));
  }

  onData(async (d) => { last = d; await loadRunning(); paint(); }, { inventory: true });
  load().then(() => start(4000));
})();
