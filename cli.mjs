#!/usr/bin/env node
// headsup: control heads-up from the terminal.
//   headsup              open the settings page
//   headsup on | off     master switch
//   headsup mute [min]   mute for N minutes (default 60); unmute to undo
//   headsup status       show what would happen right now
//   headsup test [id]    play an alert now, ignoring guardrails
//   headsup say <words>  speak your own line now with your key (like Claude's messages)
//   headsup usage        characters sent to your voice providers
//   headsup version      version and maker
//   headsup install      install the plugin in Claude Code (and Codex); uninstall to undo

import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, STATUSES, activeFocus, alert, blockedReason, currentLocation, detectorProblems, loadConfig, probeDetectors, saveConfig } from "./core.mjs";
import { usageSummary } from "./speech.mjs";
import { elevenUsage, keySource } from "./tts.mjs";

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
    console.log(`Voice:    ${c.custom_voices.find((v) => v.id === c.voice)?.name ?? c.voice}`);
    console.log(`Live:     ${c.live.enabled ? `on, up to ${c.live.max_chars} characters a line, ${c.live.daily_chars} a day` : "off"}`);
    console.log(`Keys:     ElevenLabs ${keySource("elevenlabs") ?? "none"}, Sarvam ${keySource("sarvam") ?? "none"}`);
    console.log(`Location: ${here.location ?? "unsaved network"}${c.location_lock ? " (location lock on)" : ""}`);
    const probe = probeDetectors();
    const m = probe.media;
    console.log(`Calls:    ${!(c.calls.mic || c.calls.camera) ? "off" : !m ? "unavailable" : m.camera ? "camera in use" : m.mic ? "mic in use" : "none"}`);
    console.log(`Focus:    ${!c.calls.focus ? "off" : !probe.focus ? "unavailable" : (activeFocus() ?? "none")}`);
    for (const p of detectorProblems(c, probe)) console.log(`Warning:  ${p}`);
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
  case "say": {
    const words = process.argv.slice(3).join(" ").trim();
    if (!words) {
      console.error('Usage: headsup say "The build is green."');
      process.exit(1);
    }
    const r = alert("completed", { force: true, source: "cli test", message: words });
    const p = await r.prepared;
    console.log(p.live ? `Playing "${p.line}"` : `Playing "${p.line}" (yours wasn't spoken: ${p.note})`);
    await r.done;
    break;
  }
  case "usage": {
    const u = usageSummary();
    console.log(`Today:      ElevenLabs ${u.today.elevenlabs}, Sarvam ${u.today.sarvam} characters`);
    console.log(`This month: ElevenLabs ${u.month.elevenlabs}, Sarvam ${u.month.sarvam} characters`);
    const a = await elevenUsage();
    if (a) console.log(`ElevenLabs plan: ${a.used} of ${a.limit} credits used${a.resets ? `, resets ${new Date(a.resets).toLocaleDateString()}` : ""}`);
    break;
  }
  case "install":
  case "uninstall":
    execFileSync(process.execPath, [join(ROOT, "tools", "install.mjs"), ...(cmd === "uninstall" ? ["--uninstall"] : []), ...process.argv.slice(3)], { stdio: "inherit" });
    break;
  case "version":
  case "--version":
  case "-v": {
    const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    console.log(`Heads-up ${version}. Built and maintained by Brand Bakery: https://brandbakery.tech`);
    break;
  }
  default:
    console.log("Usage: headsup [settings | on | off | mute [minutes] | unmute | status | test [alert] | say <words> | usage | install | uninstall | version]");
    console.log(`Alerts: ${Object.keys(STATUSES).join(", ")}`);
}
