// Alerts name the chat they come from, using the title the user sees.
import { quiet, DATA } from "./helpers.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const { sessionTitle, alert, loadHistory, saveConfig, normalize } = await import("../core.mjs");
const { claudeAppData } = await import("../paths.mjs");

const home = join(DATA, "home");
const app = join(claudeAppData(process.platform, {}, home), "claude-code-sessions", "acct-0001", "org-00001");
mkdirSync(app, { recursive: true });
const session = (host, body) => writeFileSync(join(app, `${host}.json`), JSON.stringify(body));
session("local_aaaa1111", { cliSessionId: "cli-aaaa1111", title: "Fix Brivi Chrome and Safari extensions" });
session("local_bbbb2222", { cliSessionId: "cli-bbbb2222", title: "Remote Control session (from a project)" });
const env = (host, cli) => ({ CLAUDE_CODE_HOST_SESSION_ID: host, CLAUDE_CODE_SESSION_ID: cli, CLAUDE_CODE_ACCOUNT_UUID: "acct-0001", CLAUDE_CODE_ORGANIZATION_UUID: "org-00001" });

test("the Claude app's title for this session", () => {
  assert.equal(sessionTitle(env("local_aaaa1111", "cli-aaaa1111"), undefined, home), "Fix Brivi Chrome and Safari extensions");
  // Found without the account folders in the environment too.
  assert.equal(sessionTitle({ CLAUDE_CODE_HOST_SESSION_ID: "local_aaaa1111", CLAUDE_CODE_SESSION_ID: "cli-aaaa1111" }, undefined, home), "Fix Brivi Chrome and Safari extensions");
});

test("no title for a run started inside another session, a generic title, or a bad id", () => {
  assert.equal(sessionTitle(env("local_aaaa1111", "cli-other999"), undefined, home), null);
  assert.equal(sessionTitle(env("local_bbbb2222", "cli-bbbb2222"), undefined, home), null);
  assert.equal(sessionTitle(env("../../etc/passwd", "cli-aaaa1111"), undefined, home), null);
  assert.equal(sessionTitle({}, undefined, home), null);
});

test("a Claude Code /rename title from the transcript", () => {
  const dir = join(home, ".claude", "projects", "-Users-me-Dev-Kosh");
  mkdirSync(dir, { recursive: true });
  const lines = [{ type: "user", message: "hi" }, { type: "custom-title", customTitle: "Old name" }, { type: "custom-title", customTitle: "Ship the inbox" }];
  writeFileSync(join(dir, "cli-cccc3333.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(sessionTitle({ CLAUDE_CODE_SESSION_ID: "cli-cccc3333" }, undefined, home), "Ship the inbox");
});

test("the title opens the line, once", () => {
  // Switched off, so nothing plays; the log still shows the line that would have been said.
  saveConfig(normalize({ ...quiet, enabled: false }));
  const said = (opts) => (alert("review", { source: "test", ...opts }), loadHistory()[0]);
  const t = "Fix Brivi Chrome and Safari extensions";
  let h = said({ title: t, message: "I need your review of the Safari build." });
  assert.equal(h.message, `Thread: ${t}. I need your review of the Safari build.`);
  assert.equal(h.thread, t);
  h = said({ title: t, message: `In ${t}, I need your review.` });
  assert.equal(h.message, `In ${t}, I need your review.`);
  // A built-in clip in a paid or shipped voice isn't re-recorded just to add the title.
  h = said({ title: t });
  assert.equal(h.message, undefined);
});
