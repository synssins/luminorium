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
        const pal = palettes.find((p) => p.id === r.source) || palettes.find((p) => r.name.endsWith(`· ${p.name}`));
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


  // ---- animations: a sweep across the house, by where lights are on the house map ----------

  const DIRECTIONS = [
    ["ltr", "Left to right", { axis: "x", direction: "forward" }],
    ["rtl", "Right to left", { axis: "x", direction: "reverse" }],
    ["lr", "Back and forth", { axis: "x", direction: "bounce" }],
    ["out", "House to street", { axis: "y", direction: "reverse" }],
    ["up", "Bottom to top", { axis: "z", direction: "forward" }],
  ];
  const ANIM_DEFAULT = { palette: "halloween", custom: ["#7a1fff", "#ff4500"], mode: "wipe", dir: "ltr", period: 8, width: 30, brightness: 90, name: "" };
  ui.anim = { ...ANIM_DEFAULT, ...(store("palettes.anim", {}) || {}) };
  let house = null;
  function setAnim(change, repaint = true) {
    Object.assign(ui.anim, change);
    save("palettes.anim", ui.anim);
    if (repaint) paint();
  }
  async function loadHouse() { house = await api("api/house").catch(() => null); }

  function animColors() {
    const a = ui.anim;
    if (a.palette === "custom") return a.custom;
    const p = palettes.find((x) => x.id === a.palette);
    return p ? p.colors.map((c) => L.colorHex(c)) : a.custom;
  }
  function animSpec() {
    const a = ui.anim;
    const dir = (DIRECTIONS.find((d) => d[0] === a.dir) || DIRECTIONS[0])[2];
    const pal = palettes.find((x) => x.id === a.palette);
    const layer = { type: "sweep", mode: a.mode, ...dir, period_s: Number(a.period), brightness: Number(a.brightness),
      ...(a.mode === "band" ? { width: Number(a.width) / 100 } : {}),
      ...(a.palette === "custom" || !pal ? { colors: a.custom } : { palette: a.palette }) };
    const name = a.name.trim() || `${a.mode === "band" ? "Band" : "Sweep"} · ${pal && a.palette !== "custom" ? pal.name : "custom colours"}`;
    return { name, include_white: !!ui.white, layers: [layer] };
  }
  // Placed lights in the chosen place: only they take part
  function placedHere() {
    if (!house) return null;
    const t = targetOf(ui.where, last.inventory);
    const areas = t.all ? null : new Set(t.areas);
    return house.targets.filter((x) => x.placed && (!areas || areas.has(x.area_id))).length;
  }
  async function playAnim() {
    const spec = animSpec();
    await run(async () => {
      await api("api/play", { method: "POST", body: { ...spec, targets: { ...targetOf(ui.where, last.inventory), include_white: !!ui.white } } });
      toast(`Playing ${spec.name}`);
    });
    await loadRunning(); paint();
  }
  async function saveAnim() {
    const spec = animSpec();
    const id = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "sweep";
    await run(async () => {
      await api(`api/shows/${encodeURIComponent(id)}`, { method: "PUT", body: { ...spec, targets: targetOf(ui.where, last.inventory) } });
      shows = await api("api/shows").catch(() => shows);
      toast(`Saved as the show ${spec.name}`);
    });
    paint();
  }

  function animTab(readOnly) {
    const a = ui.anim;
    const colors = animColors();
    const n = placedHere();
    const seg = (label, key, options) => el("div.field", el("span", label),
      el("div.seg", { role: "radiogroup", "aria-label": label }, options.map(([v, text]) =>
        el("button", { type: "button", role: "radio", "aria-checked": String(a[key] === v), on: { click: () => setAnim({ [key]: v }) } }, text))));
    const slider = (label, key, min, max, step, fmt) => {
      const out = el("span.mono", fmt(a[key]));
      return el("label.field", el("span", label, out),
        el("input", { type: "range", min, max, step, value: a[key],
          on: { input: (e) => { setAnim({ [key]: Number(e.target.value) }, false); out.textContent = fmt(Number(e.target.value)); } } }));
    };
    // a preview strip: the colours as they'd sweep across
    const preview = el("div.anim-preview", { "aria-hidden": "true" },
      el("div.anim-run", { style: { backgroundImage: `linear-gradient(90deg, ${[...colors, colors[0]].join(", ")})`, animationDuration: `${a.period * colors.length}s`,
        animationDirection: a.dir === "rtl" || a.dir === "out" ? "reverse" : a.dir === "lr" ? "alternate" : "normal" } }));
    return el("section", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
      el("div.section-head", el("h2", "Sweep"),
        el("label.row", el("span.muted", "Play on"),
          el("select.input", { style: { width: "auto", minWidth: "240px" }, on: { change: (e) => { ui.where = e.target.value; save("palettes.where", ui.where); paint(); } } },
            targets(last.inventory).map(([v, t]) => el("option", { value: v, selected: v === ui.where }, t)))),
        whiteCount(last.inventory) ? el("label.check", el("input", { type: "checkbox", checked: !!ui.white, on: { change: (e) => { ui.white = e.target.checked; save("palettes.white", ui.white); } } }),
          `Include white lights (${whiteCount(last.inventory)})`) : null),
      readOnly ? el("div.banner.warn", "Read-only mode: animations can't be played.") : null,
      n === 0 ? el("div.banner.warn", "None of the lights here are on the House map yet. A sweep goes by where each light is, so place them first.",
        el("a.btn.small", { href: "house" }, "Open the House map")) : null,
      el("section.card", { "aria-label": "Sweep settings" },
        el("p.muted", { style: { margin: 0 } }, "Colour travels from one end of the house to the other, by where each light is on the House map. Only placed lights join in; White only lights are left out. On a WLED strip whose LEDs are placed, it moves LED by LED."),
        preview,
        el("div.grid", { style: { "--min": "260px", gap: "16px" } },
          el("label.field", el("span", "Colours"),
            el("select.input", { on: { change: (e) => setAnim({ palette: e.target.value }) } },
              palettes.map((p) => el("option", { value: p.id, selected: a.palette === p.id }, p.name)),
              el("option", { value: "custom", selected: a.palette === "custom" }, "Custom colours"))),
          a.palette === "custom" ? el("div.field", el("span", "Custom colours"),
            el("div.row", { style: { gap: "8px", flexWrap: "wrap" } },
              a.custom.map((c, i) => el("span.row", { style: { gap: "2px" } },
                el("input", { type: "color", value: c, "aria-label": `Colour ${i + 1}`, style: { width: "44px", height: "40px", border: "0", background: "none", padding: "0" },
                  on: { change: (e) => { const next = [...a.custom]; next[i] = e.target.value; setAnim({ custom: next }); } } }),
                a.custom.length > 1 ? el("button.btn.small.quiet", { type: "button", "aria-label": `Remove colour ${i + 1}`, on: { click: () => setAnim({ custom: a.custom.filter((_, k) => k !== i) }) } }, "×") : null)),
              a.custom.length < 6 ? el("button.btn.small", { type: "button", on: { click: () => setAnim({ custom: [...a.custom, "#ffffff"] }) } }, "Add") : null)) : null,
          seg("Style", "mode", [["wipe", "Wipe"], ["band", "Band"]]),
          el("label.field", el("span", "Direction"),
            el("select.input", { on: { change: (e) => setAnim({ dir: e.target.value }) } },
              DIRECTIONS.map(([v, text]) => el("option", { value: v, selected: a.dir === v }, text)))),
          slider("One pass", "period", 2, 60, 1, (v) => `${v} s`),
          a.mode === "band" ? slider("Band width", "width", 10, 100, 5, (v) => `${v}%`) : null,
          slider("Brightness", "brightness", 10, 100, 5, (v) => `${v}%`),
          el("label.field", el("span", "Name (to save it as a show)"),
            el("input.input", { value: a.name, placeholder: animSpec().name, on: { change: (e) => setAnim({ name: e.target.value }, false) } }))),
        el("span.small.muted", a.mode === "wipe"
          ? "Wipe: each pass paints the next colour across, each light blending in as it's reached."
          : "Band: a band of colour moves across over a dim glow of the same colour; each pass takes the next colour."),
        el("div.row", { style: { gap: "10px", flexWrap: "wrap" } },
          el("button.btn.primary", { type: "button", disabled: readOnly || n === 0, on: { click: playAnim } }, icon("play", 14), "Play"),
          el("button.btn", { type: "button", on: { click: saveAnim } }, "Save as a show"),
          n ? el("span.small.muted", `${n} placed light${n === 1 ? "" : "s"} here`) : null)));
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
    const tabs = [["palettes", "Palettes"], ["animations", "Animations"], ["shows", "Shows"], ["effects", "Effects"]];
    L.set(page, 
      runningCard(),
      el("div.tabs", { role: "tablist", "aria-label": "Library" }, tabs.map(([k, label]) =>
        el("button", { type: "button", role: "tab", "aria-selected": String(ui.tab === k),
          on: { click: () => { ui.tab = k; save("palettes.tab", k); paint(); } } }, label))),
      ui.tab === "shows" ? showsTab(readOnly) : ui.tab === "effects" ? effectsTab() : ui.tab === "animations" ? animTab(readOnly) : palettesTab(readOnly));
  }

  onData(async (d) => { last = d; await loadRunning(); paint(); }, { inventory: true });
  Promise.all([load(), loadHouse()]).then(() => start(4000));
})();
