// The app shell: the menu, the top bar (status and Stop all), toasts, and shared helpers.
// Every page loads this first. All URLs are relative: HA Ingress serves the app under a prefix.
// No prompt()/confirm()/alert(): the HA companion app's webview may not show them.
"use strict";

(function () {
  const ICONS = {
    home: "M3 11l9-8 9 8M5 10v10h14V10",
    bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z",
    fixture: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
    palette: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-1.2-1-1.5-1-2.5s.8-2 2-2H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01",
    cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
    views: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5",
    camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    chip: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
    pulse: "M3 12h4l3-8 4 16 3-8h4",
    gear: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
    stop: "M6 6h12v12H6z",
    play: "M7 4l13 8-13 8z",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
    chev: "M9 6l6 6-6 6",
    menu: "M4 7h16M4 12h16M4 17h16",
    dimmer: "M7 3h10v18H7zM12 7v6M10 16h4",
    strip: "M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M19 8v8",
    flood: "M6 4h12l-2 8H8zM12 12v8M8 20h8",
    relay: "M5 12h4l6-5M15 12h4M9 12a0 0 0 0 0 0 0",
    group: "M4 6h7v7H4zM13 11h7v7h-7z",
  };
  const NAV = [
    ["overview", "Overview", "./", "home"],
    ["lights", "Lights", "lights", "bulb"],
    ["palettes", "Palettes & shows", "palettes", "palette"],
    ["house", "House map", "house", "cube"],
    ["views", "Views", "views", "views"],
    ["capture", "Map with camera", "capture", "camera"],
    ["drivers", "Drivers", "drivers", "chip"],
    "-",
    ["activity", "Activity", "activity", "pulse"],
    ["settings", "Settings", "settings", "gear"],
  ];

  // ---- helpers --------------------------------------------------------------------------

  function icon(name, size = 20, extra = "") {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("fill", name === "stop" || name === "play" ? "currentColor" : "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.8");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    if (extra) s.setAttribute("class", extra);
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", ICONS[name] || ICONS.bulb);
    s.append(p);
    return s;
  }

  // el("div.card#id", {attrs, on: {click}}, ...children): a small element builder
  function el(spec, attrs, ...kids) {
    if (attrs instanceof Node || typeof attrs === "string" || Array.isArray(attrs)) {
      kids.unshift(attrs);
      attrs = null;
    }
    const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
    const node = document.createElement(m[1] || "div");
    for (const part of (m[2] || "").match(/[.#][\w-]+/g) || []) {
      if (part[0] === ".") node.classList.add(part.slice(1));
      else node.id = part.slice(1);
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "text") node.textContent = v;
      else if (k in node && typeof v !== "string") node[k] = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  async function api(path, options = {}) {
    const init = { headers: { "Content-Type": "application/json" }, ...options };
    if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
    const res = await fetch(path, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || res.statusText || "request failed");
    return body;
  }

  function toast(message, ms = 4500) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms);
  }

  // Run an async action; a failure shows as a toast
  async function run(fn) {
    try {
      return await fn();
    } catch (e) {
      toast(e.message || String(e));
      return undefined;
    }
  }

  function store(key, fallback) {
    try {
      const v = localStorage.getItem("luminorium." + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem("luminorium." + key, JSON.stringify(value));
    } catch {
      // storage unavailable: settings last for this visit
    }
  }

  // ---- data: status (and inventory when a page asks), polled -------------------------

  const listeners = [];
  const data = { status: null, inventory: null };
  let wantInventory = false;

  function typing() {
    const a = document.activeElement;
    if (!a || !a.closest || !a.closest("#page")) return false;
    if (a.tagName === "SELECT" || a.tagName === "TEXTAREA") return true;
    return a.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(a.type);
  }

  async function refresh(force = false) {
    try {
      const [status, inventory] = await Promise.all([
        api("api/status"),
        wantInventory ? api("api/inventory") : Promise.resolve(null),
      ]);
      data.status = status;
      if (inventory) data.inventory = inventory;
      paintChrome();
      if (force || !typing()) for (const fn of listeners) fn(data);
    } catch (e) {
      const pill = document.getElementById("ha-pill");
      if (pill) {
        pill.className = "pill bad";
        pill.lastChild.textContent = "Luminorium not reachable";
      }
    }
  }

  function onData(fn, { inventory = false } = {}) {
    listeners.push(fn);
    if (inventory) wantInventory = true;
  }

  // ---- chrome ------------------------------------------------------------------------------

  function paintChrome() {
    const s = data.status;
    if (!s) return;
    const pill = document.getElementById("ha-pill");
    pill.className = "pill " + (s.connected ? "ok" : "bad");
    pill.lastChild.textContent = s.connected ? `Home Assistant ${s.ha_version || ""}` : "Home Assistant disconnected";
    const mode = document.getElementById("mode-pill");
    mode.hidden = !s.read_only;
    document.getElementById("version").textContent = s.version;
    const counts = {
      lights: s.counts ? s.counts.lights + s.counts.switches : "",
      drivers: s.drivers ? `${Object.values(s.drivers).filter((d) => d.connected).length}/${Object.keys(s.drivers).length}` : "",
      palettes: (s.shows || []).length ? `${s.shows.length} on` : "",
    };
    for (const [key, value] of Object.entries(counts)) {
      const c = document.querySelector(`.navlink[data-key="${key}"] .count`);
      if (c) c.textContent = value;
    }
  }

  function build() {
    const body = document.body;
    const page = body.dataset.page || "overview";
    const title = body.dataset.title || document.title.replace(/ · Luminorium$/, "");
    const kids = [...body.childNodes].filter((n) => n.nodeName !== "SCRIPT");

    const nav = el("nav.nav", { "aria-label": "Luminorium" },
      el("a.nav-brand", { href: "./" },
        el("span", { style: { color: "var(--accent)", display: "inline-flex" } }, icon("bulb", 28)),
        el("span", el("b", "Luminorium"), el("small#version", ""))),
      el("button.btn.small.nav-toggle", {
        type: "button", "aria-expanded": "false", "aria-label": "Menu",
        on: { click: (e) => { const open = nav.classList.toggle("open"); e.currentTarget.setAttribute("aria-expanded", String(open)); } },
      }, icon("menu", 18)),
      NAV.map((item) => item === "-" ? el("div.nav-sep", { role: "separator" }) :
        el("a.navlink", { href: item[2], "data-key": item[0], "aria-current": item[0] === page ? "page" : null },
          icon(item[3]), el("span", item[1]), el("span.count", ""))));

    const crumbs = (body.dataset.crumbs || "").split("|").filter(Boolean);
    const titleBox = el("div.title",
      crumbs.map((c) => { const [label, href] = c.split("@"); return [el("a", { href }, label), el("span.sep", "/")]; }),
      el("h1#page-title", title));
    const stop = el("button.btn.stop#stopall", { type: "button" }, icon("stop", 16), "Stop all");
    const top = el("header.topbar",
      titleBox,
      el("span#top-extra.row"),
      el("span.pill#mode-pill", { hidden: true }, el("span.dot"), "Read-only"),
      el("span.pill#ha-pill", el("span.dot"), el("span", "Connecting…")),
      stop);
    const main = el("main#page", { class: body.dataset.wide ? "page wide" : "page" });
    if (body.dataset.legacy) main.className = "";
    main.append(...kids);

    body.replaceChildren(el("div.app", nav, el("div.body", top, main)), el("div#toast", { role: "status", hidden: true }));

    if (!body.dataset.ownStop) {
      stop.addEventListener("click", () => run(async () => {
        const r = await api("api/stop_all", { method: "POST" });
        toast(`Stopped everything; ${r.restored} light(s) put back`);
        refresh(true);
      }));
    }
    document.title = `${title} · Luminorium`;
  }

  // ---- the house's lights, shared by pages ------------------------------------------------

  const INTEGRATION = {
    zigbee2mqtt: "Zigbee", govee2mqtt: "Govee", zwave_js: "Z-Wave", wiz: "WiZ", wled: "WLED",
    esphome: "ESPHome", matter: "Matter", mqtt: "MQTT", group: "Group", browser_mod: "Browser",
  };
  const DRIVER = { ha: "Home Assistant", z2m: "Zigbee2MQTT", zwave_js: "Z-Wave JS", wiz: "WiZ", wled: "WLED", govee: "Govee LAN" };

  function lightIcon(light) {
    const p = light.profile || {};
    const c = p.capabilities || {};
    if (p.relay || light.kind === "switch") return "relay";
    if (c.segments || /strip|pathway|string|bar/i.test(light.name)) return "strip";
    if (light.integration === "zwave_js") return "dimmer";
    if (/flood|spot|wash/i.test(light.name)) return "flood";
    return "bulb";
  }

  function stateText(light) {
    if (!light.available) return light.state === "unavailable" ? "Unavailable" : "Unknown";
    if (light.state !== "on") return "Off";
    const a = light.look || {};
    const bits = ["On"];
    if (a.brightness) bits.push(`${Math.round((a.brightness / 255) * 100)}%`);
    if (a.color_mode === "color_temp" && a.color_temp_kelvin) bits.push(`${a.color_temp_kelvin} K`);
    if (a.effect && !/^(none|off)$/i.test(a.effect)) bits.push(a.effect);
    return bits.join(" · ");
  }

  // ---- lengths: stored in metres, shown and typed in the user's units ---------------------
  const FT = 0.3048, IN = 0.0254;
  // 'imperial' or 'metric': the user's choice in Settings, else what Home Assistant uses
  function units() {
    const pref = store("units", "auto");
    if (pref === "imperial" || pref === "metric") return pref;
    return (data.status && data.status.units) || "metric";
  }
  // 2.4 -> 7' 10" (imperial) or 2.40 m (metric)
  function fmtLen(m, { signed = false } = {}) {
    if (m === null || m === undefined || Number.isNaN(Number(m))) return "–";
    const v = Number(m);
    const sign = v < 0 ? "−" : signed && v > 0 ? "+" : "";
    if (units() === "metric") return `${sign}${Math.abs(v).toFixed(2)} m`;
    const total = Math.round(Math.abs(v) / IN);
    const ft = Math.floor(total / 12), inch = total % 12;
    return `${sign}${ft}' ${inch}"`;
  }
  // "8' 6\"", "8 ft 6 in", "102 in", "8.5'", "2.6 m", "260 cm", or a bare number in the user's
  // units (feet or metres) -> metres; NaN when it can't be read
  function parseLen(text) {
    const t = String(text ?? "").trim().toLowerCase().replace(/[′’]/g, "'").replace(/[″”“]/g, '"').replace(/−/g, "-").replace(",", ".");
    if (!t) return NaN;
    let m;
    if ((m = /^(-?\d+(?:\.\d+)?)\s*(m|meters?|metres?)$/.exec(t))) return Number(m[1]);
    if ((m = /^(-?\d+(?:\.\d+)?)\s*cm$/.exec(t))) return Number(m[1]) / 100;
    if ((m = /^(-?\d+(?:\.\d+)?)\s*("|in|inch|inches)$/.exec(t))) return Number(m[1]) * IN;
    if ((m = /^(-?)\s*(\d+(?:\.\d+)?)\s*('|ft|foot|feet)\s*(?:(\d+(?:\.\d+)?)\s*("|in|inch|inches)?)?$/.exec(t))) {
      const v = Number(m[2]) * FT + (m[4] ? Number(m[4]) * IN : 0);
      return m[1] === "-" ? -v : v;
    }
    if ((m = /^(-?\d+(?:\.\d+)?)$/.exec(t))) return Number(m[1]) * (units() === "imperial" ? FT : 1);
    return NaN;
  }
  // Snap a length to a whole inch (imperial) or 5 cm (metric)
  function snapLen(m) {
    return units() === "imperial" ? Math.round(m / IN) * IN : Math.round(m * 20) / 20;
  }

  // A palette colour's display hex: its own, or a colour temperature's approximate white
  function colorHex(c) {
    if (c.hex) return c.hex;
    if (!c.kelvin) return "#888888";
    const t = c.kelvin / 100;
    const r = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -0.1332);
    const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * Math.pow(t - 60, -0.0755);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
    const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  // replaceChildren() that skips null/false (optional sections) instead of printing "null"
  function set(node, ...kids) {
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  }

  window.L = {
    icon, el, api, toast, run, store, save, onData, refresh, data, typing, set, colorHex,
    units, fmtLen, parseLen, snapLen, FT, IN,
    INTEGRATION, DRIVER, lightIcon, stateText,
    setTitle(text) { document.getElementById("page-title").textContent = text; document.title = `${text} · Luminorium`; },
    topExtra() { return document.getElementById("top-extra"); },
    start(every = 3000) { refresh(true); setInterval(refresh, every); },
  };

  // The theme chosen in Settings (default: match the device)
  const theme = store("theme", "auto");
  if (theme !== "auto") document.documentElement.setAttribute("data-theme", theme);

  build();
  // Pages with their own script (Views, camera) don't call L.start(): keep the top bar current
  if (document.body.dataset.legacy) window.L.start(10000);
})();
