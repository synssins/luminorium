// Drivers: how Luminorium reaches each light, and how each path is doing.
"use strict";

(function () {
  const { el, icon, onData, start, DRIVER } = L;
  const page = document.getElementById("page");

  function stats(name, d) {
    const s = (v, k) => [v ?? "–", k];
    switch (name) {
      case "z2m": return [s(d.devices, "devices"), s(d.groups, "groups"), s(d.bridge_online ? "online" : "offline", "bridge")];
      case "zwave_js": return [s(d.nodes, "nodes"), s(d.multicasts, "multicasts"), s(d.read_back_misses, "missed")];
      case "wiz": return [s(d.bulbs, "bulbs"), s((d.subnets || []).length, "networks"), s("UDP", "38899")];
      case "wled": return [s(d.devices, "controllers"), s("JSON", "+ DDP"), s("UDP", "4048")];
      case "govee": return [s(d.devices, "devices"), s((d.razer_models || []).length, "streaming"), s("UDP", "4002")];
      default: return [s("WS", "API"), s("2 Hz", "per light"), s("10/s", "budget")];
    }
  }
  function endpoint(name, d) {
    if (name === "z2m") return "MQTT · zigbee2mqtt/";
    if (name === "zwave_js") return `${d.url || "Z-Wave JS server"}${d.server ? ` · ${d.server}` : ""}`;
    if (name === "wiz" || name === "govee") return (d.subnets || []).join(", ") || "LAN";
    if (name === "ha") return "Home Assistant services";
    return "LAN";
  }
  function note(name, d) {
    if (d.error && !d.connected) return [d.error, "warn"];
    if (name === "zwave_js" && d.unicast_only && d.unicast_only.length)
      return [`Node${d.unicast_only.length > 1 ? "s" : ""} ${d.unicast_only.join(", ")} missed a multicast (out of the stick's direct range) and get${d.unicast_only.length > 1 ? "" : "s"} their own command instead.`, "info"];
    if (name === "govee" && d.connected && !d.devices)
      return ["No Govee device has answered. Turn on LAN Control for each one in the Govee Home app; until then Govee lights go through Home Assistant (Govee's cloud).", "warn"];
    if (name === "ha") return ["The fallback: any light no direct driver can reach goes through Home Assistant.", "info"];
    return null;
  }

  function render({ status, inventory }) {
    if (!status || !inventory) return;
    const used = {};
    for (const l of inventory.lights) {
      if (!l.included || !l.profile) continue;
      used[l.profile.driver] = (used[l.profile.driver] || 0) + 1;
    }
    const drivers = Object.entries(status.drivers || {});
    L.set(page, 
      el("div.grid", { style: { "--min": "340px", gap: "16px" } }, drivers.map(([name, d]) => {
        const n = note(name, d);
        const state = d.connected ? ["ok", "Connected"] : d.enabled ? ["warn", d.error ? "Problem" : "Starting"] : ["", "Off"];
        return el("article.card", { style: { borderColor: d.connected ? "" : "var(--warn-line)" } },
          el("div.row", { style: { gap: "12px", flexWrap: "nowrap" } },
            el("div.licon", { style: { width: "44px", height: "44px" } }, icon("chip", 24)),
            el("div", { style: { flex: "1", minWidth: "0", display: "flex", flexDirection: "column" } },
              el("h2", DRIVER[name] || name), el("span.mono.small.muted", { style: { overflowWrap: "anywhere" } }, endpoint(name, d))),
            el(`span.pill.${state[0]}`, el("span.dot"), state[1])),
          el("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" } },
            stats(name, d).map(([v, k]) => el("div", { style: { padding: "10px 12px", borderRadius: "10px", background: "var(--card2)", display: "flex", flexDirection: "column" } },
              el("span.mono", { style: { fontSize: "18px", fontWeight: "500" } }, String(v)), el("span.small.muted", k)))),
          n ? el(`div.banner${n[1] === "warn" ? ".warn" : ""}`, { style: { fontSize: "14px" } }, n[0]) : null,
          el("div.row", { style: { borderTop: "1px solid var(--line)", paddingTop: "10px" } },
            el("span.small.muted", { style: { flex: "1" } }, used[name] ? `${used[name]} light(s) use it now` : "No lights use it now"),
            el("a.small", { href: "lights" }, "Lights")));
      })),
      el("p.small.muted", "Drivers are switched on and off, and their networks set, in the add-on's options in Home Assistant (Settings › Add-ons › Luminorium › Configuration). Each light can be pinned to a driver on its own page."));
  }

  onData(render, { inventory: true });
  start(5000);
})();
