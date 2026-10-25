#!/usr/bin/env node
// heads-up: a tiny zero-dependency MCP server (stdio) that plays a short
// voice line on the Mac speaker so the user hears when Claude needs them or has
// finished: a pre-recorded line, or Claude's own words recorded with the user's
// ElevenLabs or Sarvam key. Guardrails and settings live in core.mjs and
// config.json; run `headsup` for the settings page.

import { resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { ROOT, STATUSES, TEMPLATES, alert, detectorProblems, loadConfig, projectFor, textFor } from "./core.mjs";

const config = loadConfig();
const PREPARE_WAIT_MS = 15_000; // how long the tool waits for a live line to be recorded

const TOOL = {
  name: "notify_user",
  description:
    "Play a short spoken alert on the user's Mac speaker so they can come back to the computer. " +
    "Call it once at the end of a turn (or when starting something long), picking the status that matches why you stopped:\n" +
    TEMPLATES.map((t) => `- ${t.id}: ${t.when} ("${textFor(t.id, config)}")`).join("\n") +
    "\nTheir settings (off switch, mute, quiet hours, location lock, cooldown) may block it; a skipped alert is not an error, so don't retry.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: Object.keys(STATUSES) },
      repeat: {
        type: "integer",
        minimum: 1,
        maximum: 3,
        default: 1,
        description: "How many times to play the line (use 2 for something urgent).",
      },
      message: {
        type: "string",
        maxLength: 400,
        description:
          `Optional: your own short line, spoken instead of the status's fixed line when that line doesn't say enough ` +
          `(e.g. "The migration ran, but two tables need your review."). One or two plain sentences in first person, ` +
          `at most ${config.live.max_chars} characters; no code, paths, links or secrets, because it's sent to the user's ` +
          `text-to-speech provider. Still pick the closest status: if the line can't be recorded, the status's line plays instead.`,
      },
      volume: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Optional target volume %. Leave it out: volume is handled automatically within their safety caps.",
      },
    },
    required: ["status"],
  },
};

// The user's project folder. Claude Code starts the server there; Codex starts plugin
// servers in the plugin's own folder, so use the PWD inherited from the session instead.
// If all we can see is our own folder (or something inside it), there's no project to name.
const projectDir = () => {
  const dir = resolve(process.cwd() === ROOT && process.env.PWD ? process.env.PWD : process.cwd());
  return dir === ROOT || dir.startsWith(ROOT + sep) ? null : dir;
};

async function callTool(args = {}) {
  const message = typeof args.message === "string" && args.message.trim() ? args.message : null;
  const r = alert(args.status, { repeat: Number(args.repeat) || 1, volume: args.volume, project: projectFor(projectDir()), message });
  if (!r.ok) return { isError: true, content: [{ type: "text", text: r.error }] };
  if (!r.played) return { content: [{ type: "text", text: `Not played: ${r.reason}. This is the user's setting; don't retry.` }] };
  if (!message) return { content: [{ type: "text", text: `Playing "${r.line}"` }] };
  // Wait for the recording so the answer says what was actually spoken.
  const p = await Promise.race([r.prepared, new Promise((ok) => setTimeout(() => ok(null), PREPARE_WAIT_MS).unref())]);
  if (!p) return { content: [{ type: "text", text: `Recording "${r.line}"; it plays when ready.` }] };
  const text = p.live ? `Playing "${p.line}"` : `Playing "${p.line}" (your message wasn't spoken: ${p.note ?? "it couldn't be recorded"}; don't retry)`;
  return { content: [{ type: "text", text }] };
}

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "heads-up", version: "1.5.4" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call":
      if (msg.params?.name !== TOOL.name) throw { code: -32602, message: `Unknown tool ${msg.params?.name}` };
      return callTool(msg.params.arguments);
    default:
      throw { code: -32601, message: `Method not found: ${msg.method}` };
  }
}

// Claude Code shows server stderr in its MCP logs; say so if calls or Focus can't be detected.
for (const p of detectorProblems()) process.stderr.write(`heads-up: ${p}\n`);

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// Replies go out as each call finishes, so a live line being recorded doesn't hold up a ping.
createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (msg.id === undefined) return; // notification (e.g. notifications/initialized)
  try {
    send({ jsonrpc: "2.0", id: msg.id, result: await handle(msg) });
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } });
  }
});
