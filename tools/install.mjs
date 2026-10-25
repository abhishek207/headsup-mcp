#!/usr/bin/env node
// One-command setup for heads-up on this Mac. Safe to run again after an update.
//   node tools/install.mjs              install or update
//   node tools/install.mjs --dry-run    show what would change, change nothing
//   node tools/install.mjs --uninstall  take it all out again (keeps your settings and recordings)
//
// What it does:
//   1. checks Node and ffmpeg (ffmpeg is only needed to record new lines)
//   2. builds bin/media-in-use, the call detector (needs Xcode command line tools)
//   3. registers the MCP server with Claude Code (user scope), with this Node's full path
//   4. adds the allow rule and the three hooks to ~/.claude/settings.json (backed up first)
//   5. links the headsup command into ~/.local/bin
//   6. adds a short "when to call notify_user" section to ~/.claude/CLAUDE.md
// Anything it can't do is printed with the command to do it by hand.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA, ROOT } from "../paths.mjs";

export const TOOL_RULE = "mcp__heads-up__notify_user";
export const NOTIFY_MATCHER = "permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input";
// Hook commands from any copy of heads-up, including its old names, so updates replace them.
const OURS = /(heads-?up|headsup-mcp|status-voice|claude-voice)[^"]*\/hook\.mjs/;
const START = "<!-- heads-up:start -->";
const END = "<!-- heads-up:end -->";

export const CLAUDE_MD = `${START}
## Voice alerts (Heads-up)

Call the \`notify_user\` tool (heads-up MCP) once at the end of a turn where the user has to come back: you need a review, input, an approval or an answer, a long task finished, or something failed. Also call it when you start something long they can walk away from (\`long_task\`). Pick the status that fits. When the fixed line doesn't say enough, add a short \`message\` in first person, for example "The migration ran, but two tables need your review." Keep messages to one or two plain sentences with no code, paths, links or secrets. Don't call it for quick back-and-forth replies. If it answers "Not played", that's the user's setting: don't retry.
${END}`;

// The heads-up parts of Claude Code's settings.json, added to whatever is there already.
export function withHeadsUp(settings, hookCommand) {
  const s = withoutHeadsUp(settings);
  s.permissions ??= {};
  s.permissions.allow = [...new Set([...(s.permissions.allow ?? []), TOOL_RULE])];
  s.hooks ??= {};
  const hook = { type: "command", command: hookCommand, async: true, timeout: 15 };
  for (const [event, matcher] of [["UserPromptSubmit"], ["Notification", NOTIFY_MATCHER], ["Stop"]]) {
    s.hooks[event] = [...(s.hooks[event] ?? []), { ...(matcher && { matcher }), hooks: [hook] }];
  }
  return s;
}

// settings.json with every heads-up hook and the allow rule taken out; everything else kept.
export function withoutHeadsUp(settings) {
  const s = structuredClone(settings ?? {});
  if (s.permissions?.allow) s.permissions.allow = s.permissions.allow.filter((r) => r !== TOOL_RULE);
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !OURS.test(h.command ?? "")) }))
      .filter((g) => g.hooks.length);
    if (kept.length) s.hooks[event] = kept;
    else delete s.hooks[event];
  }
  return s;
}

// CLAUDE.md with our section added or refreshed. Left alone if the user already wrote their own.
export function withSection(text) {
  if (text.includes(START)) return text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), CLAUDE_MD);
  if (/notify_user/.test(text)) return text;
  return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${CLAUDE_MD}\n`;
}

export const withoutSection = (text) => text.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`), "\n").replace(/^\n+/, "");

const quote = (p) => (/[\s"'$`\\]/.test(p) ? `"${p.replace(/(["$`\\])/g, "\\$1")}"` : p);
const has = (cmd) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const settingsFile = join(claudeDir, "settings.json");
  const mdFile = join(claudeDir, "CLAUDE.md");
  const binDir = join(homedir(), ".local", "bin");
  const link = join(binDir, "headsup");
  const node = process.execPath;
  const hookCommand = `${quote(node)} ${quote(join(ROOT, "hook.mjs"))}`;
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

  if (process.platform !== "darwin") say("!", "Heads-up plays audio with macOS tools; on this system only the setup files are written.");
  if (Number(process.versions.node.split(".")[0]) < 20) {
    say("✗", `Node ${process.versions.node} is too old; heads-up needs Node 20 or newer.`);
    process.exit(1);
  }

  // Settings file edits are shared by install and uninstall.
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
  const editMd = (fn, msg) => {
    const current = existsSync(mdFile) ? readFileSync(mdFile, "utf8") : "";
    const next = fn(current);
    if (next === current) return say("✓", `${msg[0].toUpperCase()}${msg.slice(1)}: nothing to change${!uninstall && !current.includes(START) && current.includes("notify_user") ? " (you already have your own notify_user section)" : ""}`);
    act(msg, () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(mdFile, next);
    });
  };
  const claude = has("claude");

  if (uninstall) {
    if (claude) act("remove the heads-up MCP server from Claude Code", () => spawnSync("claude", ["mcp", "remove", "heads-up", "-s", "user"], { stdio: "ignore" }));
    else todo.push("claude mcp remove heads-up -s user");
    editSettings(withoutHeadsUp, "remove heads-up hooks and the allow rule from ~/.claude/settings.json");
    editMd(withoutSection, "remove the heads-up section from ~/.claude/CLAUDE.md");
    if (existsSync(link) && lstatSync(link).isSymbolicLink() && readlinkSync(link) === join(ROOT, "cli.mjs")) act("remove ~/.local/bin/headsup", () => rmSync(link));
    console.log(`\nYour settings and recordings are still in ${DATA}. Delete that folder to remove them too.`);
  } else {
    // 1. Tools
    say(has("ffmpeg") ? "✓" : "!", has("ffmpeg") ? "ffmpeg found" : "ffmpeg is missing. Built-in alerts work without it; recording project names, your wording and Claude's own lines needs it: brew install ffmpeg");

    // 2. Call detector
    const helper = join(ROOT, "bin", "media-in-use");
    if (has("swiftc")) {
      act("build the call detector (bin/media-in-use)", () => {
        mkdirSync(join(ROOT, "bin"), { recursive: true });
        execFileSync("swiftc", ["-O", join(ROOT, "tools", "media-in-use.swift"), "-o", helper], { stdio: "pipe" });
      });
    } else {
      say("!", existsSync(helper) ? "swiftc not found; keeping the call detector that's already built" : "swiftc not found, so call detection stays off. Install Xcode's command line tools (xcode-select --install), then run this again.");
    }

    // 3. MCP server
    if (claude) {
      act("register the heads-up MCP server with Claude Code", () => {
        spawnSync("claude", ["mcp", "remove", "heads-up", "-s", "user"], { stdio: "ignore" });
        execFileSync("claude", ["mcp", "add", "--scope", "user", "heads-up", "--", node, join(ROOT, "server.mjs")], { stdio: "pipe" });
      });
    } else {
      todo.push(`claude mcp add --scope user heads-up -- ${quote(node)} ${quote(join(ROOT, "server.mjs"))}`);
    }

    // 4. Allow rule and hooks
    editSettings((s) => withHeadsUp(s, hookCommand), "add the allow rule and hooks to ~/.claude/settings.json");

    // 5. Command
    const target = join(ROOT, "cli.mjs");
    const current = lstatSync(link, { throwIfNoEntry: false }) ?? null;
    if (current && !current.isSymbolicLink()) say("!", `${link} exists and isn't a link; left alone.`);
    else if (current && readlinkSync(link) === target) say("✓", "headsup command: already linked");
    else
      act("link the headsup command into ~/.local/bin", () => {
        mkdirSync(binDir, { recursive: true });
        if (current) rmSync(link);
        chmodSync(target, 0o755);
        symlinkSync(target, link);
      });
    if (!(process.env.PATH ?? "").split(":").includes(binDir)) say("!", `${binDir} isn't on your PATH. Add it in ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"`);

    // 6. Instructions for Claude
    editMd(withSection, "add the heads-up section to ~/.claude/CLAUDE.md");

    if (dry) console.log("\nDry run: nothing was changed.");
    else {
      console.log("\nDone. Restart any open Claude Code sessions so they load heads-up, then run headsup to open the settings page.");
      console.log("To record project names, your own wording, other voices or Claude's own lines, add your ElevenLabs or Sarvam key there.");
    }
  }
  if (todo.length) console.log(`\nClaude Code's command wasn't found. Run this yourself:\n  ${todo.join("\n  ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
