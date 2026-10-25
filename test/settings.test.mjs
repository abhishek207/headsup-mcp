import { DATA } from "./helpers.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SETTINGS = fileURLToPath(new URL("../settings.mjs", import.meta.url));
let port, child;

const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

// A raw request, so tests can send the headers a browser (or an attacker's page) would.
function http(method, path, { headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}
const post = (path, body, headers = {}) => http("POST", path, { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// Its own settings server on a spare port, in the test DATA folder; nothing plays, no keys.
before(async () => {
  port = await freePort();
  child = spawn(process.execPath, [SETTINGS], { env: { ...process.env, HEADS_UP_HOME: DATA, HEADS_UP_PORT: String(port), HEADS_UP_DISABLED: "1" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await http("GET", "/api/ping")).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("settings server didn't start");
});
after(() => child?.kill());

test("settings page: can't be framed, and runs only its own scripts", async () => {
  const r = await http("GET", "/", { headers: { "sec-fetch-site": "none" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  const csp = r.headers["content-security-policy"];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  const scripts = [...readFileSync(new URL("../settings.html", import.meta.url), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 2);
  for (const [, s] of scripts) assert.ok(csp.includes(`'sha256-${createHash("sha256").update(s).digest("base64")}'`), "every inline script is allowed by hash");
});

test("settings API: other hosts, origins, sites and form posts are refused", async () => {
  assert.equal((await http("GET", "/api/state", { headers: { host: "evil.example:4777" } })).status, 403, "DNS rebinding");
  assert.equal((await post("/api/config", { enabled: false }, { origin: "https://evil.example" })).status, 403, "cross-site fetch");
  assert.equal((await post("/api/config", { enabled: false }, { origin: "null" })).status, 403, "sandboxed frame");
  assert.equal((await http("POST", "/api/config", { headers: { "content-type": "text/plain" }, body: "{}" })).status, 415, "form post");
  assert.equal((await http("GET", "/api/clip?voice=american-male&id=completed", { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "embedded by another site");
  assert.equal((await http("GET", "/api/library?provider=sarvam", { headers: { "sec-fetch-site": "same-site" } })).status, 403);
  assert.equal((await http("GET", "/api/state", { headers: { "sec-fetch-site": "same-origin" } })).status, 200, "the page itself");
  assert.equal((await http("GET", "/api/ping")).status, 200, "the headsup command (no browser headers)");
});

test("settings API: bad bodies get a clear error, and the state never holds a key", async () => {
  assert.equal((await http("POST", "/api/config", { headers: { "content-type": "application/json" }, body: "{nope" })).status, 400);
  assert.equal((await post("/api/config", [1, 2])).status, 400);
  assert.equal((await post("/api/config", { pad: "x".repeat(200_000) })).status, 413);
  const s = await http("GET", "/api/state");
  assert.equal(s.status, 200);
  const state = JSON.parse(s.body);
  assert.deepEqual(state.keys, { elevenlabs: null, sarvam: null });
  assert.equal(state.config.project_names.enabled, false);
  assert.equal(state.config.live.enabled, false);
  // Without a key, the key-only features stay off whatever the page sends.
  const saved = JSON.parse((await post("/api/config", { ...state.config, project_names: { enabled: true }, live: { enabled: true } })).body);
  assert.equal(saved.config.project_names.enabled, false);
  assert.equal(saved.config.live.enabled, false);
});
