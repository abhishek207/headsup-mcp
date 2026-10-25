// Shared logic for heads-up: config + guardrails, alert history, volume
// safety and playback. Used by the MCP server, the settings page and the CLI.
// config.json and state.json are re-read on every call, so edits apply at once
// to every running Claude session.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { DATA, ROOT } from "./paths.mjs";
import { Skip, cleanMessage, compose, costOf, voiceInfo } from "./speech.mjs";
import { PROVIDERS, cachedSegment, segKey } from "./tts.mjs";

const run = promisify(execFile);
export { DATA, ROOT };
const CONFIG = join(DATA, "config.json");
const STATE = join(DATA, "state.json");
const VOICES = join(ROOT, "voices");
const CHIME = "/System/Library/Sounds/Glass.aiff";
const FALLBACK_VOICE = "american-male";

const { greeting, templates } = JSON.parse(readFileSync(join(ROOT, "templates.json"), "utf8"));
export const TEMPLATES = templates;
export const GREETING = greeting;
export const STATUSES = Object.fromEntries(templates.map((t) => [t.id, `${greeting} ${t.text}`]));

// Ceilings no config value can exceed (ear safety, AirPods especially).
export const HARD_CAP = { speakers: 90, headphones: 50 };

export const DEFAULTS = {
  enabled: true,
  voice: FALLBACK_VOICE,
  muted_until: null,
  location_lock: false,
  locations: [],
  statuses: Object.fromEntries(Object.keys(STATUSES).map((s) => [s, true])),
  quiet_hours: { enabled: false, start: "23:00", end: "08:00" },
  cooldown_seconds: 20,
  max_per_hour: 20,
  chime: true,
  // Speak only after this long without keyboard or mouse input.
  away: { enabled: true, idle_seconds: 60 },
  // Stay silent while a mic or camera is in use (calls) or a Focus is on.
  calls: { mic: true, camera: true, focus: true },
  // "Hello from <project>." instead of "Hello." Needs the user's own TTS key.
  project_names: { enabled: true, aliases: {}, muted: [] },
  // Claude Code hooks (hook.mjs): alerts that don't depend on Claude remembering.
  hooks: { permission: true, long_turn: true, long_turn_seconds: 120, idle_reminder: false },
  volume: {
    auto: true,
    speakers: { floor: 50, target: 65, cap: 80 },
    headphones: { floor: 15, target: 25, cap: 35 },
  },
  // The user's own wording for an alert ({ review: "Your review is needed." }), recorded with their key.
  wording: {},
  // Voices added from the user's ElevenLabs account or Sarvam's speakers (see normalize for the shape).
  custom_voices: [],
  // Claude's own lines (notify_user's message), spoken with the user's key.
  // daily_chars caps everything recorded automatically per provider per day (0 = nothing new).
  live: { enabled: true, max_chars: 160, daily_chars: 1000, fast: false },
};

const LIMITS = { wording_chars: 120, custom_voices: 30 };
const label = (s, n) => String(s ?? "").replace(/[^\p{L}\p{N} .,'&()-]/gu, "").trim().slice(0, n);

// The id a library voice gets in config and in DATA folders: "el-<voice id>", "sarvam-<speaker>".
export const libraryVoiceId = (v) => `${v.provider === "sarvam" ? "sarvam" : "el"}-${v.provider_id}`;

// Library voices: { id, provider, provider_id, name, accent, gender, fallback }. id is derived,
// fallback is the built-in voice to use when this one can't be recorded (no key, budget).
function cleanCustomVoices(list) {
  const builtin = builtinVoices();
  return (Array.isArray(list) ? list : [])
    .filter((v) => PROVIDERS.includes(v?.provider) && /^[A-Za-z0-9_-]{1,64}$/.test(v.provider_id ?? ""))
    .map((v) => ({
      id: libraryVoiceId(v),
      provider: v.provider,
      provider_id: v.provider_id,
      name: label(v.name, 40) || v.provider_id,
      accent: label(v.accent, 30),
      gender: label(v.gender, 20),
      fallback: builtin.includes(v.fallback) ? v.fallback : FALLBACK_VOICE,
    }))
    .filter((v, i, all) => all.findIndex((x) => x.id === v.id) === i)
    .slice(0, LIMITS.custom_voices);
}

const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : fallback);
const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function cleanLimits(v = {}, d, hard) {
  const cap = clamp(v.cap, 0, hard, d.cap);
  const target = clamp(v.target, 0, cap, Math.min(d.target, cap));
  const floor = clamp(v.floor, 0, target, Math.min(d.floor, target));
  return { floor, target, cap };
}

// Merge anything (file contents, a form post) onto defaults and enforce limits.
export function normalize(c = {}) {
  const d = DEFAULTS;
  const custom_voices = cleanCustomVoices(c.custom_voices);
  const voices = [...builtinVoices(), ...custom_voices.map((v) => v.id)];
  return {
    enabled: c.enabled !== false,
    voice: voices.includes(c.voice) ? c.voice : voices.includes(d.voice) ? d.voice : voices[0],
    muted_until: c.muted_until && !Number.isNaN(Date.parse(c.muted_until)) ? new Date(c.muted_until).toISOString() : null,
    location_lock: c.location_lock === true,
    locations: (Array.isArray(c.locations) ? c.locations : [])
      .filter((l) => MAC.test(l?.mac ?? ""))
      .map((l) => ({ name: String(l.name || "Unnamed").slice(0, 40), mac: l.mac.toLowerCase() }))
      .filter((l, i, all) => all.findIndex((x) => x.mac === l.mac) === i),
    statuses: Object.fromEntries(Object.keys(STATUSES).map((s) => [s, c.statuses?.[s] !== false])),
    quiet_hours: {
      enabled: c.quiet_hours?.enabled === true,
      start: isTime(c.quiet_hours?.start) ? c.quiet_hours.start : d.quiet_hours.start,
      end: isTime(c.quiet_hours?.end) ? c.quiet_hours.end : d.quiet_hours.end,
    },
    cooldown_seconds: clamp(c.cooldown_seconds, 0, 3600, d.cooldown_seconds),
    max_per_hour: clamp(c.max_per_hour, 1, 120, d.max_per_hour),
    chime: c.chime !== false,
    away: {
      enabled: c.away?.enabled !== false,
      idle_seconds: clamp(c.away?.idle_seconds, 10, 3600, d.away.idle_seconds),
    },
    calls: {
      mic: c.calls?.mic !== false,
      camera: c.calls?.camera !== false,
      focus: c.calls?.focus !== false,
    },
    project_names: {
      enabled: c.project_names?.enabled !== false,
      aliases: Object.fromEntries(
        Object.entries(c.project_names?.aliases ?? {})
          .map(([k, v]) => [String(k).slice(0, 80), String(v).replace(/[^\p{L}\p{N} .'&-]/gu, "").trim().slice(0, 40)])
          .filter(([, v]) => v),
      ),
      muted: [...new Set((Array.isArray(c.project_names?.muted) ? c.project_names.muted : []).map((s) => String(s).slice(0, 80)))],
    },
    hooks: {
      permission: c.hooks?.permission !== false,
      long_turn: c.hooks?.long_turn !== false,
      long_turn_seconds: clamp(c.hooks?.long_turn_seconds, 30, 7200, d.hooks.long_turn_seconds),
      idle_reminder: c.hooks?.idle_reminder === true,
    },
    volume: {
      auto: c.volume?.auto !== false,
      speakers: cleanLimits(c.volume?.speakers, d.volume.speakers, HARD_CAP.speakers),
      headphones: cleanLimits(c.volume?.headphones, d.volume.headphones, HARD_CAP.headphones),
    },
    wording: Object.fromEntries(
      Object.entries(c.wording ?? {})
        .filter(([id]) => id in STATUSES)
        .map(([id, t]) => [id, cleanMessage(t, LIMITS.wording_chars)])
        .filter(([id, t]) => t && t !== TEMPLATES.find((x) => x.id === id).text),
    ),
    custom_voices,
    live: {
      enabled: c.live?.enabled !== false,
      max_chars: clamp(c.live?.max_chars, 40, 400, d.live.max_chars),
      daily_chars: clamp(c.live?.daily_chars, 0, 20000, d.live.daily_chars),
      fast: c.live?.fast === true,
    },
  };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export function loadConfig() {
  const c = normalize(readJson(CONFIG, {}));
  if (!existsSync(CONFIG)) writeJson(CONFIG, c);
  return c;
}

export function saveConfig(c) {
  const clean = normalize(c);
  writeJson(CONFIG, clean);
  return clean;
}

// Every voice the user can pick: the built-in ones, then library voices they added.
export const listVoices = (c = null) => [...builtinVoices(), ...(c?.custom_voices ?? []).map((v) => v.id)];

export function builtinVoices() {
  try {
    return readdirSync(VOICES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

export const findClip = (voice, status) =>
  ["mp3", "wav", "m4a", "aiff"].map((ext) => join(VOICES, voice, `${status}.${ext}`)).find(existsSync);
export const clipFor = (voice, status) => findClip(voice, status) ?? findClip(FALLBACK_VOICE, status);

// Location = the network you're on, identified by the router's hardware (MAC)
// address. It needs no Location Services permission and nothing leaves the Mac.
// (macOS redacts the Wi-Fi name for apps without that permission.)
const MAC = /^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/i;

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

export function currentLocation(c = loadConfig(), nets = currentNetworks()) {
  const match = c.locations.find((l) => nets.some((n) => n.mac === l.mac));
  return { networks: nets, location: match?.name ?? null };
}

export function loadHistory() {
  return readJson(STATE, { history: [] }).history ?? [];
}

function record(entry) {
  const history = [{ t: new Date().toISOString(), ...entry }, ...loadHistory()].slice(0, 100);
  writeJson(STATE, { history });
}

function inQuietHours({ start, end }, now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const [s, e] = [start, end].map((t) => t.split(":").reduce((h, m) => h * 60 + Number(m)));
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e; // window may cross midnight
}

const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
// bin/media-in-use only reads device state, so it never lights the privacy indicator.
const MEDIA_HELPER = join(ROOT, "bin", "media-in-use");

export function mediaInUse() {
  try {
    return JSON.parse(execFileSync(MEDIA_HELPER, { encoding: "utf8", timeout: 2000 }));
  } catch {
    return null;
  }
}

const FOCUS_DB = join(homedir(), "Library", "DoNotDisturb", "DB");

// Whether macOS's Focus settings can be read at all. If Apple moves or changes them,
// Focus detection stops working, and this is how status and the page find out.
export function focusReadable(db = FOCUS_DB) {
  return Boolean(readJson(join(db, "ModeConfigurations.json"), null)?.data?.[0]?.modeConfigurations);
}

// What the call and Focus detectors can see right now.
export const probeDetectors = () => ({ media: mediaInUse(), helper: existsSync(MEDIA_HELPER), focus: focusReadable() });

// Switched-on detectors that can't work right now, as sentences. Empty when all is well.
// Without this, a missing helper or unreadable Focus file just means alerts play during calls.
export function detectorProblems(c = loadConfig(), probe = probeDetectors()) {
  const problems = [];
  if ((c.calls.mic || c.calls.camera) && !probe.media) {
    problems.push(probe.helper
      ? "Call detection isn't working: bin/media-in-use didn't answer."
      : "Call detection is off: the mic and camera checker isn't built. Run npm run build.");
  }
  if (c.calls.focus && !probe.focus) problems.push("Focus detection isn't working: macOS Focus settings couldn't be read.");
  return problems;
}

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

// Returns null if the alert may play, otherwise the reason it is blocked.
export function blockedReason(status, c = loadConfig(), now = Date.now()) {
  if (process.env.HEADS_UP_DISABLED === "1") return "disabled by HEADS_UP_DISABLED=1";
  if (!c.enabled) return "voice alerts are switched off";
  if (c.muted_until && Date.parse(c.muted_until) > now) return `muted until ${hhmm(c.muted_until)}`;
  if (!c.statuses[status]) return `the "${status}" alert is switched off`;
  if (c.quiet_hours.enabled && inQuietHours(c.quiet_hours, new Date(now))) return `quiet hours (${c.quiet_hours.start}–${c.quiet_hours.end})`;
  if (c.location_lock) {
    if (!c.locations.length) return "location lock is on but no locations are saved";
    if (!currentLocation(c).location) return "not at a saved location";
  }
  if (c.calls.focus) {
    const focus = activeFocus(new Date(now));
    if (focus) return `Focus is on (${focus})`;
  }
  if (c.calls.mic || c.calls.camera) {
    const m = mediaInUse();
    if (m && c.calls.camera && m.camera) return "you're on a call (camera in use)";
    if (m && c.calls.mic && m.mic) return "you're on a call (microphone in use)";
  }
  if (c.away.enabled) {
    const idle = idleSeconds();
    if (idle !== null && idle < c.away.idle_seconds) return `you're at the keyboard (active ${Math.round(idle)}s ago)`;
  }
  const played = loadHistory().filter((h) => h.result === "played").map((h) => Date.parse(h.t));
  if (played[0] && now - played[0] < c.cooldown_seconds * 1000) return `cooldown (${c.cooldown_seconds}s between alerts)`;
  if (played.filter((t) => now - t < 3600_000).length >= c.max_per_hour) return `hourly limit reached (${c.max_per_hour}/hour)`;
  return null;
}

const osa = async (script) => (await run("osascript", ["-e", script])).stdout.trim();

export async function getVolume() {
  const [vol, muted] = (await osa("set s to get volume settings\nreturn (output volume of s as text) & \",\" & (output muted of s as text)")).split(",");
  return { vol: Number(vol), muted: muted === "true" };
}

const setVolume = (vol, muted) =>
  osa(`set volume output volume ${Math.round(vol)}` + (muted === undefined ? "" : `\nset volume output muted ${muted}`));

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

// Returns the volume to use during the alert, or null to leave it alone.
export function alertVolume({ vol, muted }, limits, headphones, requested) {
  if (requested !== undefined) return Math.min(requested, limits.cap);
  if (muted || vol < limits.floor) return limits.target;
  if (headphones && vol > limits.cap) return limits.cap;
  return null;
}

// One alert plays at a time across every Claude session, through a lock file in DATA.
// The lock also holds the volume to restore, so if a process dies mid-alert the next
// alert puts the volume back first instead of leaving the Mac loud.
const PLAY_LOCK = join(DATA, "playing.lock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

async function takeOverStaleLock() {
  // Rename first so only one process handles a given stale lock.
  const mine = `${PLAY_LOCK}.${process.pid}.stale`;
  try {
    renameSync(PLAY_LOCK, mine);
  } catch {
    return; // someone else got it
  }
  const held = readJson(mine, null);
  rmSync(mine, { force: true });
  if (held?.before) await setVolume(held.before.vol, held.before.muted).catch(() => {});
}

export async function withPlayLock(fn, { waitMs = 30_000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(PLAY_LOCK, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const held = readJson(PLAY_LOCK, null);
    const age = Date.now() - (statSync(PLAY_LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    // Unreadable for a minute means it was never finished being written.
    if (held ? !alive(held.pid) : age > 60_000) {
      await takeOverStaleLock();
      continue;
    }
    if (Date.now() > deadline) throw new Error("another alert is still playing");
    await sleep(200);
  }
  try {
    return await fn((before) => writeFileSync(PLAY_LOCK, JSON.stringify({ pid: process.pid, before })));
  } finally {
    rmSync(PLAY_LOCK, { force: true });
  }
}

const play = (files, c, requested) =>
  withPlayLock(async (remember) => {
    let before = null;
    try {
      if (c.volume.auto || requested !== undefined) {
        const current = await getVolume();
        const { headphones } = await outputDevice();
        const vol = alertVolume(current, headphones ? c.volume.headphones : c.volume.speakers, headphones, requested);
        if (vol !== null) {
          before = current;
          remember(before);
          await setVolume(vol, false);
        }
      }
      for (const [i, f] of files.entries()) {
        if (i) await sleep(300);
        await run("afplay", [f]);
      }
    } finally {
      if (before) await setVolume(before.vol, before.muted).catch(() => {});
    }
  });

// Project names: "Hello from Kosh. I need your review."
const SEGMENTS = join(DATA, "segments");
const MAX_NEW_NAMES_PER_DAY = 20; // spending guard: new names synthesized per day
const GENERIC_DIRS = /^(scratch|scratchpad|tmp|temp|downloads|desktop|documents|dev|code|projects|src|repos)([-_].*)?$/i;
const ACRONYMS = new Set(["ai", "api", "ui", "ux", "ocr", "mcp", "cli", "sdk", "db", "ios", "css", "html", "seo", "llm", "pdf", "crm", "cms"]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Project for a working directory: the git repo's name (worktrees resolve to their
// main repo), else the folder name. Null for home, temp and scratch folders.
export function projectFor(cwd) {
  if (!cwd || cwd === homedir()) return null;
  let name = basename(cwd);
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common.endsWith("/.git")) name = basename(dirname(common));
  } catch {
    // not a git repo
  }
  return isProjectName(name) ? name : null;
}

// False for names that aren't worth announcing (temp, scratch, generic or hash-like folders).
export const isProjectName = (name) => Boolean(name) && !GENERIC_DIRS.test(name) && !/^[0-9a-f-]{16,}$/i.test(name);

// How a project's name is spoken: the user's alias, else "brand-bakery-hub" -> "Brand Bakery Hub".
export function spokenName(project, c = loadConfig()) {
  if (c.project_names.aliases[project]) return c.project_names.aliases[project];
  return project
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

const namesProject = (project, c) => Boolean(project && c.project_names.enabled && !c.project_names.muted.includes(project));
const projectGreeting = (project, c) => `Hello from ${spokenName(project, c)}.`;
const nameId = (project) => `hello-from-${slug(project)}`;

// Whether "Hello from <project>." is already recorded in this voice (no credits needed).
export const nameRecorded = (voice, project, c = loadConfig()) =>
  Boolean(cachedSegment(join(SEGMENTS, voice), segKey(nameId(project), projectGreeting(project, c))));

function namesMadeToday() {
  const start = new Date().setHours(0, 0, 0, 0);
  let n = 0;
  if (!existsSync(SEGMENTS)) return 0;
  for (const v of readdirSync(SEGMENTS)) {
    const dir = join(SEGMENTS, v);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (f.startsWith("hello-from-") && statSync(join(dir, f)).mtimeMs >= start) n++;
  }
  return n;
}

// The alert's words: the user's own wording if they changed it, else the built-in line.
export const textFor = (status, c = loadConfig()) => c.wording[status] ?? TEMPLATES.find((t) => t.id === status)?.text;

// The clip to play and the words in it: { file, line, live, note }. Tries what was asked for
// first (Claude's own message, a project name, edited wording, a library voice), then the
// same without the message, then without the project name, and finally the built-in track.
// Anything that needs recording uses the user's key and, unless force, the daily budget.
// note says why the first choice wasn't possible ("no ElevenLabs key").
export async function prepare(voice, status, { project = null, message = null, force = false, kind = null } = {}, c = loadConfig()) {
  const t = TEMPLATES.find((x) => x.id === status);
  const builtin = findClip(voice, status); // null for library voices
  const fallback = builtin ?? clipFor(voiceInfo(voice, c)?.fallback ?? FALLBACK_VOICE, status);
  let note = null;
  const greetings = [];
  if (namesProject(project, c)) {
    if (nameRecorded(voice, project, c) || namesMadeToday() < MAX_NEW_NAMES_PER_DAY) greetings.push({ greet: projectGreeting(project, c), greetId: nameId(project) });
    else note = `the daily limit of ${MAX_NEW_NAMES_PER_DAY} new project names is reached`;
  }
  greetings.push({ greet: greeting, greetId: "greeting", greetTrack: builtin });
  const wording = textFor(status, c);
  const messages = [{ text: wording, msgId: status, msgTrack: wording === t.text ? builtin : null }];
  if (message && (c.live.enabled || force)) messages.unshift({ text: message, msgId: "live", fast: c.live.fast, live: true });
  else if (message) note = "live messages are switched off";
  // What the characters are logged as on the page: tests, Claude's lines, names, wording or new voices.
  const kindOf = (g, m) => kind ?? (force ? "test" : m.live ? "live" : g.greetId !== "greeting" ? "names" : builtin ? "wording" : "voices");
  const budget = force ? undefined : c.live.daily_chars;
  for (const m of messages) {
    for (const g of greetings) {
      const line = `${g.greet} ${m.text}`;
      if (g.greetTrack && m.msgTrack) return { file: builtin, line, live: false, note };
      try {
        const file = await compose(voice, c, { ...g, ...m, budget, kind: kindOf(g, m) });
        return { file, line, live: Boolean(m.live), note };
      } catch (e) {
        note ??= e instanceof Skip ? e.message : `recording failed (${String(e.message).slice(0, 120)})`;
      }
    }
  }
  return { file: fallback, line: STATUSES[status], live: false, note };
}

// Characters needed to record these alerts in a voice ("Hello." + each line); 0 when
// they're built in or already recorded.
export function recordingCost(voice, c = loadConfig(), ids = Object.keys(STATUSES)) {
  const track = (id) => findClip(voice, id);
  const parts = ids.map((id) => ({ id, text: textFor(id, c), track: textFor(id, c) === TEMPLATES.find((t) => t.id === id).text ? track(id) : null }));
  return costOf(voice, [{ id: "greeting", text: greeting, track: track(ids[0]) }, ...parts]);
}

// Records these alerts in a voice now (a page action, so no daily budget). Returns the
// characters used and the first reason something couldn't be recorded.
export async function recordAlerts(voice, c = loadConfig(), ids = Object.keys(STATUSES), kind = "voices") {
  const before = recordingCost(voice, c, ids);
  let note = null;
  for (const id of ids) {
    const p = await prepare(voice, id, { force: true, kind }, c);
    if (p.note) {
      note = p.note;
      break;
    }
  }
  return { spent: before - recordingCost(voice, c, ids), note };
}

// Alerts are queued so overlapping calls never fight over the volume restore.
let queue = Promise.resolve();

// Checks guardrails, records the outcome and starts playback in the background.
// force=true (test buttons) skips the guardrails but never the volume caps.
// project: name to announce ("Hello from <project>."); message: Claude's own words to say
// instead of the alert's line (falls back to the line); meta: extra log fields.
// Returns at once; prepared resolves to what will actually play ({ line, live, note }).
export function alert(status, { repeat = 1, volume, force = false, source = "claude", voice, project = null, message = null, meta = {} } = {}) {
  if (!(status in STATUSES)) return { ok: false, error: `Unknown status "${status}". Use one of: ${Object.keys(STATUSES).join(", ")}.` };
  const c = loadConfig();
  const useVoice = voice && listVoices(c).includes(voice) ? voice : c.voice;
  if (!clipFor(voiceInfo(useVoice, c)?.fallback ?? useVoice, status)) return { ok: false, error: `Voice "${useVoice}" has no clip for "${status}".` };
  const said = message ? cleanMessage(message, c.live.max_chars) || null : null;
  const reason = force ? null : blockedReason(status, c);
  record({ status, source, ...(project && { project }), ...(said && { message: said }), ...meta, result: reason ? "skipped" : "played", ...(reason && { reason }) });
  if (reason) return { ok: true, played: false, reason };
  const vol = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : undefined;
  const times = clamp(repeat, 1, 3, 1);
  // Recording starts now, in parallel with any alert still playing; playback waits its turn.
  const prepared = prepare(useVoice, status, { project, message: said, force }, c).catch((e) => ({
    file: clipFor(FALLBACK_VOICE, status),
    line: STATUSES[status],
    live: false,
    note: e.message,
  }));
  queue = queue
    .then(async () => {
      const { file } = await prepared;
      const files = [...(c.chime && existsSync(CHIME) ? [CHIME] : []), ...Array(times).fill(file)];
      await play(files, c, vol);
    })
    .catch((e) => process.stderr.write(`heads-up: ${e.message}\n`));
  const greet = namesProject(project, c) ? projectGreeting(project, c) : greeting;
  const line = `${greet} ${said && (c.live.enabled || force) ? said : textFor(status, c)}`;
  return { ok: true, played: true, line, prepared, done: queue };
}
