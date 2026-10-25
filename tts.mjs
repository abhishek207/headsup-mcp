// Text-to-speech for heads-up, shared by tools/generate.mjs and runtime clips
// (project names, edited wording, library voices, Claude's own lines). Uses the
// user's own ElevenLabs or Sarvam key: from the environment (ELEVENLABS_API_KEY,
// SARVAM_API_KEY) or the macOS Keychain. Keys are never written to config files
// and never returned to the page.
// HEADS_UP_FAKE_TTS=1 (tests) returns a short generated tone instead of calling a provider.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.mjs";

// MCP servers and hooks can start with a minimal PATH; make system tools and Homebrew findable.
process.env.PATH = [...new Set([...(process.env.PATH ?? "").split(":").filter(Boolean), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"])].join(":");

export const VOICES = JSON.parse(readFileSync(join(ROOT, "voices.json"), "utf8"));
export const PROVIDERS = ["elevenlabs", "sarvam"];
const PAUSE_S = 0.6;

const ENV = { elevenlabs: "ELEVENLABS_API_KEY", sarvam: "SARVAM_API_KEY" };
// Our own Keychain entry first, then the generic names other tools use.
const KEYCHAIN = { elevenlabs: ["heads-up-elevenlabs", "elevenlabs-api-key"], sarvam: ["heads-up-sarvam", "sarvam-api-key"] };

function keychainRead(service) {
  if (process.env.HEADS_UP_NO_KEYCHAIN === "1") return null; // tests: never touch real keys or credits
  const r = spawnSync("security", ["find-generic-password", "-a", process.env.USER, "-s", service, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// Where a provider's key comes from ("env" | "keychain" | "shared keychain"), or null.
export function keySource(provider) {
  if (process.env[ENV[provider]]) return "env";
  const [own, shared] = KEYCHAIN[provider];
  if (keychainRead(own)) return "keychain";
  if (keychainRead(shared)) return "shared keychain";
  return null;
}

const fake = () => process.env.HEADS_UP_FAKE_TTS === "1";
export const hasKey = (provider) => fake() || keySource(provider) !== null;

function getKey(provider) {
  if (fake()) return "fake";
  return process.env[ENV[provider]] || KEYCHAIN[provider].map(keychainRead).find(Boolean) || null;
}

// Save to the Keychain through `security -i` on stdin, so the key never appears in a process list.
export function saveKey(provider, key) {
  if (!PROVIDERS.includes(provider)) throw new Error("unknown provider");
  if (!/^[A-Za-z0-9_\-.:]{10,200}$/.test(key)) throw new Error("That doesn't look like an API key");
  const r = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -a "${process.env.USER}" -s "${KEYCHAIN[provider][0]}" -l "Heads-up ${provider} API key" -w "${key}"\n`,
    encoding: "utf8",
  });
  if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error("Couldn't save to the Keychain");
}

export function deleteKey(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error("unknown provider");
  spawnSync("security", ["delete-generic-password", "-a", process.env.USER, "-s", KEYCHAIN[provider][0]]);
}

const EL = "https://api.elevenlabs.io";
const TIMEOUT_MS = 20_000;

// fast: Flash v2.5, quicker and half the credits per character; otherwise Multilingual v2,
// which the built-in clips were made with.
async function elevenlabs(voiceId, text, key, { fast = false } = {}) {
  const r = await fetch(`${EL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: fast ? "eleven_flash_v2_5" : "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { data: Buffer.from(await r.arrayBuffer()), ext: "mp3" };
}

async function sarvam(speaker, text, key) {
  const r = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "api-subscription-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, target_language_code: "en-IN", speaker, model: "bulbul:v3", speech_sample_rate: 24000 }),
  });
  if (!r.ok) throw new Error(`Sarvam ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const { audios } = await r.json();
  return { data: Buffer.from(audios[0], "base64"), ext: "wav" };
}

export const PROVIDER_NAMES = { elevenlabs: "ElevenLabs", sarvam: "Sarvam" };

// Synthesize text in a voice: a built-in voice name, or any { provider, provider_id }
// (a voice from the user's own library). Throws if the provider has no key.
export async function synth(voice, text, opts = {}) {
  const v = typeof voice === "string" ? VOICES[voice] : voice;
  if (!v || !PROVIDERS.includes(v.provider)) throw new Error(`unknown voice ${typeof voice === "string" ? voice : v?.provider_id}`);
  const key = getKey(v.provider);
  if (!key) throw new Error(`no ${PROVIDER_NAMES[v.provider]} key`);
  if (fake()) return { data: tone(0.2 + text.length / 40), ext: "wav" };
  return (v.provider === "elevenlabs" ? elevenlabs : sarvam)(v.provider_id, text, key, opts);
}

// A quiet 440 Hz tone as a WAV file, standing in for speech in tests.
function tone(seconds, rate = 24000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return b;
}

// Sarvam Bulbul v3 speakers (Sarvam has no list endpoint). Tone notes from Sarvam's docs.
export const SARVAM_SPEAKERS = [
  ["aditya", "Male", "professional, news anchor"], ["ritu", "Female", "calm, professional"], ["priya", "Female", "warm, friendly"],
  ["neha", "Female", "warm, conversational"], ["rahul", "Male", "professional, conversational"], ["pooja", "Female", "warm, friendly"],
  ["kavya", "Female", "calm, professional"], ["shreya", "Female", "calm, narration"], ["kabir", "Male", "professional, warm"],
  ["shubh", "Male", "Sarvam's default voice"], ["anand", "Male", "mature, professional"], ["tanya", "Female", "young, energetic"],
  ["gokul", "Male", "mature, narration"], ["vijay", "Male", "mature, authoritative"], ["suhani", "Female", "young, energetic"],
  ...["ashutosh", "rohan", "simran", "amit", "dev", "ishita", "ratan", "varun", "manan", "sumit", "roopa", "aayan", "advait", "tarun", "sunny", "mani", "shruti", "mohit", "kavitha", "rehan", "soham", "rupali"].map((id) => [id, "", ""]),
].map(([id, gender, about]) => ({ provider: "sarvam", provider_id: id, name: id[0].toUpperCase() + id.slice(1), accent: "Indian", gender, about, preview: null }));

// Voices the user can pick from their provider: for ElevenLabs, everything in their own
// account (premade voices plus any they added from the Voice Library). Costs nothing.
export async function providerVoices(provider) {
  if (provider === "sarvam") return SARVAM_SPEAKERS;
  if (provider !== "elevenlabs") throw new Error("unknown provider");
  const key = getKey(provider);
  if (!key) throw new Error("no ElevenLabs key");
  if (fake()) return [{ provider, provider_id: "fakeVoice123", name: "Test voice", accent: "American", gender: "Male", about: "", preview: null }];
  const voices = [];
  let token = null;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ page_size: "100", ...(token && { next_page_token: token }) });
    const r = await fetch(`${EL}/v2/voices?${q}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    for (const v of j.voices ?? []) {
      const l = v.labels ?? {};
      const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : "");
      voices.push({
        provider,
        provider_id: v.voice_id,
        name: String(v.name ?? v.voice_id).split(/\s+-\s+/)[0].slice(0, 40),
        accent: cap(l.accent),
        gender: cap(l.gender),
        about: [l.age, l.descriptive ?? l.description, l.use_case].filter(Boolean).join(", ").replace(/_/g, " "),
        preview: /^https:\/\//.test(v.preview_url ?? "") ? v.preview_url : null,
      });
    }
    if (!j.has_more || !j.next_page_token) break;
    token = j.next_page_token;
  }
  return voices;
}

// The user's ElevenLabs plan usage: { used, limit, resets } in credits, or null if the key
// can't read it (keys can be restricted). Free to call.
export async function elevenUsage() {
  const key = getKey("elevenlabs");
  if (!key || fake()) return null;
  try {
    const r = await fetch(`${EL}/v1/user/subscription`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { used: j.character_count, limit: j.character_limit, resets: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null, tier: j.tier ?? null };
  } catch {
    return null;
  }
}

// Whether ElevenLabs accepts a key, without spending credits. Restricted keys that just
// lack the "user" permission still count as valid. Sarvam has no free check: "unknown".
export async function checkKey(provider, key) {
  if (provider !== "elevenlabs" || fake()) return "unknown";
  try {
    const r = await fetch(`${EL}/v1/user/subscription`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return "valid";
    const body = await r.text();
    if (/missing_permission/i.test(body)) return "valid";
    return r.status === 401 ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}

export const hash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 8);
export const segKey = (id, text) => `${id}-${hash(text)}`;

// Cached raw segment for a key (extension depends on the provider), or null.
export function cachedSegment(segDir, key) {
  if (!existsSync(segDir)) return null;
  const f = readdirSync(segDir).find((n) => n.startsWith(`${key}.`));
  return f ? join(segDir, f) : null;
}

// greeting + fixed pause + message, edge silence trimmed, mono 44.1k, loudness -16 LUFS.
export function joinClips(greetFile, msgFile, out) {
  const trim = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse";
  const fmt = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono";
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", greetFile, "-i", msgFile,
    "-filter_complex",
    `[0:a]${fmt},${trim}[g];[1:a]${fmt},${trim}[m];anullsrc=r=44100:cl=mono,atrim=0:${PAUSE_S}[p];[g][p][m]concat=n=3:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=0.15[o]`,
    "-map", "[o]", "-ar", "44100", "-ac", "1", "-b:a", "128k", out,
  ]);
}

// Where a built-in track's 0.6s gap starts and ends.
function gapOf(track) {
  const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", track, "-af", "silencedetect=noise=-45dB:d=0.5", "-f", "null", "-"], { encoding: "utf8" });
  const start = Number(stderr.match(/silence_start: ([0-9.]+)/)?.[1]);
  const end = Number(stderr.match(/silence_end: ([0-9.]+)/)?.[1]);
  if (!end || !(start > 0)) throw new Error(`no gap found in ${track}`);
  return { start, end };
}

// The message part of a built-in track: everything after its 0.6s gap, as WAV.
export function extractMessage(track, out) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(gapOf(track).end), "-i", track, "-c:a", "pcm_s16le", out]);
}

// The greeting part of a built-in track ("Hello."): everything before its gap, as WAV.
export function extractGreeting(track, out) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", track, "-t", String(gapOf(track).start), "-c:a", "pcm_s16le", out]);
}
