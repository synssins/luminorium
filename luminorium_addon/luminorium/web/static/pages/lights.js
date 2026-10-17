// Lights: every light by level and room, as cards. Fixtures, suggestions, grouping, include, Test.
"use strict";

(function () {
  const { el, icon, api, run, toast, onData, start, store, save, DRIVER, lightIcon, stateText } = L;
  const page = document.getElementById("page");
  const ui = {
    filter: store("lights.filter", "included"),
    search: "",
    collapsed: new Set(store("collapsed", [])),
    grouping: false,
    selected: new Set(),
    groupName: "",
    showSuggestions: false,
  };
  let last = null;

  const FILTERS = [
    ["included", "Included", (l) => l.included && l.kind !== "group"],
    ["switches", "Switches", (l) => l.kind === "switch"],
    ["excluded", "Excluded", (l) => !l.included],
    ["all", "All", () => true],
  ];

  function matches(l) {
    const f = FILTERS.find((x) => x[0] === ui.filter) || FILTERS[0];
    if (!f[2](l)) return false;
    if (!ui.search) return true;
    return `${l.name} ${l.entity_id} ${l.model || ""} ${l.manufacturer || ""}`.toLowerCase().includes(ui.search);
  }

  function collapse(key) {
    if (ui.collapsed.has(key)) ui.collapsed.delete(key);
    else ui.collapsed.add(key);
    save("collapsed", [...ui.collapsed]);
    paint();
  }
  const isOpen = (key) => !!ui.search || !ui.collapsed.has(key);

  // ---- cards ------------------------------------------------------------------------------

  function caps(light) {
    const p = light.profile || {};
    const c = p.capabilities || {};
    const out = [];
    if (p.relay) out.push("On/off relay");
    else {
      if (light.white_only) out.push("White bulbs only");
      else if (c.color_modes && c.color_modes.length) out.push("Colour");
      if (c.white) out.push("White");
      else if (c.dimming && !(c.color_modes || []).length) out.push("Dim");
      if (c.effects && c.effects.length) out.push(`${c.effects.length} effects`);
      if (c.segments) out.push(`${c.segments} segments`);
    }
    return out;
  }

  function warnings(light) {
    const p = light.profile || {};
    const c = p.capabilities || {};
    const d = p.details || {};
    const out = [];
    if (!light.included && light.exclude_reason) out.push(light.exclude_reason);
    if (c.transition === "none" && light.kind === "light" && !p.relay) out.push("No fades");
    if (d.node_status === "dead") out.push("Z-Wave node dead");
    if (p.driver_note) out.push(p.driver_note);
    if (light.duplicates && light.duplicates.length) out.push("Same light as another?");
    return out;
  }

  function driverBadge(light) {
    const p = light.profile || {};
    return el("span.badge.drv", { title: p.endpoint || "" }, DRIVER[p.driver] || p.driver || "?", el("span.mono", `${p.latency_ms} ms`));
  }

  function lightCard(light, busy, readOnly) {
    const testable = light.included && light.available && (light.kind === "light" || light.kind === "switch");
    const canInclude = !["group", "setting", "segment"].includes(light.kind);
    return el("article.lcard", { class: `lcard${light.included ? "" : " excluded"}${busy.has(light.entity_id) ? " busy" : ""}` },
      el("div.lcard-top",
        ui.grouping && (light.kind === "light" || light.kind === "switch") && !light.fixture
          ? el("label", { style: { display: "flex", alignItems: "center", minHeight: "44px" } },
            el("span.sr", `Select ${light.name}`),
            el("input", { type: "checkbox", checked: ui.selected.has(light.entity_id),
              on: { change: (e) => { e.target.checked ? ui.selected.add(light.entity_id) : ui.selected.delete(light.entity_id); paint(); } } }))
          : null,
        el("div", { class: `licon${light.state === "on" ? " on" : ""}${light.available ? "" : " na"}` }, icon(lightIcon(light), 26)),
        el("div.who",
          el("a.name", { href: `light?id=${encodeURIComponent(light.entity_id)}` }, light.name),
          el("span.model", [light.manufacturer, light.model].filter(Boolean).join(" ") || light.entity_id),
          el("span.state", stateText(light))),
        canInclude ? el("label.check", { title: "Included in Luminorium" },
          el("span.sr", "Included"),
          el("input", { type: "checkbox", checked: light.included, on: { change: (e) => include(light, e.target.checked) } })) : null),
      el("div.badges", driverBadge(light), caps(light).map((c) => el("span.badge", c)),
        warnings(light).map((w) => el("span.badge.warn", w)),
        light.hint ? el("span.badge.hint", light.hint) : null),
      el("div.lcard-actions",
        el("button.btn", { type: "button", disabled: !testable || readOnly || busy.has(light.entity_id),
          title: readOnly ? "Read-only mode" : "On, off, then back as it was", on: { click: () => testLight(light) } }, "Test"),
        el("a.btn.quiet", { href: `light?id=${encodeURIComponent(light.entity_id)}` }, "Details")));
  }

  function fixtureCard(fx, members, busy, readOnly) {
    const on = members.some((l) => l.state === "on");
    const testable = members.some((l) => l.included && l.available);
    const inUse = members.some((l) => busy.has(l.entity_id));
    const first = members[0] || {};
    const nameBox = el("a.name", { href: `light?fixture=${encodeURIComponent(fx.id)}` }, fx.name);
    return el("article.lcard.fixture", { class: `lcard fixture${inUse ? " busy" : ""}` },
      el("div.lcard-top",
        el("div", { class: `licon${on ? " on" : ""}` }, icon("fixture", 26)),
        el("div.who", nameBox,
          el("span.model", `Fixture · ${members.length} lights · ${[first.manufacturer, first.model].filter(Boolean).join(" ")}`),
          el("span.state", on ? "On" : "Off"))),
      el("div.badges", driverBadge(first), caps(first).map((c) => el("span.badge", c))),
      el("div.members", members.map((m) => el("span", el("span", { class: `sdot${m.state === "on" ? " on" : m.available ? "" : " na"}` }), m.name))),
      el("div.lcard-actions",
        el("button.btn", { type: "button", disabled: !testable || readOnly || inUse, on: { click: () => testFixture(fx) } }, "Test"),
        el("button.btn.quiet", { type: "button", on: { click: () => rename(fx, nameBox) } }, "Rename"),
        el("button.btn.quiet", { type: "button", on: { click: () => ungroup(fx) } }, "Ungroup")));
  }

  // ---- actions ------------------------------------------------------------------------------

  async function include(light, value) {
    await run(() => api(`api/lights/${encodeURIComponent(light.entity_id)}/include`, { method: "PUT", body: { include: value } }));
    L.refresh(true);
  }
  async function testLight(light) {
    await run(async () => { await api(`api/lights/${encodeURIComponent(light.entity_id)}/test`, { method: "POST" }); toast(`Testing ${light.name}`); });
    setTimeout(() => L.refresh(true), 300);
  }
  async function testFixture(fx) {
    await run(async () => {
      const r = await api(`api/fixtures/${encodeURIComponent(fx.id)}/test`, { method: "POST" });
      toast(r.skipped && r.skipped.length ? `Testing ${fx.name}; skipped ${r.skipped.join(", ")}` : `Testing ${fx.name}`);
    });
    setTimeout(() => L.refresh(true), 300);
  }
  async function ungroup(fx) {
    await run(() => api(`api/fixtures/${encodeURIComponent(fx.id)}`, { method: "DELETE" }));
    toast(`${fx.name} ungrouped`);
    L.refresh(true);
  }
  function rename(fx, nameBox) {
    const input = el("input.input", { value: fx.name, "aria-label": "Fixture name" });
    let done = false;
    const finish = async (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (keep && name && name !== fx.name) await run(() => api(`api/fixtures/${encodeURIComponent(fx.id)}`, { method: "PUT", body: { name } }));
      L.refresh(true);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
    input.addEventListener("blur", () => finish(true));
    nameBox.replaceWith(input);
    input.focus();
    input.select();
  }
  async function groupSelected() {
    await run(async () => {
      await api("api/fixtures", { method: "POST", body: { name: ui.groupName, members: [...ui.selected] } });
      toast("Grouped as one fixture");
      ui.grouping = false;
      ui.selected.clear();
      ui.groupName = "";
    });
    L.refresh(true);
  }
  async function suggestion(s, accept) {
    await run(() => accept
      ? api("api/fixtures", { method: "POST", body: { name: s.name, members: s.members } })
      : api("api/fixture_suggestions/dismiss", { method: "POST", body: { members: s.members } }));
    L.refresh(true);
  }

  // ---- page ---------------------------------------------------------------------------------

  function toolbar(inv) {
    const counts = Object.fromEntries(FILTERS.map(([k, , f]) => [k, inv.lights.filter(f).length]));
    const search = el("label.search", icon("search", 18), el("span.sr", "Search lights"),
      el("input", { type: "search", placeholder: "Search name, room, model or entity", value: ui.search,
        on: { input: (e) => { ui.search = e.target.value.trim().toLowerCase(); paintList(); } } }));
    return el("div.row", search,
      el("div.chips", { role: "group", "aria-label": "Show" }, FILTERS.map(([k, label]) =>
        el("button.chip", { type: "button", "aria-pressed": String(ui.filter === k),
          on: { click: () => { ui.filter = k; save("lights.filter", k); paint(); } } }, label, el("span.n", counts[k])))),
      el("span.spacer"),
      el("button.btn.quiet", { type: "button", "aria-pressed": String(ui.grouping),
        on: { click: () => { ui.grouping = !ui.grouping; ui.selected.clear(); paint(); } } }, ui.grouping ? "Cancel grouping" : "Group lights"),
      el("button.btn.quiet", { type: "button", on: { click: () => {
        const all = [...inv.floors.map((f) => `f:${f.id}`), ...inv.areas.map((a) => `a:${a.id}`)];
        ui.collapsed = ui.collapsed.size ? new Set() : new Set(all);
        save("collapsed", [...ui.collapsed]);
        paint();
      } } }, ui.collapsed.size ? "Expand all" : "Collapse all"));
  }

  function suggestionsBox(inv) {
    const sugg = inv.suggestions || [];
    if (!sugg.length || ui.filter === "excluded") return null;
    const byId = new Map(inv.lights.map((l) => [l.entity_id, l]));
    const areas = new Map(inv.areas.map((a) => [a.id, a.name]));
    return el("section.banner", { "aria-label": "Fixture suggestions" },
      icon("fixture", 22),
      el("span", { style: { flex: "1 1 320px" } }, el("b", `${sugg.length} possible fixture${sugg.length === 1 ? "" : "s"}. `),
        "Lights of one model with numbered names in the same room may share one fitting."),
      el("button.btn.small", { type: "button", "aria-expanded": String(ui.showSuggestions),
        on: { click: () => { ui.showSuggestions = !ui.showSuggestions; paint(); } } }, ui.showSuggestions ? "Hide" : "Review"),
      ui.showSuggestions ? el("div", { style: { flexBasis: "100%", display: "flex", flexDirection: "column", gap: "8px" } },
        sugg.map((s) => el("div.row", { style: { padding: "10px 12px", borderRadius: "10px", background: "var(--card)" } },
          el("span", { style: { flex: "1 1 260px" } }, el("b", s.members.map((m) => (byId.get(m) || { name: m }).name).join(" + ")),
            el("span.muted.small", ` · ${areas.get(s.area_id) || ""}`)),
          el("button.btn.small.outline", { type: "button", on: { click: () => suggestion(s, true) } }, "Group as one"),
          el("button.btn.small", { type: "button", on: { click: () => suggestion(s, false) } }, "Not the same")))) : null);
  }

  function list(inv, status) {
    const busy = new Set(status.touched || []);
    const readOnly = status.read_only;
    const byId = new Map(inv.lights.map((l) => [l.entity_id, l]));
    const fixtures = new Map(inv.fixtures.map((f) => [f.id, f]));
    const byArea = new Map();
    const add = (area, item) => { if (!byArea.has(area)) byArea.set(area, []); byArea.get(area).push(item); };
    for (const l of inv.lights) {
      if (l.kind === "segment" || (l.fixture && fixtures.has(l.fixture)) || !matches(l)) continue;
      add(l.area_id, { name: l.name, lights: [l], light: l });
    }
    for (const f of fixtures.values()) {
      const members = f.members.map((id) => byId.get(id)).filter(Boolean);
      if (members.some(matches)) add(f.area_id, { name: f.name, lights: members, fixture: f });
    }
    const out = [];
    for (const floor of inv.floors) {
      const areas = inv.areas.filter((a) => a.floor_id === floor.id && byArea.has(a.id));
      if (!areas.length) continue;
      const items = areas.flatMap((a) => byArea.get(a.id));
      const lightsHere = items.flatMap((i) => i.lights);
      const onCount = lightsHere.filter((l) => l.state === "on").length;
      const fk = `f:${floor.id}`;
      const open = isOpen(fk);
      out.push(el("section.floor", { id: `floor-${floor.id}`, "aria-label": floor.name },
        el("h2.floor-head", el("button", { type: "button", "aria-expanded": String(open), on: { click: () => collapse(fk) } },
          icon("chev", 14, "chev"), el("span", floor.name),
          el("span.count", `${lightsHere.length} ${lightsHere.length === 1 ? "light" : "lights"}${onCount ? ` · ${onCount} on` : ""}`))),
        open ? areas.map((area) => {
          const ak = `a:${area.id}`;
          const aOpen = isOpen(ak);
          const its = byArea.get(area.id).sort((a, b) => a.name.localeCompare(b.name));
          const n = its.flatMap((i) => i.lights);
          const aOn = n.filter((l) => l.state === "on").length;
          return el("div.room",
            el("h3.room-head", el("button", { type: "button", "aria-expanded": String(aOpen), on: { click: () => collapse(ak) } },
              icon("chev", 12, "chev"), area.name,
              el("span.count", `${n.length} ${n.length === 1 ? "light" : "lights"}${aOn ? ` · ${aOn} on` : ""}`))),
            aOpen ? el("div.grid", { style: { "--min": "290px", gap: "12px" } },
              its.map((i) => i.fixture ? fixtureCard(i.fixture, i.lights, busy, readOnly) : lightCard(i.light, busy, readOnly))) : null);
        }) : null));
    }
    if (!out.length) out.push(el("div.empty", ui.search ? `Nothing matches “${ui.search}”.` : "Nothing to show here."));
    return out;
  }

  function groupBar() {
    if (!ui.grouping) return null;
    const n = ui.selected.size;
    const input = el("input", { placeholder: "Fixture name (optional)", "aria-label": "Fixture name", value: ui.groupName,
      on: { input: (e) => { ui.groupName = e.target.value; } } });
    return el("div.groupbar", el("b", n ? `${n} selected` : "Tick the lights that share one fitting"), input,
      el("button.btn.primary", { type: "button", disabled: n < 2, on: { click: groupSelected } }, "Group as one fixture"),
      el("button.btn", { type: "button", on: { click: () => { ui.grouping = false; ui.selected.clear(); paint(); } } }, "Cancel"));
  }

  let listBox = null;
  function paintList() {
    if (!last || !listBox) return;
    listBox.replaceChildren(...list(last.inventory, last.status));
  }

  function paint() {
    if (!last) return;
    const { inventory, status } = last;
    listBox = el("div", { style: { display: "flex", flexDirection: "column", gap: "22px" } });
    const searchHadFocus = document.activeElement && document.activeElement.type === "search";
    L.set(page, toolbar(inventory), suggestionsBox(inventory), listBox, groupBar());
    paintList();
    if (searchHadFocus) {
      const s = page.querySelector("input[type=search]");
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
    if (location.hash && !paint.scrolled) {
      paint.scrolled = true;
      const target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }

  onData((d) => {
    if (!d.inventory) return;
    last = d;
    if (ui.grouping && L.typing()) return;
    paint();
  }, { inventory: true });
  start();
})();
