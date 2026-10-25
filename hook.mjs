#!/usr/bin/env node
// Hook entry for heads-up (Claude Code and Codex), so key alerts don't depend on
// the model remembering to call notify_user. Registered by the plugin (hooks/):
//   UserPromptSubmit   note when the turn started
//   Notification       Claude Code: permission prompt -> "approval"; idle -> "reminder" (off by default)
//   PermissionRequest  Codex: about to ask for approval -> "approval" (prints nothing, so Codex still asks)
//   Stop               turn ran longer than hooks.long_turn_seconds -> "completed" (or "input")
// Background sessions (claude -p, SDK workers) are ignored. Playback runs in a
// detached child so the hook returns at once.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, alert, loadConfig, loadHistory, projectFor } from "./core.mjs";

const TURNS = join(DATA, "turns.json");
const LOG = join(DATA, "hook.log");
const DAY = 24 * 3600 * 1000;

const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown";

// One line per hook decision, for troubleshooting. Trimmed when it passes ~200 KB.
function log(msg) {
  try {
    if (statSync(LOG, { throwIfNoEntry: false })?.size > 200_000) writeFileSync(LOG, readFileSync(LOG, "utf8").slice(-50_000));
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging must never break a hook
  }
}

// Detached child: run the guardrails, log, play, then exit.
if (process.argv[2] === "--play") {
  const [, , , id, source, project] = process.argv;
  const r = alert(id, { source, project: project || null, meta: { entrypoint } });
  if (r.done) await r.done;
  process.exit(0);
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}
const event = input.hook_event_name;
const session = input.session_id ?? "unknown";
const tag = `${event} session=${session.slice(0, 8)} entry=${entrypoint} attended=${process.env.CLAUDE_CODE_SESSION_ATTENDED ?? "-"}`;

const headless = /^sdk/.test(entrypoint) || process.env.CLAUDE_CODE_SESSION_ATTENDED === "0";
if (headless && process.env.HEADS_UP_ALLOW_HEADLESS !== "1") {
  log(`${tag} ignored: background session`);
  process.exit(0);
}
const c = loadConfig();

function readTurns() {
  try {
    return JSON.parse(readFileSync(TURNS, "utf8"));
  } catch {
    return {};
  }
}

function writeTurns(turns) {
  const now = Date.now();
  const fresh = Object.fromEntries(Object.entries(turns).filter(([, t]) => now - Date.parse(t) < DAY));
  const tmp = `${TURNS}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(fresh, null, 2) + "\n");
  renameSync(tmp, TURNS);
}

function play(id) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--play", id, `hook:${event}`, projectFor(input.cwd) ?? ""], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }).unref();
}

// Which alert a Notification maps to, or null. Falls back to the message text
// for Claude Code versions that don't send notification_type.
function notificationAlert({ notification_type: type, message = "" }) {
  const kind = type ?? (/permission/i.test(message) ? "permission_prompt" : /waiting for your input/i.test(message) ? "idle_prompt" : "");
  if (kind === "permission_prompt") return c.hooks.permission ? "approval" : null;
  if (/^elicitation_(url_)?dialog$|^agent_needs_input$/.test(kind)) return c.hooks.permission ? "input" : null;
  if (kind === "idle_prompt") return c.hooks.idle_reminder ? "reminder" : null;
  return null;
}

if (event === "UserPromptSubmit") {
  writeTurns({ ...readTurns(), [session]: new Date().toISOString() });
  log(`${tag} turn started`);
} else if (event === "Notification") {
  const id = notificationAlert(input);
  log(`${tag} type=${input.notification_type ?? "-"} -> ${id ?? "no alert"}`);
  if (id) play(id);
} else if (event === "PermissionRequest") {
  const id = c.hooks.permission ? "approval" : null;
  log(`${tag} tool=${input.tool_name ?? "-"} -> ${id ?? "no alert"}`);
  if (id) play(id);
} else if (event === "Stop") {
  const turns = readTurns();
  const start = turns[session];
  delete turns[session];
  writeTurns(turns);
  const secs = start ? Math.round((Date.now() - Date.parse(start)) / 1000) : null;
  if (!c.hooks.long_turn) log(`${tag} long-turn alerts off`);
  else if (secs === null) log(`${tag} no turn start recorded`);
  else if (secs < c.hooks.long_turn_seconds) log(`${tag} turn ${secs}s, under ${c.hooks.long_turn_seconds}s`);
  else if (loadHistory().some((h) => h.source === "claude" && Date.parse(h.t) >= Date.parse(start))) {
    // Claude already called notify_user this turn and chose the alert; don't double up.
    log(`${tag} turn ${secs}s, Claude already alerted`);
  } else {
    const id = String(input.last_assistant_message ?? "").trim().endsWith("?") ? "input" : "completed";
    log(`${tag} turn ${secs}s -> ${id}`);
    play(id);
  }
}
