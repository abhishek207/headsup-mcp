// macOS: afplay for playback, AppleScript for the volume, system_profiler for the output
// device, the Swift call detector (tools/media-in-use.swift), the Focus files, ioreg for
// idle time, the router's MAC for locations and the Keychain for provider keys.

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HELPER } from "../paths.mjs";
import { MAC, clamp, readJson } from "./common.mjs";

const run = promisify(execFile);

export const words = {
  os: "macOS",
  machine: "Mac",
  volume: "Mac volume",
  focus: "Focus",
  focusOn: "have a Focus mode on",
  focusWhen: "When a Focus is on",
  focusDesc: "Focus modes you switch on, and scheduled ones",
  keyStore: "Keychain",
  keyStoreFull: "macOS Keychain",
  speakers: "Mac speakers",
  headphones: "AirPods and headphones",
  micApps: "Zoom, Meet, FaceTime, dictation",
};
export const chimes = ["/System/Library/Sounds/Glass.aiff"];
// MCP servers and hooks can start with a minimal PATH; make Homebrew's tools findable.
export const extraPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"];

export const play = (file) => run("afplay", [file]);
export const openUrl = (url) => execFileSync("open", [url]);
// A Mac always has an output device; afplay plays even with no one logged in at the screen.
export const audioReady = () => true;

const osa = async (script) => (await run("osascript", ["-e", script])).stdout.trim();

export async function getVolume() {
  const [vol, muted] = (await osa("set s to get volume settings\nreturn (output volume of s as text) & \",\" & (output muted of s as text)")).split(",");
  return { vol: Number(vol), muted: muted === "true" };
}

// Only a number and a boolean ever reach the script, even from a tampered lock file.
export const setVolume = (vol, muted) =>
  osa(`set volume output volume ${clamp(vol, 0, 100, 0)}` + (muted === undefined ? "" : `\nset volume output muted ${muted === true}`));

// Default output counts as headphones if it is Bluetooth/USB or its name says so.
export async function outputDevice() {
  try {
    const { stdout } = await run("system_profiler", ["SPAudioDataType", "-json"], { timeout: 5000 });
    const items = JSON.parse(stdout).SPAudioDataType.flatMap((g) => g._items ?? []);
    const out = items.find((i) => i.coreaudio_default_audio_output_device === "spaudio_yes");
    if (!out) return { name: "unknown", headphones: true };
    const transport = out.coreaudio_device_transport ?? "";
    const name = `${out._name} ${out.coreaudio_output_source ?? ""}`;
    return { name: out._name, headphones: /bluetooth|usb/.test(transport) || /headphone|airpods|buds|beats|headset/i.test(name) };
  } catch {
    return { name: "unknown", headphones: true }; // unknown device: assume ears are close
  }
}

// Location = the network you're on, identified by the router's hardware (MAC)
// address. It needs no Location Services permission and nothing leaves the Mac.
// (macOS redacts the Wi-Fi name for apps without that permission.)
export function currentNetworks() {
  const nets = [];
  for (let i = 0; i < 10; i++) {
    const iface = `en${i}`;
    try {
      const router = execFileSync("ipconfig", ["getoption", iface, "router"], { encoding: "utf8", timeout: 2000 }).trim();
      if (!router) continue;
      const mac = execFileSync("arp", ["-n", router], { encoding: "utf8", timeout: 2000 }).match(/ at ([0-9a-f:]+) /i)?.[1];
      if (mac && MAC.test(mac)) nets.push({ iface, router, mac: mac.toLowerCase() });
    } catch {
      // interface not present or not connected
    }
  }
  return nets;
}

// Seconds since the last keyboard, mouse or trackpad input (macOS HIDIdleTime), or null if unknown.
export function idleSeconds() {
  try {
    const out = execFileSync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8", timeout: 2000 });
    const ns = Number(out.match(/"HIDIdleTime" = (\d+)/)?.[1]);
    return Number.isFinite(ns) ? ns / 1e9 : null;
  } catch {
    return null;
  }
}

// Whether any app is using a microphone or camera ({ mic, camera }), or null if unknown.
// The helper (media-in-use) only reads device state, so it never lights the privacy indicator.
export function mediaInUse() {
  try {
    return JSON.parse(execFileSync(HELPER, { encoding: "utf8", timeout: 2000 }));
  } catch {
    return null;
  }
}

export const callsReady = () => existsSync(HELPER);
export const callsSetup = "the mic and camera checker isn't built. Run headsup install.";

const FOCUS_DB = join(homedir(), "Library", "DoNotDisturb", "DB");

// Whether macOS's Focus settings can be read at all. If Apple moves or changes them,
// Focus detection stops working, and this is how status and the page find out.
export function focusReadable(db = FOCUS_DB) {
  return Boolean(readJson(join(db, "ModeConfigurations.json"), null)?.data?.[0]?.modeConfigurations);
}
export const focusUnreadable = "macOS Focus settings couldn't be read.";

// Name of the active Focus ("Work", "Do Not Disturb"), or null. Reads the files macOS
// keeps for Focus: manually switched-on modes, plus enabled time schedules.
// Sleep and smart (location/app) triggers aren't recorded there, so they aren't seen.
export function activeFocus(now = new Date(), db = FOCUS_DB) {
  const modes = readJson(join(db, "ModeConfigurations.json"), {})?.data?.[0]?.modeConfigurations ?? {};
  const nameOf = (id) => modes[id]?.mode?.name ?? "Focus";
  const records = readJson(join(db, "Assertions.json"), {})?.data?.[0]?.storeAssertionRecords ?? [];
  const manual = records.find((r) => r?.assertionDetails?.assertionDetailsModeIdentifier);
  if (manual) return nameOf(manual.assertionDetails.assertionDetailsModeIdentifier);
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const [id, m] of Object.entries(modes)) {
    for (const t of m.triggers?.triggers ?? []) {
      if (t.class !== "DNDModeConfigurationScheduleTrigger" || t.enabledSetting !== 2) continue;
      if (!(t.timePeriodWeekdays & (1 << now.getDay()))) continue;
      const s = t.timePeriodStartTimeHour * 60 + t.timePeriodStartTimeMinute;
      const e = t.timePeriodEndTimeHour * 60 + t.timePeriodEndTimeMinute;
      if (s <= e ? mins >= s && mins < e : mins >= s || mins < e) return nameOf(id);
    }
  }
  return null;
}

// Keychain. Saving goes through `security -i` on stdin, so the key never appears in a
// process list; everything in that command line is checked first, so nothing can add a
// second command.
export function secretRead(service) {
  const r = spawnSync("security", ["find-generic-password", "-a", process.env.USER, "-s", service, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export function secretSave(service, label, key) {
  if (!/^[\w.@-]+$/.test(process.env.USER ?? "")) throw new Error("Couldn't save to the Keychain: unusual account name");
  if (!/^[\w .-]+$/.test(`${service}${label}`)) throw new Error("Couldn't save to the Keychain");
  const r = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -a "${process.env.USER}" -s "${service}" -l "${label}" -w "${key}"\n`,
    encoding: "utf8",
  });
  if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error("Couldn't save to the Keychain");
}

export function secretDelete(service) {
  spawnSync("security", ["delete-generic-password", "-a", process.env.USER, "-s", service]);
}

export const secretDeleteHint = (service) => `security delete-generic-password -s ${service}`;
