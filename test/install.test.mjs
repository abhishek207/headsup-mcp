import { DATA } from "./helpers.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const { withHeadsUp, withoutHeadsUp, withoutSection, shim, pluginPath, quote, TOOL_RULE, OLD_TOOL_RULE, PLUGIN } = await import("../tools/install.mjs");

// A settings.json with a pre-plugin heads-up setup mixed in with the user's own things.
const theirs = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)", OLD_TOOL_RULE] },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "node /Users/me/Dev/headsup-mcp/hook.mjs", async: true }, { type: "command", command: "other.sh" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /Users/me/Dev/headsup-mcp/hook.mjs", async: true }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
  },
};

test("installer: allows the plugin's tool and removes the pre-plugin hooks, keeping the user's own", () => {
  const s = withHeadsUp(theirs);
  assert.equal(s.model, "opus");
  assert.deepEqual(s.permissions.allow, ["Bash(ls:*)", TOOL_RULE]);
  assert.deepEqual(s.hooks.PreToolUse, theirs.hooks.PreToolUse);
  assert.deepEqual(s.hooks.Stop, [{ hooks: [{ type: "command", command: "other.sh" }] }]);
  assert.equal(s.hooks.UserPromptSubmit, undefined, "the plugin brings its own hooks; old ones would double every alert");
  assert.deepEqual(withHeadsUp(s), s, "running it twice changes nothing");
});

test("installer: uninstall leaves only the user's own settings", () => {
  const s = withoutHeadsUp(withHeadsUp(theirs));
  assert.deepEqual(s.permissions.allow, ["Bash(ls:*)"]);
  assert.deepEqual(Object.keys(s.hooks).sort(), ["PreToolUse", "Stop"]);
  assert.deepEqual(withoutHeadsUp({ hooks: { Stop: theirs.hooks.UserPromptSubmit } }), {}, "an emptied hooks block goes away");
});

test("installer: the old CLAUDE.md section comes out, the rest stays", () => {
  const md = "# Mine\n\n<!-- heads-up:start -->\n## Voice alerts\nCall notify_user.\n<!-- heads-up:end -->\n";
  assert.equal(withoutSection(md), "# Mine\n");
  assert.equal(withoutSection("Call notify_user when done."), "Call notify_user when done.");
});

test("installer: finds where Claude Code installed the plugin", () => {
  const dir = join(DATA, "claude-config");
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [PLUGIN]: [{ scope: "user", installPath: "/x/cache/heads-up/heads-up/1.5.0" }] } }));
  assert.equal(pluginPath(dir), "/x/cache/heads-up/heads-up/1.5.0");
  assert.equal(pluginPath(join(DATA, "nowhere")), null);
});

test("installer: the headsup command runs the copy recorded in DATA/root", () => {
  const app = join(DATA, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "cli.mjs"), "console.log('ran ' + process.argv.slice(2).join(' '))");
  writeFileSync(join(DATA, "root"), app);
  const file = join(DATA, "headsup");
  writeFileSync(file, shim(process.execPath, "/nowhere"));
  chmodSync(file, 0o755);
  const r = spawnSync(file, ["status"], { encoding: "utf8", env: { ...process.env, HEADS_UP_HOME: DATA } });
  assert.equal(r.stdout.trim(), "ran status");
  assert.match(readFileSync(file, "utf8"), /^#!\/bin\/sh/);
});

test("installer: odd install paths stay plain text in the headsup command", () => {
  for (const p of ["/x/a;touch pwned", "/x/$(touch pwned)", "/x/it's here", "/x/`touch pwned`"]) {
    const r = spawnSync("/bin/sh", ["-c", `v=${quote(p)}; printf '%s' "$v"`], { encoding: "utf8", cwd: DATA });
    assert.equal(r.stdout, p);
  }
  assert.equal(existsSync(join(DATA, "pwned")), false);
  assert.equal(quote("/usr/local/bin/node"), "/usr/local/bin/node");
});
