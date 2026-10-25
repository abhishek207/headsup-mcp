// Text-to-speech for heads-up, shared by tools/generate.mjs and runtime clips
// (project names). Uses the user's own ElevenLabs or Sarvam key: from the
// environment (ELEVENLABS_API_KEY, SARVAM_API_KEY) or the macOS Keychain.
// Keys are never written to config files and never returned to the page.

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

export const hasKey = (provider) => keySource(provider) !== null;

function getKey(provider) {
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

async function elevenlabs(voiceId, text, key) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { data: Buffer.from(await r.arrayBuffer()), ext: "mp3" };
}

async function sarvam(speaker, text, key) {
  const r = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, target_language_code: "en-IN", speaker, model: "bulbul:v3", speech_sample_rate: 24000 }),
  });
  if (!r.ok) throw new Error(`Sarvam ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const { audios } = await r.json();
  return { data: Buffer.from(audios[0], "base64"), ext: "wav" };
}

// Synthesize text in one of our voices. Throws if the voice's provider has no key.
export async function synth(voiceName, text) {
  const v = VOICES[voiceName];
  if (!v) throw new Error(`unknown voice ${voiceName}`);
  const key = getKey(v.provider);
  if (!key) throw new Error(`No ${v.provider} API key. Add one on the settings page.`);
  return (v.provider === "elevenlabs" ? elevenlabs : sarvam)(v.provider_id, text, key);
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

// The message part of a built-in track: everything after its 0.6s gap, as WAV.
export function extractMessage(track, out) {
  const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", track, "-af", "silencedetect=noise=-45dB:d=0.5", "-f", "null", "-"], { encoding: "utf8" });
  const end = Number(stderr.match(/silence_end: ([0-9.]+)/)?.[1]);
  if (!end) throw new Error(`no gap found in ${track}`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(end), "-i", track, "-c:a", "pcm_s16le", out]);
}
