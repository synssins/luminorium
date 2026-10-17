// Settings: what's set where, and the phone camera check.
"use strict";

(function () {
  const { el, onData, start, store, save } = L;
  const page = document.getElementById("page");

  function themeCard() {
    const current = store("theme", "auto");
    const pick = (v) => { save("theme", v); applyTheme(v); render(); };
    return el("section.card", el("h2", "Appearance"),
      el("div.seg", { role: "radiogroup", "aria-label": "Theme" },
        [["auto", "Match the device"], ["dark", "Dark"], ["light", "Light"]].map(([v, label]) =>
          el("button", { type: "button", role: "radio", "aria-checked": String(current === v), on: { click: () => pick(v) } }, label))));
  }

  let status = null;
  function render() {
    if (!status) return;
    L.set(page, 
      el("div.cols",
        el("section.card", el("h2", "Luminorium"),
          el("div.kv", el("span", "Version"), el("span.mono", status.version)),
          el("div.kv", el("span", "Home Assistant"), el("span", status.connected ? `Connected, ${status.ha_version}` : "Disconnected")),
          el("div.kv", el("span", "Mode"), el("span", status.read_only ? "Read-only: nothing is sent to lights" : "Normal")),
          el("p.small.muted", "Read-only mode, the drivers and their networks are set in the add-on's options in Home Assistant (Settings › Add-ons › Luminorium › Configuration).")),
        themeCard(),
        el("section.card", el("h2", "Phone camera check"),
          el("p.muted", { style: { margin: "0" } }, "Checks whether this phone's browser (or the HA app) lets Luminorium use the camera and motion sensors, which camera mapping needs."),
          el("a.btn", { href: "camera" }, "Open the camera check")),
        el("section.card", el("h2", "Your files"),
          el("p.muted", { style: { margin: "0" } }, "Palettes, shows, effects, views and the house map are kept in the add-on's config folder, and are included in Home Assistant backups."))));
  }

  onData((d) => { status = d.status; render(); });
  start(10000);
})();

function applyTheme(v) {
  if (v === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", v);
}
