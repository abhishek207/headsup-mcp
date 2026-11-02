// Windows: one small helper (tools/headsup-win.cs, which headsup install builds into
// DATA\bin with the C# compiler every Windows 10 and 11 already has) plays audio, reads and
// sets the volume, names the output device, sees whether the mic or camera is in use, reads
// Do not disturb and idle time, and keeps keys in Credential Manager. Locations come from
// `route print` and `arp -a`. Without the helper, clips still play through PowerShell, and
// detectorProblems and the installer both say how to build it.

import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { HELPER } from "../paths.mjs";
import { MAC, clamp } from "./common.mjs";

const run = promisify(execFile);
const helper = (args, timeout = 5000, signal) => run(HELPER, args, { windowsHide: true, timeout, signal });
const helperSync = (args, opts = {}) => spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, timeout: 5000, ...opts });
const json = (args) => {
  try {
    const r = helperSync(args);
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
};

export const words = {
  os: "Windows",
  machine: "PC",
  volume: "Volume",
  focus: "Do not disturb",
  focusOn: "have Do not disturb on",
  focusWhen: "When Do not disturb is on",
  focusDesc: "Do not disturb, switched on or scheduled",
  keyStore: "Credential Manager",
  keyStoreFull: "Windows Credential Manager",
  speakers: "Speakers",
  headphones: "Headphones and earbuds",
  micApps: "Zoom, Teams, Meet, dictation",
};
const MEDIA = join(process.env.SystemRoot || "C:\\Windows", "Media");
export const chimes = ["Windows Notify System Generic.wav", "Windows Notify.wav", "chimes.wav"].map((f) => join(MEDIA, f));
export const extraPath = [];

// Without the helper, Windows PowerShell's media player still plays the clip. The path
// travels in an environment variable, never inside the script.
const PS_PLAY = [
  "Add-Type -AssemblyName PresentationCore",
  "$p = New-Object System.Windows.Media.MediaPlayer",
  "$p.Open([uri]$env:HEADS_UP_FILE)",
  "for ($i = 0; $i -lt 50 -and -not $p.NaturalDuration.HasTimeSpan; $i++) { Start-Sleep -Milliseconds 100 }",
  "$ms = if ($p.NaturalDuration.HasTimeSpan) { $p.NaturalDuration.TimeSpan.TotalMilliseconds } else { 4000 }",
  "$p.Play()",
  "Start-Sleep -Milliseconds ([int]$ms + 250)",
  "$p.Close()",
].join("; ");

export async function play(file, signal) {
  if (existsSync(HELPER)) return helper(["play", file], 60_000, signal);
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_PLAY], { windowsHide: true, timeout: 60_000, signal, env: { ...process.env, HEADS_UP_FILE: file } });
}

export function openUrl(url) {
  spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
}

// An SSH session on Windows has no desktop and no sound, so alerts would go nowhere.
export const audioReady = (env = process.env) => !env.SSH_CONNECTION;

export async function getVolume() {
  const a = JSON.parse((await helper(["audio"])).stdout);
  return { vol: a.vol, muted: a.muted };
}

// Only a number and a fixed word ever reach the helper, even from a tampered lock file.
export const setVolume = (vol, muted) => helper(["set-volume", String(clamp(vol, 0, 100, 0)), ...(muted === undefined ? [] : [muted === true ? "mute" : "unmute"])]);

// Endpoint form factor 3 is headphones, 5 a headset; BTH* enumerators are Bluetooth.
export const headphonesFor = (a) =>
  !a || a.formFactor === 3 || a.formFactor === 5 || /^BTH/i.test(a.enumerator ?? "") || /^USB$/i.test(a.enumerator ?? "") || /headphone|airpods|buds|beats|headset|hands-free/i.test(a.name ?? "");

export async function outputDevice() {
  try {
    const a = JSON.parse((await helper(["audio"])).stdout);
    return { name: a.name || "unknown", headphones: headphonesFor(a) };
  } catch {
    return { name: "unknown", headphones: true }; // unknown device: assume ears are close
  }
}

// { mic, camera } from when Windows last saw each app use them, or null if unknown.
export const mediaInUse = () => json(["media"]);
export const callsReady = () => existsSync(HELPER);
export const callsSetup = "the Windows helper isn't built. Run headsup install.";

// Do not disturb (Focus assist on Windows 10): 0 off, 1 priority only, 2 alarms only.
let dndCache = { at: 0, value: null };
function dndProfile() {
  if (Date.now() - dndCache.at < 1000) return dndCache.value;
  const d = json(["dnd"]);
  dndCache = { at: Date.now(), value: Number.isInteger(d?.profile) ? d.profile : null };
  return dndCache.value;
}
export const focusReadable = () => dndProfile() !== null;
export const focusUnreadable = "Windows' Do not disturb setting couldn't be read.";
export const activeFocus = () => (dndProfile() > 0 ? words.focus : null);

export function idleSeconds() {
  try {
    const r = helperSync(["idle"]);
    const s = Number(r.stdout);
    return r.status === 0 && r.stdout.trim() && Number.isFinite(s) ? s : null;
  } catch {
    return null;
  }
}

// Location = the router's hardware (MAC) address: default routes from `route print`, the
// gateway's MAC from `arp -a`. Only the numbers are parsed, so the system language doesn't matter.
export const parseRoutePrint = (text) =>
  [...String(text ?? "").matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/gm)].map((m) => ({ router: m[1], iface: m[2] }));

export function parseArpA(text, ip) {
  const m = String(text ?? "").match(new RegExp(`^\\s*${ip.replace(/\./g, "\\.")}\\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\\s`, "im"));
  return m ? m[1].replace(/-/g, ":").toLowerCase() : null;
}

export function currentNetworks() {
  const opts = { encoding: "utf8", timeout: 2000, windowsHide: true };
  try {
    return parseRoutePrint(execFileSync("route", ["print", "-4", "0.0.0.0"], opts))
      .map((r) => ({ ...r, mac: parseArpA(execFileSync("arp", ["-a", r.router], opts), r.router) }))
      .filter((n, i, all) => n.mac && MAC.test(n.mac) && all.findIndex((x) => x.mac === n.mac) === i);
  } catch {
    return [];
  }
}

// Credential Manager (generic credentials). The secret goes to the helper on stdin, so
// it never appears in a process list.
export function secretRead(service) {
  if (!existsSync(HELPER)) return null;
  const r = helperSync(["cred-read", service]);
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export function secretSave(service, label, key) {
  if (!existsSync(HELPER)) throw new Error("Couldn't save to Credential Manager: the Windows helper isn't built (run headsup install)");
  const r = helperSync(["cred-write", service, label], { input: key });
  if (r.status !== 0) throw new Error("Couldn't save to Credential Manager");
}

export function secretDelete(service) {
  if (existsSync(HELPER)) helperSync(["cred-delete", service]);
}

export const secretDeleteHint = (service) => `cmdkey /delete:${service}`;
