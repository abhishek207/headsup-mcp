#!/usr/bin/env node
// headsup: control heads-up from the terminal.
//   headsup              open the settings page
//   headsup on | off     master switch
//   headsup mute [min]   mute for N minutes (default 60); unmute to undo
//   headsup status       show what would happen right now
//   headsup test [id]    play an alert now, ignoring guardrails

import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, STATUSES, alert, blockedReason, currentLocation, loadConfig, saveConfig } from "./core.mjs";

const PORT = 4777;
const URL = `http://127.0.0.1:${PORT}`;
const [cmd = "settings", arg] = process.argv.slice(2);
const c = loadConfig();

async function up() {
  try {
    return (await (await fetch(`${URL}/api/ping`)).json()).app === "heads-up";
  } catch {
    return false;
  }
}

switch (cmd) {
  case "settings":
  case "open": {
    if (!(await up())) {
      spawn(process.execPath, [join(ROOT, "settings.mjs")], { detached: true, stdio: "ignore" }).unref();
      for (let i = 0; i < 30 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
    }
    execFileSync("open", [URL]);
    console.log(`Settings: ${URL}`);
    break;
  }
  case "on":
  case "off":
    saveConfig({ ...c, enabled: cmd === "on", ...(cmd === "on" && { muted_until: null }) });
    console.log(`Voice alerts ${cmd}.`);
    break;
  case "mute": {
    const min = Number(arg) > 0 ? Number(arg) : 60;
    const until = new Date(Date.now() + min * 60000);
    saveConfig({ ...c, muted_until: until.toISOString() });
    console.log(`Muted until ${until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
    break;
  }
  case "unmute":
    saveConfig({ ...c, muted_until: null });
    console.log("Unmuted.");
    break;
  case "status": {
    const here = currentLocation(c);
    // Away detection is reported on its own line: running this command always counts as activity.
    const reason = blockedReason("completed", { ...c, away: { ...c.away, enabled: false } });
    console.log(`Alerts:   ${reason ? `blocked (${reason})` : "active"}`);
    console.log(`Away:     ${c.away.enabled ? `speaks after ${c.away.idle_seconds}s without keyboard or mouse input` : "off"}`);
    console.log(`Hooks:    permission ${c.hooks.permission ? "on" : "off"}, long tasks ${c.hooks.long_turn ? `on (${Math.round(c.hooks.long_turn_seconds / 60)} min)` : "off"}, reminder ${c.hooks.idle_reminder ? "on" : "off"}`);
    console.log(`Voice:    ${c.voice}`);
    console.log(`Location: ${here.location ?? "unsaved network"}${c.location_lock ? " (location lock on)" : ""}`);
    break;
  }
  case "test": {
    const id = arg && arg in STATUSES ? arg : "completed";
    const r = alert(id, { force: true, source: "cli test" });
    if (!r.ok) {
      console.error(r.error);
      process.exit(1);
    }
    console.log(`Playing "${r.line}"`);
    await r.done;
    break;
  }
  default:
    console.log("Usage: headsup [settings | on | off | mute [minutes] | unmute | status | test [alert]]");
    console.log(`Alerts: ${Object.keys(STATUSES).join(", ")}`);
}
