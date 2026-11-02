// Shared logic for heads-up: config + guardrails, alert history, volume
// safety and playback. Used by the MCP server, the settings page and the CLI.
// config.json and state.json are re-read on every call, so edits apply at once
// to every running Claude session. Everything the OS does (playback, volume, the
// detectors, locations) comes from platform/, so these rules are the same on
// macOS, Linux and Windows.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DATA, ROOT, claudeAppData } from "./paths.mjs";
import * as platform from "./platform/index.mjs";
import { MAC } from "./platform/common.mjs";
import { Skip, cleanMessage, compose, composeStream, costOf, streamable, voiceInfo, withoutKeys } from "./speech.mjs";
import { LOCAL_VOICES } from "./local.mjs";
import { VOICE_PROVIDERS, cachedSegment, segKey } from "./tts.mjs";

export { DATA, ROOT };
export const { words: PLATFORM_WORDS, getVolume, outputDevice, currentNetworks, idleSeconds, mediaInUse, focusReadable, activeFocus } = platform;
const CONFIG = join(DATA, "config.json");
const STATE = join(DATA, "state.json");
const VOICES = join(ROOT, "voices");
const chime = () => platform.chimes.find(existsSync) ?? null;
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
  // Speak only after this long without keyboard or mouse input. Off by default: with several
  // sessions open you're usually typing in another one when this one needs you.
  away: { enabled: false, idle_seconds: 60 },
  // Stay silent while a mic or camera is in use (calls) or a Focus is on.
  calls: { mic: true, camera: true, focus: true },
  // "Hello from <project>." instead of "Hello." Opt-in: needs the user's own TTS key or the local voice.
  project_names: { enabled: false, aliases: {}, muted: [] },
  // Claude Code hooks (hook.mjs): alerts that don't depend on Claude remembering.
  hooks: { permission: true, long_turn: true, long_turn_seconds: 120, idle_reminder: false },
  volume: {
    auto: true,
    speakers: { floor: 50, target: 65, cap: 80 },
    headphones: { floor: 15, target: 25, cap: 35 },
  },
  // The user's own wording for an alert ({ review: "Your review is needed." }), recorded with their key.
  wording: {},
  // Voices added from the user's ElevenLabs account, Sarvam's speakers or the local voice (see normalize for the shape).
  custom_voices: [],
  // Claude's own lines (notify_user's message), spoken with the user's key or the local voice. Opt-in, like project names.
  // daily_chars caps everything recorded automatically per paid provider per day (0 = nothing new).
  live: { enabled: false, max_chars: 160, daily_chars: 1000, fast: false },
  // The local voice: speaking speed (1 = normal), and the longest line Claude may say with it.
  // It's free, so the limit is only a guard against runaway text; live.max_chars is for paid voices.
  local: { speed: 1, max_chars: 1000 },
  // The user's own words on how agents should use the alerts (when to call, what to say).
  // The MCP server hands them to every agent at session start; no agent files are written.
  agent_instructions: "",
};

const LIMITS = { wording_chars: 120, custom_voices: 30, agent_instructions: 1500 };
export const AGENT_INSTRUCTIONS_MAX = LIMITS.agent_instructions;
const label = (s, n) => String(s ?? "").replace(/[^\p{L}\p{N} .,'&()-]/gu, "").trim().slice(0, n);

// The id a library voice gets in config and in DATA folders: "el-<voice id>", "sarvam-<speaker>",
// "local-<Kokoro voice>".
export const libraryVoiceId = (v) => `${{ sarvam: "sarvam", local: "local" }[v.provider] ?? "el"}-${v.provider_id}`;

// Library voices: { id, provider, provider_id, name, accent, gender, fallback }. id is derived,
// fallback is the built-in voice to use when this one can't be recorded (no key, budget).
function cleanCustomVoices(list) {
  const builtin = builtinVoices();
  return (Array.isArray(list) ? list : [])
    .filter((v) => VOICE_PROVIDERS.includes(v?.provider) && /^[A-Za-z0-9_-]{1,64}$/.test(v.provider_id ?? ""))
    .filter((v) => v.provider !== "local" || LOCAL_VOICES.some((l) => l.id === v.provider_id))
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
      enabled: c.away?.enabled === true,
      idle_seconds: clamp(c.away?.idle_seconds, 10, 3600, d.away.idle_seconds),
    },
    calls: {
      mic: c.calls?.mic !== false,
      camera: c.calls?.camera !== false,
      focus: c.calls?.focus !== false,
    },
    project_names: {
      enabled: c.project_names?.enabled === true,
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
      enabled: c.live?.enabled === true,
      max_chars: clamp(c.live?.max_chars, 40, 400, d.live.max_chars),
      daily_chars: clamp(c.live?.daily_chars, 0, 20000, d.live.daily_chars),
      fast: c.live?.fast === true,
    },
    local: {
      // 0.7 to 1.5 in steps of 0.05
      speed: Number.isFinite(c.local?.speed) ? Math.min(1.5, Math.max(0.7, Math.round(c.local.speed * 20) / 20)) : d.local.speed,
      max_chars: clamp(c.local?.max_chars, 40, 2000, d.local.max_chars),
    },
    agent_instructions: cleanInstructions(c.agent_instructions),
  };
}

// Plain text, at most a few short paragraphs, with control characters and anything key-like taken out.
function cleanInstructions(s) {
  if (typeof s !== "string") return DEFAULTS.agent_instructions;
  return withoutKeys(s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, LIMITS.agent_instructions)
    .trim();
}

// What the MCP server adds to its instructions and the tool description, so every agent reads the
// user's instructions when a session starts. Empty when there are none.
export const agentInstructions = (c) =>
  c.agent_instructions
    ? "The user's own instructions for these alerts, from their Heads-up settings. Follow them when you decide whether to " +
      "call notify_user and what to say; where they differ from the general guidance, theirs win:\n" + c.agent_instructions
    : "";

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

// What the call and Focus detectors can see right now.
export const probeDetectors = () => ({ media: mediaInUse(), helper: platform.callsReady(), focus: focusReadable() });

// Switched-on detectors that can't work right now, as sentences. Empty when all is well.
// Without this, a missing helper or unreadable Focus setting just means alerts play during calls.
export function detectorProblems(c = loadConfig(), probe = probeDetectors()) {
  const problems = [];
  if ((c.calls.mic || c.calls.camera) && !probe.media) {
    problems.push(probe.helper ? "Call detection isn't working: the mic and camera check didn't answer." : `Call detection is off: ${platform.callsSetup}`);
  }
  if (c.calls.focus && !probe.focus) problems.push(`${platform.words.focus} detection isn't working: ${platform.focusUnreadable}`);
  return problems;
}

// The reason an alert is skipped while Focus (macOS) or Do Not Disturb (Linux, Windows) is on.
export const focusReason = (name) => (name === platform.words.focus ? `${name} is on` : `${platform.words.focus} is on (${name})`);

// Returns null if the alert may play, otherwise the reason it is blocked.
export function blockedReason(status, c = loadConfig(), now = Date.now()) {
  if (process.env.HEADS_UP_DISABLED === "1") return "disabled by HEADS_UP_DISABLED=1";
  if (!c.enabled) return "voice alerts are switched off";
  if (process.env.HEADS_UP_ASSUME_AUDIO !== "1" && !platform.audioReady()) return "no sound output on this machine (a remote or headless session)";
  if (c.muted_until && Date.parse(c.muted_until) > now) return `muted until ${hhmm(c.muted_until)}`;
  if (!c.statuses[status]) return `the "${status}" alert is switched off`;
  if (c.quiet_hours.enabled && inQuietHours(c.quiet_hours, new Date(now))) return `quiet hours (${c.quiet_hours.start}–${c.quiet_hours.end})`;
  if (c.location_lock) {
    if (!c.locations.length) return "location lock is on but no locations are saved";
    if (!currentLocation(c).location) return "not at a saved location";
  }
  if (c.calls.focus) {
    const focus = activeFocus(new Date(now));
    if (focus) return focusReason(focus);
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

// Only a number and a boolean ever reach the OS, even from a tampered lock file.
const setVolume = (vol, muted) => platform.setVolume(clamp(vol, 0, 100, 0), muted === undefined ? undefined : muted === true);

// Returns the volume to use during the alert, or null to leave it alone.
export function alertVolume({ vol, muted }, limits, headphones, requested) {
  if (requested !== undefined) return Math.min(requested, limits.cap);
  if (muted || vol < limits.floor) return limits.target;
  if (headphones && vol > limits.cap) return limits.cap;
  return null;
}

// One alert plays at a time across every Claude session, through a lock file in DATA.
// The lock also holds the volume to restore, so if a process dies mid-alert the next
// alert puts the volume back first instead of leaving the computer loud.
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

export async function withPlayLock(fn, { waitMs = 180_000 } = {}) { // long enough to wait out a long local line
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

// Stopping: `headsup stop`, the page's Stop button, or the mic opening mid-alert. The
// player in whichever process holds the lock gets SIGUSR2, stops the player and restores the
// volume; alerts that were already waiting when Stop was pressed are dropped too.
const STOP = join(DATA, "stop.json");
let stopCurrent = null;
let listening = false;

export function stopPlaying() {
  writeJson(STOP, { t: Date.now() });
  const held = readJson(PLAY_LOCK, null);
  if (!held?.pid || !alive(held.pid) || (process.platform !== "win32" && !isNode(held.pid))) return { stopped: false };
  if (held.pid === process.pid) stopCurrent?.("you pressed Stop");
  else if (process.platform === "win32") return { stopped: true }; // the player polls stop.json
  else {
    try {
      process.kill(held.pid, "SIGUSR2");
    } catch {
      return { stopped: false };
    }
  }
  return { stopped: true };
}

// A crashed alert can leave a lock whose pid now belongs to something else: only signal node.
const isNode = (pid) => {
  try {
    return /node/i.test(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return false;
  }
};

// Whether an alert is speaking right now (in any session).
export function isPlaying() {
  const held = readJson(PLAY_LOCK, null);
  return Boolean(held?.pid && alive(held.pid));
}

const stoppedSince = (t) => (readJson(STOP, null)?.t ?? 0) >= t;

// The mic or camera opening while an alert speaks (dictation, a call): stop at once.
function watchCalls(c, stop) {
  if (!(c.calls.mic || c.calls.camera)) return () => {};
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const m = mediaInUse();
      if (!m) return; // detector unavailable: the start-of-alert check already reported it
      if (c.calls.camera && m.camera) stop("the camera came on");
      else if (c.calls.mic && m.mic) stop("the microphone came on");
    } catch {
      // detector unavailable: the start-of-alert check already reported it
    } finally {
      busy = false;
    }
  }, 700);
  return () => clearInterval(timer);
}

// items: clip paths and pauses (ms), played in order; an async iterable when a long
// line is still being made. Resolves to null, or to why it was stopped.
const play = (items, c, requested, { since = Date.now(), force = false } = {}) =>
  withPlayLock(async (remember) => {
    if (stoppedSince(since)) return "you pressed Stop";
    let before = null;
    let child = null;
    let why = null;
    let wake = null;
    const stop = (reason) => {
      why ??= reason;
      child?.abort();
      wake?.();
    };
    stopCurrent = stop;
    // Windows has no SIGUSR2: there the player notices stop.json instead (checked below).
    if (!listening && process.platform !== "win32") {
      listening = true;
      process.on("SIGUSR2", () => stopCurrent?.("you pressed Stop"));
    }
    const unwatch = force ? () => {} : watchCalls(c, stop);
    // Stop pressed in another process: SIGUSR2 is instant; this catches it on Windows, too.
    const stopPoll = setInterval(() => stoppedSince(since) && stop("you pressed Stop"), 300);
    try {
      // No volume control on this system (Linux without pactl or wpctl, Windows without its
      // helper): play at the volume the user already has, the way any system sound would.
      const current = c.volume.auto || requested !== undefined ? await getVolume().catch(() => null) : null;
      if (current) {
        const { headphones } = await outputDevice();
        const vol = alertVolume(current, headphones ? c.volume.headphones : c.volume.speakers, headphones, requested);
        if (vol !== null) {
          before = current;
          remember(before);
          await setVolume(vol, false);
        }
      }
      // Stop must not wait for the next sentence of a long line to be made.
      const it = items[Symbol.asyncIterator]();
      const halted = new Promise((ok) => (wake = ok));
      while (!why) {
        const next = await Promise.race([it.next(), halted]);
        if (why || !next || next.done) break;
        const item = next.value;
        if (typeof item === "number") await Promise.race([sleep(item), halted]);
        else {
          child = new AbortController();
          await platform.play(item, child.signal).catch(() => {}); // a clip that won't play doesn't stop the rest
          child = null;
        }
      }
      if (why) it.return?.().catch(() => {});
      return why;
    } finally {
      unwatch();
      clearInterval(stopPoll);
      stopCurrent = null;
      if (before) await setVolume(before.vol, before.muted).catch(() => {});
    }
  });

// What one alert plays: the chime, then the clip (or a long line's pieces as they're
// made), repeated with 300 ms between.
async function* sequence(p, times, chime) {
  if (chime) yield* [chime, 300];
  let file = p.file;
  if (p.stream) {
    yield* p.stream;
    file = await p.done.catch(() => null); // the whole line, for repeats
  } else yield file;
  for (; file && times > 1; times--) yield* [300, file];
}

// Pieces handed from the recorder to the player as they're made: push() adds one, end()
// says there are no more, and iterating waits for each.
function feed() {
  const items = [];
  let ended = false;
  let wake = null;
  return {
    used: false,
    push(x) {
      items.push(x);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) yield items.shift();
        else if (ended) return;
        else await new Promise((ok) => (wake = ok));
      }
    },
  };
}

// Project names: "Hello from Kosh. I need your review."
const SEGMENTS = join(DATA, "segments");
const MAX_NEW_NAMES_PER_DAY = 20; // spending guard: new names synthesized per day
const GENERIC_DIRS = /^(scratch|scratchpad|tmp|temp|downloads|desktop|documents|dev|code|projects|src|repos)([-_].*)?$/i;
const ACRONYMS = new Set(["ai", "api", "ui", "ux", "ocr", "mcp", "cli", "sdk", "db", "ios", "css", "html", "seo", "llm", "pdf", "crm", "cms"]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The title of the chat an alert comes from, as the user sees it, so they can find the
// one that needs them. The Claude app keeps one file per Code session, named by the
// CLAUDE_CODE_HOST_SESSION_ID it gives the session's processes; plain Claude Code keeps
// a /rename title in the session's transcript. A file whose cliSessionId isn't this
// session (a `claude -p` run started inside another session) doesn't count. Null if unknown
// or generic ("Remote Control session (from a project)").
const GENERIC_TITLE = /\(from a project\)$|^(new|untitled)( (session|chat|thread))?$/i;
const tidyTitle = (t) => {
  const s = typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return s && !GENERIC_TITLE.test(s) ? s : null;
};
export function sessionTitle(env = process.env, sessionId = env.CLAUDE_CODE_SESSION_ID, home = homedir()) {
  const id = /^[\w-]{8,80}$/;
  try {
    const host = env.CLAUDE_CODE_HOST_SESSION_ID;
    if (host && id.test(host)) {
      const base = join(claudeAppData(process.platform, env, home), "claude-code-sessions");
      const [acct, org] = [env.CLAUDE_CODE_ACCOUNT_UUID, env.CLAUDE_CODE_ORGANIZATION_UUID];
      const dirs = acct && org && id.test(acct) && id.test(org) && existsSync(join(base, acct, org))
        ? [join(base, acct, org)]
        : readdirSync(base).flatMap((a) => readdirSync(join(base, a)).map((o) => join(base, a, o)));
      for (const d of dirs) {
        const file = [`${host}.json`, `local_${host}.json`].map((f) => join(d, f)).find((f) => existsSync(f));
        const s = file && readJson(file, null);
        if (s && (!sessionId || !s.cliSessionId || s.cliSessionId === sessionId)) return tidyTitle(s.title);
      }
    }
    if (sessionId && id.test(sessionId)) {
      const projects = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
      for (const d of readdirSync(projects)) {
        const f = join(projects, d, `${sessionId}.jsonl`);
        const size = statSync(f, { throwIfNoEntry: false })?.size;
        if (!size || size > 50_000_000) continue;
        let title = null;
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.includes('"custom-title"')) continue;
          try {
            title = JSON.parse(line).customTitle ?? title;
          } catch {}
        }
        return tidyTitle(title);
      }
    }
  } catch {
    // no title is fine; the alert still names the project
  }
  return null;
}

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

// False for names that aren't worth announcing (temp, scratch, generic, hash-like or dated folders).
export const isProjectName = (name) => Boolean(name) && !GENERIC_DIRS.test(name) && !/^[0-9a-f-]{16,}$/i.test(name) && !/^\d{4}-\d{2}(-\d{2})?\b/.test(name);

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
// The local voice needs neither, so it has no daily cap on new names either.
// note says why the first choice wasn't possible ("no ElevenLabs key").
// stream (a feed from alert): lets a long local line start playing after its first sentence;
// the result then has stream (the pieces) and done (the finished clip) instead of file.
export async function prepare(voice, status, { project = null, message = null, force = false, kind = null, stream = null } = {}, c = loadConfig()) {
  const t = TEMPLATES.find((x) => x.id === status);
  const builtin = findClip(voice, status); // null for library voices
  const fallback = builtin ?? clipFor(voiceInfo(voice, c)?.fallback ?? FALLBACK_VOICE, status);
  const free = voiceInfo(voice, c)?.provider === "local";
  let note = null;
  const greetings = [];
  if (namesProject(project, c)) {
    if (free || nameRecorded(voice, project, c) || namesMadeToday() < MAX_NEW_NAMES_PER_DAY) greetings.push({ greet: projectGreeting(project, c), greetId: nameId(project) });
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
      const o = { ...g, ...m, budget, kind: kindOf(g, m) };
      if (stream && !stream.used && m.live && streamable(voice, c, o)) {
        stream.used = true; // one try: a failure falls back to the clips below
        let started;
        const first = new Promise((ok) => (started = ok));
        let playing = false;
        const done = composeStream(voice, c, o, (x) => ((playing = true), started(), stream.push(x))).finally(() => stream.end());
        done.catch(() => {}); // a failure after playback started just ends the line early
        try {
          await Promise.race([first, done]);
          if (playing) return { stream, done, line, live: true, note };
        } catch (e) {
          note ??= `recording failed (${String(e.message).slice(0, 120)})`;
          continue;
        }
      }
      try {
        const file = await compose(voice, c, o);
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
// The longest line Claude may say in a voice: the local voice's own limit, else the paid one.
export const maxChars = (voice, c) => (voiceInfo(voice, c)?.provider === "local" ? c.local.max_chars : c.live.max_chars);

export function alert(status, { repeat = 1, volume, force = false, source = "claude", voice, project = null, title = null, message = null, meta = {} } = {}) {
  if (!(status in STATUSES)) return { ok: false, error: `Unknown status "${status}". Use one of: ${Object.keys(STATUSES).join(", ")}.` };
  const c = loadConfig();
  const useVoice = voice && listVoices(c).includes(voice) ? voice : c.voice;
  if (!clipFor(voiceInfo(useVoice, c)?.fallback ?? useVoice, status)) return { ok: false, error: `Voice "${useVoice}" has no clip for "${status}".` };
  // The chat's title goes first, so the user knows which one needs them: always with the
  // free local voice, and with a paid one only when a line is being recorded anyway.
  const thread = typeof title === "string" ? title.trim() : "";
  const titled = thread && !(message ?? "").toLowerCase().includes(thread.toLowerCase()) && (message || voiceInfo(useVoice, c)?.provider === "local");
  const text = titled ? `Thread: ${thread}. ${message ?? textFor(status, c)}` : message;
  const said = text ? cleanMessage(text, maxChars(useVoice, c)) || null : null;
  const reason = force ? null : blockedReason(status, c);
  record({ status, source, ...(project && { project }), ...(thread && { thread }), ...(said && { message: said }), ...meta, result: reason ? "skipped" : "played", ...(reason && { reason }) });
  if (reason) return { ok: true, played: false, reason };
  const vol = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : undefined;
  const times = clamp(repeat, 1, 3, 1);
  // Recording starts now, in parallel with any alert still playing; playback waits its turn.
  const stream = feed();
  const prepared = prepare(useVoice, status, { project, message: said, force, stream }, c).catch((e) => ({
    file: clipFor(FALLBACK_VOICE, status),
    line: STATUSES[status],
    live: false,
    note: e.message,
  }));
  const since = Date.now();
  queue = queue
    .then(async () => {
      const p = await prepared;
      const bell = c.chime ? chime() : null;
      const stopped = await play(sequence(p, times, bell), c, vol, { since, force });
      if (stopped) record({ status, source, ...(project && { project }), result: "stopped", reason: stopped });
    })
    .catch((e) => process.stderr.write(`heads-up: ${e.message}\n`));
  const greet = namesProject(project, c) ? projectGreeting(project, c) : greeting;
  const line = `${greet} ${said && (c.live.enabled || force) ? said : textFor(status, c)}`;
  return { ok: true, played: true, line, prepared, done: queue };
}
