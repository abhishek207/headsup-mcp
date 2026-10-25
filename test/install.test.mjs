import "./helpers.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { withHeadsUp, withoutHeadsUp, withSection, withoutSection, TOOL_RULE, CLAUDE_MD } = await import("../tools/install.mjs");

const theirs = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "node /Users/me/Dev/headsup-mcp/hook.mjs", async: true }, { type: "command", command: "other.sh" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
  },
};

test("installer: adds hooks and the allow rule, replacing old copies, keeping the user's own", () => {
  const s = withHeadsUp(theirs, "/usr/bin/node /x/headsup-mcp/hook.mjs");
  assert.equal(s.model, "opus");
  assert.deepEqual(s.permissions.allow, ["Bash(ls:*)", TOOL_RULE]);
  assert.deepEqual(s.hooks.PreToolUse, theirs.hooks.PreToolUse);
  const commands = (e) => s.hooks[e].flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(commands("Stop"), ["other.sh", "/usr/bin/node /x/headsup-mcp/hook.mjs"], "the old heads-up hook is replaced, not doubled");
  assert.equal(commands("UserPromptSubmit").length, 1);
  assert.match(s.hooks.Notification[0].matcher, /permission_prompt/);
  assert.deepEqual(withHeadsUp(s, "/usr/bin/node /x/headsup-mcp/hook.mjs"), s, "running it twice changes nothing");
});

test("installer: uninstall leaves only the user's own settings", () => {
  const s = withoutHeadsUp(withHeadsUp(theirs, "node /x/heads-up/hook.mjs"));
  assert.deepEqual(s.permissions.allow, ["Bash(ls:*)"]);
  assert.deepEqual(Object.keys(s.hooks).sort(), ["PreToolUse", "Stop"]);
  assert.deepEqual(s.hooks.Stop, [{ hooks: [{ type: "command", command: "other.sh" }] }]);
});

test("installer: CLAUDE.md section is added once and respects the user's own", () => {
  const added = withSection("# Mine\n");
  assert.equal(added, `# Mine\n\n${CLAUDE_MD}\n`);
  assert.equal(withSection(added), added);
  assert.equal(withSection("Call notify_user when done."), "Call notify_user when done.", "an existing notify_user section is left alone");
  assert.equal(withoutSection(added), "# Mine\n");
});
