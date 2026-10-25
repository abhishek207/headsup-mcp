#!/usr/bin/env node
// heads-up: a tiny zero-dependency MCP server (stdio) that plays a
// pre-recorded voice line on the Mac speaker so the user hears when Claude
// needs them or has finished. Guardrails and settings live in core.mjs and
// config.json; run `headsup` for the settings page.

import { createInterface } from "node:readline";
import { STATUSES, TEMPLATES, alert, projectFor } from "./core.mjs";

const TOOL = {
  name: "notify_user",
  description:
    "Play a short spoken alert on the user's Mac speaker so they can come back to the computer. " +
    "Call it once at the end of a turn (or when starting something long), picking the status that matches why you stopped:\n" +
    TEMPLATES.map((t) => `- ${t.id}: ${t.when} ("${t.text}")`).join("\n") +
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

function callTool(args = {}) {
  const r = alert(args.status, { repeat: Number(args.repeat) || 1, volume: args.volume, project: projectFor(process.cwd()) });
  if (!r.ok) return { isError: true, content: [{ type: "text", text: r.error }] };
  const text = r.played ? `Playing "${r.line}"` : `Not played: ${r.reason}. This is the user's setting; don't retry.`;
  return { content: [{ type: "text", text }] };
}

function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "heads-up", version: "1.3.0" },
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

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (msg.id === undefined) return; // notification (e.g. notifications/initialized)
  try {
    send({ jsonrpc: "2.0", id: msg.id, result: handle(msg) });
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } });
  }
});
