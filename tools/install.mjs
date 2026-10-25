#!/usr/bin/env node
// One-command setup for heads-up on this Mac. Safe to run again after an update.
//   headsup install              install or update
//   headsup install --dry-run    show what would change, change nothing
//   headsup uninstall            take it all out again (keeps your settings and recordings)
//   npx headsup-mcp install      the same, without a checkout
//
// Heads-up ships as a plugin for Claude Code and Codex (MCP server, skill and hooks in one).
// This script:
//   1. checks Node and ffmpeg (ffmpeg is only needed to record new lines)
//   2. builds the call detector into DATA/bin (needs Xcode command line tools)
//   3. Claude Code: adds the heads-up marketplace and installs the plugin, allows its
//      notify_user tool, and removes the pre-plugin setup (MCP entry, hooks, CLAUDE.md section)
//   4. Codex: adds the marketplace and says how to finish in Codex
//   5. writes the headsup command to ~/.local/bin
// Anything it can't do is printed with the command to do it by hand.
//
// Where the plugin comes from: --source <path|owner/repo>, else this checkout, else GitHub.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA, ROOT, rememberRoot } from "../paths.mjs";

export const MARKETPLACE = "heads-up";
export const PLUGIN = `heads-up@${MARKETPLACE}`;
export const GITHUB = "abhishek207/headsup-mcp";
// Plugin MCP tools are named mcp__plugin_<plugin>_<server>__<tool>.
export const TOOL_RULE = "mcp__plugin_heads-up_heads-up__notify_user";
// The rule from the pre-plugin setup, removed on install.
export const OLD_TOOL_RULE = "mcp__heads-up__notify_user";
// Hook commands from any pre-plugin copy of heads-up, including its old names.
const OURS = /(heads-?up|headsup-mcp|status-voice|claude-voice)[^"]*\/hook\.mjs/;
const START = "<!-- heads-up:start -->";
const END = "<!-- heads-up:end -->";
const SHIM_MARK = "# heads-up command";

// settings.json with the plugin's tool allowed and the pre-plugin setup taken out.
export function withHeadsUp(settings) {
  const s = withoutHeadsUp(settings);
  s.permissions ??= {};
  s.permissions.allow = [...new Set([...(s.permissions.allow ?? []), TOOL_RULE])];
  return s;
}

// settings.json with every heads-up hook and allow rule taken out; everything else kept.
export function withoutHeadsUp(settings) {
  const s = structuredClone(settings ?? {});
  if (s.permissions?.allow) s.permissions.allow = s.permissions.allow.filter((r) => r !== TOOL_RULE && r !== OLD_TOOL_RULE);
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !OURS.test(h.command ?? "")) }))
      .filter((g) => g.hooks.length);
    if (kept.length) s.hooks[event] = kept;
    else delete s.hooks[event];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

// CLAUDE.md without the section the pre-plugin installer wrote (the plugin's skill replaces it).
export const withoutSection = (text) => text.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`), "\n").replace(/^\n+/, "");

// The headsup command: runs whichever copy of heads-up ran last (DATA/root), else `fallback`.
export const shim = (node, fallback) => `#!/bin/sh
${SHIM_MARK}: runs the installed copy of heads-up (its path is kept in DATA/root).
data="\${HEADS_UP_HOME:-$HOME/Library/Application Support/heads-up}"
root=$(cat "$data/root" 2>/dev/null)
[ -f "$root/cli.mjs" ] || root=${quote(fallback)}
node=${quote(node)}
[ -x "$node" ] || node=node
exec "$node" "$root/cli.mjs" "$@"
`;

// Where Claude Code installed the plugin, from its installed_plugins.json, or null.
export function pluginPath(claudeDir) {
  try {
    const all = JSON.parse(readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8"));
    const entry = (all.plugins ?? all)[PLUGIN];
    return [entry].flat().find((e) => e?.installPath)?.installPath ?? null;
  } catch {
    return null;
  }
}

const quote = (p) => (/[\s"'$`\\]/.test(p) ? `"${p.replace(/(["$`\\])/g, "\\$1")}"` : p);
const has = (cmd) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const why = (r) => (r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n").slice(-1)[0];

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");
  const at = args.indexOf("--source");
  const source = (at >= 0 && args[at + 1]) || process.env.HEADS_UP_SOURCE || (existsSync(join(ROOT, ".git")) ? ROOT : GITHUB);
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const settingsFile = join(claudeDir, "settings.json");
  const mdFile = join(claudeDir, "CLAUDE.md");
  const link = join(homedir(), ".local", "bin", "headsup");
  const helper = join(DATA, "bin", "media-in-use");
  const todo = [];
  const say = (mark, msg) => console.log(`${mark} ${msg}`);
  const act = (msg, fn) => {
    if (dry) return say("•", `would ${msg}`);
    try {
      fn();
      say("✓", msg[0].toUpperCase() + msg.slice(1));
    } catch (e) {
      say("✗", `Couldn't ${msg}: ${e.message}`);
    }
  };
  // Runs a CLI step; a failure is reported with the command to run by hand.
  const step = (msg, cmd, cmdArgs, ok = () => false) =>
    act(msg, () => {
      const r = run(cmd, cmdArgs);
      if (r.status !== 0 && !ok(r)) throw new Error(`${why(r)}\n  Run it yourself: ${[cmd, ...cmdArgs].map(quote).join(" ")}`);
    });
  const already = (r) => /already/i.test(`${r.stdout}${r.stderr}`);

  if (process.platform !== "darwin") say("!", "Heads-up plays audio with macOS tools; on this system only the setup is done.");
  if (Number(process.versions.node.split(".")[0]) < 20) {
    say("✗", `Node ${process.versions.node} is too old; heads-up needs Node 20 or newer.`);
    process.exit(1);
  }

  const editSettings = (fn, msg) => {
    let current = {};
    if (existsSync(settingsFile)) {
      try {
        current = JSON.parse(readFileSync(settingsFile, "utf8"));
      } catch {
        return say("✗", `${settingsFile} isn't valid JSON; fix it, then run this again.`);
      }
    }
    const next = fn(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return say("✓", `${msg[0].toUpperCase()}${msg.slice(1)}: already done`);
    act(msg, () => {
      mkdirSync(claudeDir, { recursive: true });
      if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.heads-up-backup`);
      writeFileSync(settingsFile, JSON.stringify(next, null, 2) + "\n");
    });
  };
  const removeOldSection = () => {
    const current = existsSync(mdFile) ? readFileSync(mdFile, "utf8") : "";
    if (current.includes(START)) act("remove the old heads-up section from ~/.claude/CLAUDE.md (the plugin's skill replaces it)", () => writeFileSync(mdFile, withoutSection(current)));
  };
  const ourShim = () => {
    const l = lstatSync(link, { throwIfNoEntry: false });
    if (!l) return false;
    if (l.isSymbolicLink()) return /(heads-?up|headsup-mcp)[^"]*\/cli\.mjs$/.test(readlinkSync(link)); // pre-plugin link
    return readFileSync(link, "utf8").includes(SHIM_MARK);
  };
  const claude = has("claude");
  const codex = has("codex");

  if (uninstall) {
    if (claude) {
      step("uninstall the heads-up plugin from Claude Code", "claude", ["plugin", "uninstall", PLUGIN], (r) => /not installed|not found/i.test(why(r)));
      step("remove the heads-up marketplace from Claude Code", "claude", ["plugin", "marketplace", "remove", MARKETPLACE], (r) => /not found/i.test(why(r)));
      run("claude", ["mcp", "remove", "heads-up", "-s", "user"]);
    }
    if (codex) step("remove the heads-up marketplace from Codex", "codex", ["plugin", "marketplace", "remove", MARKETPLACE], (r) => /not found/i.test(why(r)));
    editSettings(withoutHeadsUp, "remove heads-up's allow rule and any old hooks from ~/.claude/settings.json");
    removeOldSection();
    if (ourShim()) act("remove ~/.local/bin/headsup", () => rmSync(link));
    console.log(`\nYour settings and recordings are still in ${DATA}. Delete that folder to remove them too.`);
    return;
  }

  // 1. Tools
  say(has("ffmpeg") ? "✓" : "!", has("ffmpeg") ? "ffmpeg found" : "ffmpeg is missing. The built-in alerts work without it; spoken project names and the agent's own lines need it: brew install ffmpeg");

  // 2. Call detector
  if (has("swiftc")) {
    act("build the call detector", () => {
      mkdirSync(join(DATA, "bin"), { recursive: true });
      execFileSync("swiftc", ["-O", join(ROOT, "tools", "media-in-use.swift"), "-o", helper], { stdio: "pipe" });
    });
  } else {
    say("!", existsSync(helper) ? "swiftc not found; keeping the call detector that's already built" : "swiftc not found, so call detection stays off. Install Xcode's command line tools (xcode-select --install), then run this again.");
  }

  // 3. Claude Code
  say("•", `Plugin source: ${source}`);
  if (claude) {
    if (run("claude", ["mcp", "get", "heads-up"]).status === 0) step("remove the pre-plugin heads-up MCP server from Claude Code", "claude", ["mcp", "remove", "heads-up", "-s", "user"]);
    step("add the heads-up marketplace to Claude Code", "claude", ["plugin", "marketplace", "add", source], already);
    step("refresh the heads-up marketplace", "claude", ["plugin", "marketplace", "update", MARKETPLACE]);
    step("install the heads-up plugin in Claude Code", "claude", ["plugin", "install", PLUGIN], already);
    step("update the heads-up plugin to the latest version", "claude", ["plugin", "update", PLUGIN], already);
    editSettings(withHeadsUp, "allow heads-up's notify_user tool in ~/.claude/settings.json (and drop pre-plugin hooks)");
    removeOldSection();
  } else {
    todo.push(`claude plugin marketplace add ${quote(source)}`, `claude plugin install ${PLUGIN}`);
  }

  // 4. Codex
  if (codex) {
    step("add the heads-up marketplace to Codex", "codex", ["plugin", "marketplace", "add", source], already);
    say("!", "In Codex: open /plugins and install Heads-up, then open /hooks and trust its three hooks (Codex asks before running any plugin hook).");
  }

  // 5. Command
  const installed = claude ? pluginPath(claudeDir) : null;
  if (!dry) rememberRoot(installed ?? ROOT);
  const l = lstatSync(link, { throwIfNoEntry: false });
  if (l && !ourShim()) say("!", `${link} exists and isn't heads-up's; left alone.`);
  else
    act("write the headsup command to ~/.local/bin", () => {
      mkdirSync(join(homedir(), ".local", "bin"), { recursive: true });
      if (l) rmSync(link);
      writeFileSync(link, shim(process.execPath, installed ?? ROOT));
      chmodSync(link, 0o755);
    });
  if (!(process.env.PATH ?? "").split(":").includes(join(homedir(), ".local", "bin"))) say("!", `~/.local/bin isn't on your PATH. Add it in ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"`);

  if (dry) console.log("\nDry run: nothing was changed.");
  else {
    console.log("\nDone. Restart open Claude Code sessions so they load the plugin, then run headsup to open the settings page.");
    console.log("Out of the box, heads-up plays its built-in lines. To hear project names or the agent's own words, add your ElevenLabs or Sarvam key on that page.");
  }
  if (todo.length) console.log(`\nClaude Code's command wasn't found. Run these yourself:\n  ${todo.join("\n  ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
