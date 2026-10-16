// Usage: node ha_sup.mjs METHOD ENDPOINT [JSON_DATA] [TIMEOUT_S]
// Calls the HA Supervisor API through the HA websocket ("supervisor/api").
// The token is read from the Sonorium token file and never printed.
import { readFileSync } from "node:fs";

const [method, endpoint, data, timeoutS] = process.argv.slice(2);
const token = readFileSync("F:/Projects/Sonorium/ha.tok.txt", "utf8").trim();
const ws = new WebSocket("ws://192.168.1.104:8123/api/websocket");
const timer = setTimeout(() => { console.error("timeout"); process.exit(2); }, (Number(timeoutS) || 60) * 1000);

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "auth_required") {
    ws.send(JSON.stringify({ type: "auth", access_token: token }));
  } else if (msg.type === "auth_ok") {
    const req = method === "ws" ? { id: 1, ...JSON.parse(endpoint) } : { id: 1, type: "supervisor/api", endpoint, method };
    if (data) req.data = JSON.parse(data);
    if (timeoutS) req.timeout = Number(timeoutS);
    ws.send(JSON.stringify(req));
  } else if (msg.type === "auth_invalid") {
    console.error("auth failed"); process.exit(1);
  } else if (msg.id === 1) {
    clearTimeout(timer);
    console.log(JSON.stringify(msg.success ? msg.result : msg.error, null, 1));
    ws.close();
    process.exit(msg.success ? 0 : 1);
  }
};
