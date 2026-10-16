// Read-only capture of HA registries, states and Z-Wave node details for tools/make_fixtures.py.
// Usage: node tools/capture_ha.mjs OUT_DIR
// The token is read from the Sonorium token file and never printed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) { console.error("usage: node tools/capture_ha.mjs OUT_DIR"); process.exit(1); }
mkdirSync(out, { recursive: true });
const token = readFileSync("F:/Projects/Sonorium/ha.tok.txt", "utf8").trim();
const ws = new WebSocket("ws://192.168.1.104:8123/api/websocket");
let nextId = 1;
const waiting = new Map();
const send = (cmd) => new Promise((resolve, reject) => {
  const id = nextId++;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, ...cmd }));
});
setTimeout(() => { console.error("timeout"); process.exit(2); }, 180000);

async function capture() {
  const lists = { floor: "config/floor_registry/list", area: "config/area_registry/list",
    device: "config/device_registry/list", entity: "config/entity_registry/list" };
  const data = {};
  for (const [name, type] of Object.entries(lists)) data[name] = await send({ type });
  data.states = await send({ type: "get_states" });
  const zwave = {};
  for (const d of data.device) {
    if (!d.identifiers.some(([domain]) => domain === "zwave_js") || !d.model) continue;
    try {
      zwave[d.id] = {
        status: await send({ type: "zwave_js/node_status", device_id: d.id }),
        capabilities: await send({ type: "zwave_js/node_capabilities", device_id: d.id }),
      };
    } catch (e) { console.error("zwave", d.id, e.message); }
  }
  data.zwave = zwave;
  for (const [name, value] of Object.entries(data)) writeFileSync(`${out}/${name}.json`, JSON.stringify(value));
  console.log("captured", Object.keys(data).join(", "));
  process.exit(0);
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
  else if (msg.type === "auth_ok") capture().catch((e) => { console.error(e.message); process.exit(1); });
  else if (msg.type === "auth_invalid") { console.error("auth failed"); process.exit(1); }
  else if (waiting.has(msg.id)) {
    const w = waiting.get(msg.id); waiting.delete(msg.id);
    msg.success ? w.resolve(msg.result) : w.reject(new Error(msg.error?.message || "error"));
  }
};
