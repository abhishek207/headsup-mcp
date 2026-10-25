import { DATA } from "./helpers.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

// Send JSON-RPC lines to a fresh server and return its replies by id.
function rpc(...messages) {
  const r = spawnSync(process.execPath, [SERVER], {
    input: messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    encoding: "utf8",
    env: { ...process.env, HEADS_UP_HOME: DATA, HEADS_UP_DISABLED: "1" },
  });
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
}

test("MCP server: initialize, list, call", () => {
  const out = rpc(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "notify_user", arguments: { status: "completed" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "notify_user", arguments: { status: "dancing" } } },
    { jsonrpc: "2.0", id: 5, method: "nope" },
    { jsonrpc: "2.0", id: 6, method: "ping" },
  );
  assert.equal(out[1].result.serverInfo.name, "heads-up");
  const [tool] = out[2].result.tools;
  assert.equal(tool.name, "notify_user");
  assert.equal(tool.inputSchema.properties.status.enum.length, 20);
  assert.match(tool.inputSchema.properties.message.description, /no code, paths, links or secrets/);
  assert.match(out[3].result.content[0].text, /^Not played: disabled by HEADS_UP_DISABLED=1\. .*don't retry/);
  assert.equal(out[4].result.isError, true);
  assert.equal(out[5].error.code, -32601);
  assert.deepEqual(out[6].result, {});
});

test("MCP server: bad JSON gets a parse error, not a crash", () => {
  const r = spawnSync(process.execPath, [SERVER], { input: "{oops\n", encoding: "utf8", env: { ...process.env, HEADS_UP_HOME: DATA } });
  assert.equal(JSON.parse(r.stdout).error.code, -32700);
});

test("MCP server: started in its own folder (Codex), it names the session's project from PWD", () => {
  const project = join(DATA, "brand-bakery");
  mkdirSync(project, { recursive: true });
  spawnSync(process.execPath, [SERVER], {
    cwd: dirname(SERVER),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notify_user", arguments: { status: "review" } } }) + "\n",
    encoding: "utf8",
    env: { ...process.env, HEADS_UP_HOME: DATA, HEADS_UP_DISABLED: "1", PWD: project },
  });
  const [last] = JSON.parse(readFileSync(join(DATA, "state.json"), "utf8")).history;
  assert.equal(last.project, "brand-bakery");
});

test("MCP server: started in its own folder with no other clue, it names no project", () => {
  writeFileSync(join(DATA, "state.json"), JSON.stringify({ history: [] }));
  spawnSync(process.execPath, [SERVER], {
    cwd: dirname(SERVER),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notify_user", arguments: { status: "review" } } }) + "\n",
    encoding: "utf8",
    env: { ...process.env, HEADS_UP_HOME: DATA, HEADS_UP_DISABLED: "1", PWD: dirname(SERVER) + "/." },
  });
  const [last] = JSON.parse(readFileSync(join(DATA, "state.json"), "utf8")).history;
  assert.equal(last.project ?? null, null);
});
