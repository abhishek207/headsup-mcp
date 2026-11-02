#!/usr/bin/env node
// One-command setup for heads-up on this computer (macOS, Linux or Windows). Safe to run
// again after an update.
//   headsup install              install or update
//   headsup install --dry-run    show what would change, change nothing
//   headsup uninstall            take it all out again (keeps your settings and recordings)
//   npx headsup-mcp install      the same, without a checkout
//
// Heads-up ships as a plugin for Claude Code and Codex (MCP server, skill and hooks in one).
// This script:
//   1. checks Node and ffmpeg (ffmpeg is only needed to record new lines), and on Linux the
//      sound, call and keyring tools heads-up uses
//   2. builds the helper into DATA/bin: the call detector on macOS (Xcode command line tools),
//      the Windows helper with the C# compiler Windows ships with; Linux needs none
//   3. Claude Code: adds the heads-up marketplace and installs the plugin, allows its
//      notify_user tool, and removes the pre-plugin setup (MCP entry, hooks, CLAUDE.md section)
//   4. Codex: adds the marketplace and installs the plugin; its hooks still need trusting in /hooks
//   5. writes the headsup command to ~/.local/bin (headsup.cmd on Windows)
// Anything it can't do is printed with the command to do it by hand.
//
// Where the plugin comes from: --source <path|owner/repo>, else this checkout, else GitHub.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA, HELPER, ROOT, rememberRoot } from "../paths.mjs";
import { has, which } from "../platform/common.mjs";
import { secretDeleteHint, secretRead, words } from "../platform/index.mjs";

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

// Where DATA is when HEADS_UP_HOME isn't set, as each shim spells it (see defaultData in paths.mjs).
const SHIM_DATA = {
  darwin: "$HOME/Library/Application Support/heads-up",
  linux: "\${XDG_DATA_HOME:-$HOME/.local/share}/heads-up",
};

// The headsup command: runs whichever copy of heads-up ran last (DATA/root), else `fallback`.
// A batch file on Windows, a POSIX sh script everywhere else.
export function shim(node, fallback, platform = process.platform) {
  if (platform === "win32") return cmdShim(node, fallback);
  return `#!/bin/sh
${SHIM_MARK}: runs the installed copy of heads-up (its path is kept in DATA/root).
data="\${HEADS_UP_HOME:-${SHIM_DATA[platform] ?? SHIM_DATA.linux}}"
root=$(cat "$data/root" 2>/dev/null)
[ -f "$root/cli.mjs" ] || root=${quote(fallback)}
node=${quote(node)}
[ -x "$node" ] || node=node
exec "$node" "$root/cli.mjs" "$@"
`;
}

// Inside set "x=..." only % is special (and " can't be in a Windows path).
const cmdValue = (p) => String(p).replace(/%/g, "%%");
const cmdShim = (node, fallback) =>
  [
    "@echo off",
    `rem ${SHIM_MARK}: runs the installed copy of heads-up (its path is kept in DATA\\root).`,
    "setlocal",
    'set "data=%LOCALAPPDATA%\\heads-up"',
    'if defined HEADS_UP_HOME set "data=%HEADS_UP_HOME%"',
    'set "root="',
    'if exist "%data%\\root" set /p root=<"%data%\\root"',
    `if not exist "%root%\\cli.mjs" set "root=${cmdValue(fallback)}"`,
    `set "node=${cmdValue(node)}"`,
    'if not exist "%node%" set "node=node"',
    '"%node%" "%root%\\cli.mjs" %*',
    "",
  ].join("\r\n");

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

// For sh: plain if it's only safe characters, else single-quoted (nothing inside is special).
export const quote = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
// For showing a command to run by hand in this system's shell.
const shown = (cmd, args) => [cmd, ...args].map((a) => (process.platform !== "win32" ? quote(a) : /^[\w@+=:,./\\-]+$/.test(a) ? a : `"${a}"`)).join(" ");

// Runs a command without a shell. On Windows, npm installs CLIs such as claude as .cmd
// files, which only cmd.exe can start; their arguments are quoted, and anything cmd.exe
// would still read as special is refused instead.
export function run(cmd, args) {
  const exe = which(cmd) ?? cmd;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    if ([exe, ...args].some((a) => /["%^&|<>!\r\n]/.test(a))) return { status: 1, stdout: "", stderr: "an argument has characters cmd.exe treats as special" };
    const line = [exe, ...args].map((a) => `"${a}"`).join(" ");
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawnSync(exe, args, { encoding: "utf8", windowsHide: true });
}
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
  const binDir = join(homedir(), ".local", "bin");
  const link = join(binDir, process.platform === "win32" ? "headsup.cmd" : "headsup");
  const linkShown = process.platform === "win32" ? "%USERPROFILE%\\.local\\bin\\headsup.cmd" : "~/.local/bin/headsup";
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
      if (r.status !== 0 && !ok(r)) throw new Error(`${why(r)}\n  Run it yourself: ${shown(cmd, cmdArgs)}`);
    });
  const already = (r) => /already/i.test(`${r.stdout}${r.stderr}`);

  if (!["darwin", "linux", "win32"].includes(process.platform)) say("!", "Heads-up plays audio on macOS, Linux and Windows; on this system only the setup is done.");
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
    if (codex) step("uninstall the heads-up plugin from Codex", "codex", ["plugin", "remove", PLUGIN], (r) => /not installed|not found/i.test(why(r)));
    if (codex) step("remove the heads-up marketplace from Codex", "codex", ["plugin", "marketplace", "remove", MARKETPLACE], (r) => /not found/i.test(why(r)));
    editSettings(withoutHeadsUp, "remove heads-up's allow rule and any old hooks from ~/.claude/settings.json");
    removeOldSection();
    if (ourShim()) act(`remove ${linkShown}`, () => rmSync(link));
    if (existsSync(join(DATA, "root"))) act("forget where the plugin was installed", () => rmSync(join(DATA, "root")));
    console.log(`\nYour settings and recordings are still in ${DATA}. Delete that folder to remove them too.`);
    // Keys stay too (you may reinstall); say how to remove the ones the settings page saved.
    const keys = process.env.HEADS_UP_NO_KEYCHAIN === "1" ? [] : ["heads-up-elevenlabs", "heads-up-sarvam"].filter((s) => secretRead(s));
    if (keys.length) console.log(`Your API keys are still in the ${words.keyStoreFull}. To remove them:\n  ${keys.map(secretDeleteHint).join("\n  ")}`);
    return;
  }

  // 1. Tools
  const ffmpegHint = { darwin: "brew install ffmpeg", win32: "winget install Gyan.FFmpeg", linux: linuxInstall(["ffmpeg"]) }[process.platform];
  say(has("ffmpeg") ? "✓" : "!", has("ffmpeg") ? "ffmpeg found" : `ffmpeg is missing. The built-in alerts work without it; spoken project names and the agent's own lines need it: ${ffmpegHint}`);
  if (process.platform === "linux") for (const line of linuxTools()) say(...line);

  // 2. Helper
  if (process.platform === "darwin") {
    if (has("swiftc")) {
      act("build the call detector", () => {
        mkdirSync(join(DATA, "bin"), { recursive: true });
        execFileSync("swiftc", ["-O", join(ROOT, "tools", "media-in-use.swift"), "-o", HELPER], { stdio: "pipe" });
      });
    } else {
      say("!", existsSync(HELPER) ? "swiftc not found; keeping the call detector that's already built" : "swiftc not found, so call detection stays off. Install Xcode's command line tools (xcode-select --install), then run this again.");
    }
  }
  if (process.platform === "win32") {
    const csc = cscPath();
    if (csc) {
      act("build the Windows helper (volume, calls, Do not disturb, Credential Manager)", () => {
        mkdirSync(join(DATA, "bin"), { recursive: true });
        execFileSync(csc, ["/nologo", "/optimize+", "/target:exe", `/out:${HELPER}`, join(ROOT, "tools", "headsup-win.cs")], { stdio: "pipe", windowsHide: true });
      });
    } else {
      say("!", existsSync(HELPER) ? "The C# compiler wasn't found; keeping the Windows helper that's already built" : "The C# compiler that comes with Windows (.NET Framework 4) wasn't found, so volume control, call detection and saved keys stay off. Alerts still play.");
    }
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
    step("install the heads-up plugin in Codex", "codex", ["plugin", "add", PLUGIN], already);
    say("!", "In Codex, open /hooks once and trust heads-up's three hooks (Codex asks before running any plugin hook).");
  }

  // 5. Command
  const installed = claude ? pluginPath(claudeDir) : null;
  if (!dry) rememberRoot(installed ?? ROOT);
  const l = lstatSync(link, { throwIfNoEntry: false });
  if (l && !ourShim()) say("!", `${link} exists and isn't heads-up's; left alone.`);
  else
    act(`write the headsup command to ${linkShown}`, () => {
      mkdirSync(binDir, { recursive: true });
      if (l) rmSync(link);
      writeFileSync(link, shim(process.execPath, installed ?? ROOT));
      if (process.platform !== "win32") chmodSync(link, 0o755);
    });
  if (!onPath(binDir)) say("!", pathHint());

  if (dry) console.log("\nDry run: nothing was changed.");
  else {
    console.log("\nDone. Restart open Claude Code sessions so they load the plugin, then run headsup to open the settings page.");
    console.log("Out of the box, heads-up plays its built-in lines. To hear project names or the agent's own words, add your ElevenLabs or Sarvam key on that page.");
  }
  if (todo.length) console.log(`\nClaude Code's command wasn't found. Run these yourself:\n  ${todo.join("\n  ")}`);
}

// Whether a folder is on PATH (case-insensitive on Windows, trailing slashes ignored).
export function onPath(dir, path = process.env.PATH ?? "", platform = process.platform) {
  const norm = (p) => (platform === "win32" ? p.toLowerCase() : p).replace(/[\\/]+$/, "");
  return path.split(platform === "win32" ? ";" : delimiter).some((p) => p && norm(p) === norm(dir));
}

function pathHint() {
  if (process.platform === "win32")
    return "%USERPROFILE%\\.local\\bin isn't on your PATH. Add it in Settings > System > About > Advanced system settings > Environment Variables (Path, for your user), then open a new terminal.";
  const sh = (process.env.SHELL ?? "").split("/").pop();
  if (sh === "fish") return "~/.local/bin isn't on your PATH. Add it: fish_add_path ~/.local/bin";
  const rc = sh === "zsh" ? "~/.zshrc" : sh === "bash" ? "~/.bashrc" : "~/.profile";
  return `~/.local/bin isn't on your PATH. Add it in ${rc}: export PATH="$HOME/.local/bin:$PATH"`;
}

// The C# compiler that ships with .NET Framework 4 on every Windows 10 and 11.
function cscPath() {
  const win = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  return ["Framework64", "Framework"].map((f) => join(win, "Microsoft.NET", f, "v4.0.30319", "csc.exe")).find((p) => existsSync(p)) ?? null;
}

// Linux: which package manager, from /etc/os-release, and each tool's package there.
export function linuxFamily(osRelease = readOsRelease()) {
  const ids = `${osRelease.match(/^ID=(.*)$/m)?.[1] ?? ""} ${osRelease.match(/^ID_LIKE=(.*)$/m)?.[1] ?? ""}`.replace(/"/g, "");
  if (/\b(debian|ubuntu)\b/.test(ids)) return "apt";
  if (/\b(fedora|rhel|centos)\b/.test(ids)) return "dnf";
  if (/\b(arch)\b/.test(ids)) return "pacman";
  if (/\b(suse|opensuse)\b/.test(ids)) return "zypper";
  return null;
}
function readOsRelease() {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return "";
  }
}
const PACKAGES = {
  apt: { "pw-play": "pipewire-bin", "pw-dump": "pipewire-bin", pactl: "pulseaudio-utils", "secret-tool": "libsecret-tools", ffmpeg: "ffmpeg" },
  dnf: { "pw-play": "pipewire-utils", "pw-dump": "pipewire-utils", pactl: "pulseaudio-utils", "secret-tool": "libsecret", ffmpeg: "ffmpeg-free" },
  pacman: { "pw-play": "pipewire", "pw-dump": "pipewire", pactl: "libpulse", "secret-tool": "libsecret", ffmpeg: "ffmpeg" },
  zypper: { "pw-play": "pipewire-tools", "pw-dump": "pipewire-tools", pactl: "pulseaudio-utils", "secret-tool": "libsecret-tools", ffmpeg: "ffmpeg" },
};
const VERB = { apt: "sudo apt install", dnf: "sudo dnf install", pacman: "sudo pacman -S", zypper: "sudo zypper install" };
export function linuxInstall(tools, family = linuxFamily()) {
  if (!family) return `install ${tools.join(", ")} with your package manager`;
  return `${VERB[family]} ${[...new Set(tools.map((t) => PACKAGES[family][t] ?? t))].join(" ")}`;
}

// What heads-up can and can't do on this Linux system, one line per area.
function linuxTools() {
  const lines = [];
  const player = ["pw-play", "paplay", "ffplay", "mpg123"].find(has);
  lines.push(player ? ["✓", `Sound: plays with ${player}`] : ["✗", `No audio player found, so alerts can't play: ${linuxInstall(["pw-play", "pactl"])}`]);
  const mixer = ["pactl", "wpctl"].find(has);
  lines.push(mixer ? ["✓", `Volume: set with ${mixer}`] : ["!", `Neither pactl nor wpctl was found, so heads-up can't set a safe volume and plays at your current one: ${linuxInstall(["pactl"])}`]);
  lines.push(has("pw-dump") || has("pactl") ? ["✓", "Calls: mic and camera checks ready"] : ["!", `Call detection needs pw-dump or pactl: ${linuxInstall(["pw-dump"])}`]);
  lines.push(has("secret-tool") ? ["✓", "Keys: saved in your keyring with secret-tool"] : ["!", `secret-tool is missing, so the settings page can't save keys; set ELEVENLABS_API_KEY or SARVAM_API_KEY in your environment, or: ${linuxInstall(["secret-tool"])}`]);
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
