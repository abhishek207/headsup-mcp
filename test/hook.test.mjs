import { DATA } from "./helpers.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";

const HOOK = fileURLToPath(new URL("../hook.mjs", import.meta.url));
const read = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(join(DATA, f), "utf8"));
  } catch {
    return fallback;
  }
};

function hook(event, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: "test-session", cwd: DATA, ...event }),
    encoding: "utf8",
    env: { ...process.env, HEADS_UP_HOME: DATA, HEADS_UP_DISABLED: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1", ...env },
  });
}

// The hook plays from a detached child; wait for it to record the alert.
async function nextAlert(before) {
  for (let i = 0; i < 50; i++) {
    const h = read("state.json", { history: [] }).history;
    if (h.length > before) return h[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("no alert recorded");
}

const historyLength = () => read("state.json", { history: [] }).history.length;
const startTurn = (secsAgo) => writeFileSync(join(DATA, "turns.json"), JSON.stringify({ "test-session": new Date(Date.now() - secsAgo * 1000).toISOString() }));

beforeEach(() => rmSync(join(DATA, "turns.json"), { force: true }));

test("hook: background sessions are ignored", () => {
  hook({ hook_event_name: "UserPromptSubmit" }, { CLAUDE_CODE_SESSION_ATTENDED: "0" });
  assert.deepEqual(read("turns.json", {}), {});
  assert.match(readFileSync(join(DATA, "hook.log"), "utf8"), /ignored: background session/);
});

test("hook: prompt submit records the turn start", () => {
  hook({ hook_event_name: "UserPromptSubmit" });
  assert.ok(read("turns.json", {})["test-session"]);
});

test("hook: short turns stay quiet", () => {
  startTurn(10);
  const before = historyLength();
  hook({ hook_event_name: "Stop" });
  assert.equal(historyLength(), before);
  assert.deepEqual(read("turns.json", {}), {});
});

test("hook: a long turn alerts completed, or input when it ends with a question", async () => {
  startTurn(600);
  let before = historyLength();
  hook({ hook_event_name: "Stop", last_assistant_message: "All done." });
  let a = await nextAlert(before);
  assert.equal(a.status, "completed");
  assert.equal(a.source, "hook:Stop");

  startTurn(600);
  before = historyLength();
  hook({ hook_event_name: "Stop", last_assistant_message: "Which one do you want?" });
  a = await nextAlert(before);
  assert.equal(a.status, "input");
});

test("hook: permission prompt alerts approval", async () => {
  const before = historyLength();
  hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" });
  assert.equal((await nextAlert(before)).status, "approval");
});

test("hook: Codex's approval request alerts approval and leaves the decision to Codex", async () => {
  const before = historyLength();
  const r = hook({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
  assert.equal(r.stdout, "", "no decision printed, so Codex still asks the user");
  const a = await nextAlert(before);
  assert.equal(a.status, "approval");
  assert.equal(a.source, "hook:PermissionRequest");
});
