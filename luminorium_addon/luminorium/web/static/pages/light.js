// One light (or fixture): what it can do, how it's reached, testing with options, its place.
"use strict";

(function () {
  const { el, icon, api, run, toast, onData, start, DRIVER, INTEGRATION, lightIcon, stateText } = L;
  const page = document.getElementById("page");
  const params = new URLSearchParams(location.search);
  const entityId = params.get("id");
  const fixtureId = params.get("fixture");
  const opts = { transition_s: 0, effect: "", hold_s: 2 };
  let resolved = null; // effect resolution for this light
  let placement = null;

  function kv(k, v) { return el("div.kv", el("span", k), el("span", v)); }

  function capsRows(light) {
    const p = light.profile || {};
    const c = p.capabilities || {};
    if (p.relay) return [kv("Type", "On/off relay"), kv("Switching", "At most once every 5 s")];
    return [
      kv("Brightness", c.dimming ? "Dimmable" : "On/off only"),
      kv("Colour", (c.color_modes || []).length ? `Full colour (${c.color_modes.join(", ")})` : "None"),
      kv("White", c.white ? `${c.white[0]}–${c.white[1]} K` : "No white control"),
      kv("Fades", c.transition === "native" ? "Native transitions" : "No (jumps to the new level)"),
      kv("Effects", c.effects && c.effects.length ? `${c.effects.length} built in` : "None"),
      c.segments ? kv("Segments", String(c.segments)) : null,
    ];
  }

  function driverCard(light) {
    const p = light.profile || {};
    const options = light.driver_options || ["ha"];
    const current = p.driver_override || null;
    const choices = [[null, "Automatic"], ...options.map((o) => [o, DRIVER[o] || o])];
    const d = p.details || {};
    return el("section.card", { "aria-labelledby": "drv" },
      el("h2#drv", "Driver and timing"),
      el("div.seg", { role: "radiogroup", "aria-label": "Driver" }, choices.map(([v, label]) =>
        el("button", { type: "button", role: "radio", "aria-checked": String(current === v),
          on: { click: () => setDriver(light, v) } }, label))),
      el("span.small.muted", current
        ? `Pinned to ${DRIVER[current] || current}.`
        : `Automatic uses the fastest driver that can reach it: ${DRIVER[p.driver] || p.driver} now.`),
      p.driver_note ? el("div.banner.warn", p.driver_note) : null,
      kv("Reached as", el("span.mono", p.endpoint || light.entity_id)),
      kv("Network", p.network),
      kv("Latency", el("span.mono", `${p.latency_ms} ms${d.latency_measured ? " (measured)" : " (default)"}`)),
      kv("Max rate", el("span.mono", `${p.max_rate_hz} Hz`)),
      d.node_id ? kv("Z-Wave node", el("span.mono", `${d.node_id} · ${d.node_status} · ${d.security}${d.multilevel_switch_version ? ` · Multilevel Switch v${d.multilevel_switch_version}` : ""}`)) : null);
  }

  function testCard(light, readOnly) {
    const c = (light.profile || {}).capabilities || {};
    const native = c.transition === "native";
    const fadeOut = el("span.mono", `${opts.transition_s.toFixed(1)} s`);
    const holdOut = el("span.mono", `${opts.hold_s} s`);
    return el("section.card", { "aria-labelledby": "tst" },
      el("h2#tst", "Test with options"),
      el("span.small.muted", "On, hold, off, hold, then back exactly as it was."),
      native ? el("label.field", el("span", "Fade", fadeOut),
        el("input", { type: "range", min: 0, max: 10, step: 0.5, value: opts.transition_s,
          on: { input: (e) => { opts.transition_s = Number(e.target.value); fadeOut.textContent = `${opts.transition_s.toFixed(1)} s`; } } }))
        : el("span.small.muted", "This light can't fade, so the test switches instantly."),
      (c.effects || []).length ? el("label.field", el("span", "Effect while on"),
        el("select", { on: { change: (e) => { opts.effect = e.target.value; } } },
          el("option", { value: "" }, "None"), c.effects.map((e) => el("option", { value: e, selected: opts.effect === e }, e)))) : null,
      el("label.field", el("span", "Hold", holdOut),
        el("input", { type: "range", min: 0, max: 30, step: 1, value: opts.hold_s,
          on: { input: (e) => { opts.hold_s = Number(e.target.value); holdOut.textContent = `${opts.hold_s} s`; } } })),
      el("button.btn.outline", { type: "button", disabled: readOnly || !light.available || !light.included,
        on: { click: () => runTest(light) } }, "Run test"));
  }

  function placeCard(light, inv) {
    const fx = light.fixture ? inv.fixtures.find((f) => f.id === light.fixture) : null;
    const target = fx ? fx.id : light.entity_id;
    const placed = placement && placement.lights && placement.lights[target];
    return el("section.card", { "aria-labelledby": "plc" },
      el("h2#plc", "Place and fixture"),
      el("div.row", { style: { padding: "12px 14px", borderRadius: "12px", background: "var(--card2)" } },
        icon("cube", 22), el("span", { style: { flex: "1" } }, placed ? `On the house map · ${placed.mount || "placed"}, ${L.fmtLen(placed.h)} up` : "Not on the house map yet"),
        el("a", { href: `house?select=${encodeURIComponent(target)}` }, placed ? "Move it" : "Place it")),
      el("div.row", { style: { padding: "12px 14px", borderRadius: "12px", background: "var(--card2)" } },
        icon("fixture", 22), el("span", { style: { flex: "1" } }, fx ? `Part of ${fx.name}` : "Not part of a fixture"),
        fx ? el("a", { href: `light?fixture=${encodeURIComponent(fx.id)}` }, "Open fixture") : el("a", { href: "lights" }, "Group with…")),
      el("div", { style: { display: "flex", flexDirection: "column", gap: "4px", paddingTop: "4px" } },
        el("span.small.muted", "Home Assistant"),
        el("span.mono", light.entity_id),
        el("span.mono.small.muted", [INTEGRATION[light.integration] || light.integration, light.device_name].filter(Boolean).join(" · "))));
  }

  function effectsCard() {
    if (!resolved) return null;
    const rows = Object.entries(resolved);
    const label = { native: "Built in", close: "Built in (close)", software: "Software", static: "Colour only" };
    return el("section.card", { "aria-labelledby": "fx" },
      el("div.card-head", el("h2#fx", "Effects on this light"), el("span.small.muted", "What a show's effect becomes here")),
      el("div.grid", { style: { "--min": "220px", gap: "8px" } }, rows.map(([k, r]) =>
        el("div.row", { style: { padding: "8px 12px", borderRadius: "10px", background: "var(--card2)", justifyContent: "space-between" } },
          el("b", { style: { fontWeight: "500" } }, k),
          el(`span.tag.${r.method === "native" || r.method === "close" ? "show" : r.method === "software" ? "info" : ""}`, `${label[r.method] || r.method}${r.name ? `: ${r.name}` : ""}`)))));
  }

  function header(light, extra) {
    const p = light.profile || {};
    return el("section.card", { "aria-label": light.name, style: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: "20px" } },
      el("div", { class: `licon${light.state === "on" ? " on" : ""}`, style: { width: "72px", height: "72px", borderRadius: "18px" } }, icon(lightIcon(light), 38)),
      el("div", { style: { flex: "1 1 260px", display: "flex", flexDirection: "column", gap: "4px" } },
        el("h2", { style: { fontSize: "22px" } }, light.name),
        el("span.muted", [[light.manufacturer, light.model].filter(Boolean).join(" "), light.area_name].filter(Boolean).join(" · ")),
        el("span", { class: "row", style: { gap: "8px" } }, el("span", { class: `sdot${light.state === "on" ? " on" : light.available ? "" : " na"}` }), stateText(light)),
        light.exclude_reason && !light.included ? el("span.badge.warn", light.exclude_reason) : null),
      el("div.row", extra));
  }

  // ---- actions ----------------------------------------------------------------------------
  async function setDriver(light, driver) {
    await run(() => api(`api/lights/${encodeURIComponent(light.entity_id)}/driver`, { method: "PUT", body: { driver } }));
    L.refresh(true);
  }
  async function include(light, value) {
    await run(() => api(`api/lights/${encodeURIComponent(light.entity_id)}/include`, { method: "PUT", body: { include: value } }));
    L.refresh(true);
  }
  async function runTest(light, plain = false) {
    const body = plain ? undefined : { transition_ms: Math.round(opts.transition_s * 1000), effect: opts.effect || null, hold_s: opts.hold_s };
    await run(async () => {
      await api(`api/lights/${encodeURIComponent(light.entity_id)}/test`, { method: "POST", body });
      toast(`Testing ${light.name}`);
    });
    setTimeout(() => L.refresh(true), 300);
  }
  async function testFixture(fx) {
    await run(async () => { await api(`api/fixtures/${encodeURIComponent(fx.id)}/test`, { method: "POST" }); toast(`Testing ${fx.name}`); });
    setTimeout(() => L.refresh(true), 300);
  }
  async function ungroup(fx) {
    await run(() => api(`api/fixtures/${encodeURIComponent(fx.id)}`, { method: "DELETE" }));
    location.href = "lights";
  }

  // ---- render -----------------------------------------------------------------------------
  function render({ status, inventory }) {
    if (!inventory) return;
    const areas = new Map(inventory.areas.map((a) => [a.id, a]));
    const floors = new Map(inventory.floors.map((f) => [f.id, f.name]));
    const withArea = (l) => ({ ...l, area_name: [areas.get(l.area_id)?.name, floors.get(l.floor_id)].filter(Boolean).join(", ") });
    const readOnly = status.read_only;

    if (fixtureId) {
      const fx = inventory.fixtures.find((f) => f.id === fixtureId);
      if (!fx) { L.set(page, el("div.empty", "This fixture no longer exists."), el("a.btn", { href: "lights" }, "Back to lights")); return; }
      const members = fx.members.map((id) => inventory.lights.find((l) => l.entity_id === id)).filter(Boolean).map(withArea);
      L.setTitle(fx.name);
      const first = members[0] || { profile: {} };
      const pseudo = { ...first, name: fx.name, state: members.some((m) => m.state === "on") ? "on" : "off", fixture: null };
      L.set(page, 
        header({ ...pseudo, model: `Fixture · ${members.length} lights` }, [
          el("button.btn.primary", { type: "button", disabled: readOnly, on: { click: () => testFixture(fx) } }, "Test all together"),
          el("button.btn", { type: "button", on: { click: () => ungroup(fx) } }, "Ungroup")]),
        el("div.cols",
          el("section.card", el("h2", "Lights in this fixture"),
            members.map((m) => el("div.list-row", el("span", { class: `sdot${m.state === "on" ? " on" : ""}` }),
              el("a", { href: `light?id=${encodeURIComponent(m.entity_id)}`, style: { flex: "1" } }, m.name),
              el("span.small.muted", stateText(m))))),
          el("section.card", el("h2", "What they can do"), capsRows(first)),
          placeCard({ ...first, fixture: fx.id }, inventory)));
      return;
    }

    const light = inventory.lights.find((l) => l.entity_id === entityId);
    if (!light) { L.set(page, el("div.empty", "This light isn't in Home Assistant any more."), el("a.btn", { href: "lights" }, "Back to lights")); return; }
    if (light.fixture) {
      // A light in a fixture is tested from the fixture
    }
    L.setTitle(light.name);
    const canInclude = !["group", "setting", "segment"].includes(light.kind);
    const testable = light.included && light.available && (light.kind === "light" || light.kind === "switch");
    L.set(page, 
      header(withArea(light), [
        canInclude ? el("label.check.btn.quiet", el("input", { type: "checkbox", checked: light.included, on: { change: (e) => include(light, e.target.checked) } }), "Included") : null,
        light.fixture ? el("a.btn.primary", { href: `light?fixture=${encodeURIComponent(light.fixture)}` }, "Test with its fixture")
          : el("button.btn.primary", { type: "button", disabled: !testable || readOnly, on: { click: () => runTest(light, true) } }, "Test")]),
      el("div.cols",
        el("section.card", { "aria-labelledby": "cap" }, el("h2#cap", "What it can do"), capsRows(light)),
        light.kind === "light" || light.kind === "switch" ? driverCard(light) : null,
        testable && !light.fixture ? testCard(light, readOnly) : null,
        placeCard(light, inventory)),
      effectsCard());
  }

  async function loadExtras() {
    if (entityId) resolved = (await api(`api/lights/${encodeURIComponent(entityId)}/effects`).catch(() => null)) || null;
    placement = (await api("api/house").catch(() => null)) || null;
  }

  onData(render, { inventory: true });
  loadExtras().finally(() => start(5000));
})();
