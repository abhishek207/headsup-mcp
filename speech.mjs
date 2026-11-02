// Recorded speech beyond the 140 built-in clips: edited wording, voices from the
// user's own provider library, project names and Claude's own lines (live
// messages). Every recording goes through compose(): segments are cached by their
// text, so a line is paid for once, and every character spent is logged in
// DATA/usage.json so the page can show what it cost. The local voice costs nothing,
// so it has no budget and isn't logged.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA } from "./paths.mjs";
import { PAUSE_MS, PROVIDERS, PROVIDER_NAMES, VOICES, cachedSegment, concatClips, extractGreeting, extractMessage, hasKey, joinClips, levelClip, localParts, segKey, synth } from "./tts.mjs";

const SEGMENTS = join(DATA, "segments");
const CLIPS = join(DATA, "cache", "clips");
const USAGE = join(DATA, "usage.json");
const KEEP_LIVE = 300; // live lines kept per voice; older ones are re-recorded if Claude says them again

// A reason to fall back to another clip (no key, budget used up), as opposed to a failure.
export class Skip extends Error {}

// Provider details for a built-in voice or a library voice the user added.
export const voiceInfo = (voice, c) => VOICES[voice] ?? c.custom_voices.find((v) => v.id === voice) ?? null;

// A word that shouldn't be read out or sent to a voice provider, said plainly instead:
// email addresses, file paths, and keys, tokens or hashes. Everything else stays as it is.
function plainWord(word) {
  const [, lead, core, tail] = word.match(/^([("'“‘]*)(.*?)([)"'”’.,;:!?]*)$/s);
  if (/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(core)) return `${lead}an email address${tail}`;
  const slashes = core.split("/").length - 1;
  if (slashes && (/^(~|\.{1,2})?\//.test(core) || slashes > 1 || /\/[^/]*\.\w{1,5}$/.test(core))) return `${lead}a file${tail}`;
  if (looksLikeKey(core)) return `${lead}a code${tail}`;
  return word;
}

// A key, token or hash: a long run of word characters with a part that mixes letters and digits.
function looksLikeKey(core) {
  const mixed = (part) => part.length >= 6 && /\d/.test(part) && /[A-Za-z]/.test(part);
  return core.length >= 20 && /^[\w+/=.-]+$/.test(core) && core.split(/[-_.]/).some(mixed);
}

// Text kept as written (the user's instructions for agents), minus anything that looks like a key.
export const withoutKeys = (text) =>
  String(text ?? "").replace(/\S+/g, (word) => {
    const [, lead, core, tail] = word.match(/^([("'“‘]*)(.*?)([)"'”’.,;:!?]*)$/s);
    return looksLikeKey(core) ? `${lead}[removed]${tail}` : word;
  });

// Claude's text made speakable: no code, links, paths, keys or markdown, one line, at most
// max characters (cut at a word), ending in punctuation. Empty if nothing speakable is left.
export function cleanMessage(text, max = 160) {
  let s = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\S+/g, plainWord)
    .replace(/[*#>~|[\]{}<>\\^=]/g, " ")
    .replace(/(^|\s)_+|_+(\s|$)/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return "";
  if (s.length > max) {
    s = s.slice(0, max - 1);
    const cut = s.lastIndexOf(" ");
    s = (cut > max * 0.6 ? s.slice(0, cut) : s).replace(/[\s,;:–-]+$/, "");
  }
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// Usage log: characters sent to each provider per local day, and what for.
const day = (d = new Date()) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD

function readUsage() {
  try {
    return JSON.parse(readFileSync(USAGE, "utf8"));
  } catch {
    return { days: {} };
  }
}

export function spend(provider, chars, kind = "other") {
  const u = readUsage();
  const d = (u.days[day()] ??= { by: {} });
  d[provider] = (d[provider] ?? 0) + chars;
  d.by[kind] = (d.by[kind] ?? 0) + chars;
  const keep = Object.keys(u.days).sort().slice(-62);
  u.days = Object.fromEntries(keep.map((k) => [k, u.days[k]]));
  const tmp = `${USAGE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(u, null, 2) + "\n");
  renameSync(tmp, USAGE);
}

export const spentToday = (provider) => readUsage().days[day()]?.[provider] ?? 0;

// { today, month } per provider, plus today's split by kind (live, names, wording, voices, test).
export function usageSummary() {
  const { days } = readUsage();
  const month = day().slice(0, 7);
  const sum = (keys) => Object.fromEntries(PROVIDERS.map((p) => [p, keys.reduce((n, k) => n + (days[k]?.[p] ?? 0), 0)]));
  return { today: sum([day()]), month: sum(Object.keys(days).filter((k) => k.startsWith(month))), by: days[day()]?.by ?? {} };
}

// Cache key of a segment. Lines in the local voice at another speed are kept apart.
const keyOf = (id, text, fast, speed = 1) => segKey(id, text) + (fast ? "-fast" : "") + (speed !== 1 ? `-x${speed}` : "");
// The speed a voice speaks at: the local voice's setting, 1 for everything else.
const speedOf = (voice, c) => (voiceInfo(voice, c)?.provider === "local" ? (c.local?.speed ?? 1) : 1);

// Characters a recording would cost: the parts not already cached or cut from a built-in track.
export function costOf(voice, parts) {
  const dir = join(SEGMENTS, voice);
  return parts
    .filter((p) => !(p.track && existsSync(p.track)) && !cachedSegment(dir, keyOf(p.id, p.text, p.fast, p.speed)))
    .reduce((n, p) => n + p.text.length, 0);
}

const clipPath = (voice, o) => join(CLIPS, voice, keyOf(o.greetId, o.greet, false, o.speed), `${keyOf(o.msgId, o.text, o.fast, o.speed)}.mp3`);
// The clip if it's already made (c: config, for the local voice's speed).
export function composed(voice, o, c) {
  const out = clipPath(voice, c ? { ...o, speed: speedOf(voice, c) } : o);
  return existsSync(out) ? out : null;
}

async function segment(voice, info, { id, text, track, part, fast, speed }, kind) {
  const dir = join(SEGMENTS, voice);
  const key = keyOf(id, text, fast, speed);
  const hit = cachedSegment(dir, key);
  if (hit) return hit;
  mkdirSync(dir, { recursive: true });
  if (track && existsSync(track)) {
    const out = join(dir, `${key}.wav`);
    (part === "greeting" ? extractGreeting : extractMessage)(track, out);
    return out;
  }
  const { data, ext } = await synth(info, text, { fast, speed });
  if (info.provider !== "local") spend(info.provider, text.length, kind); // the local voice is free
  const out = join(dir, `${key}.${ext}`);
  writeFileSync(out, data);
  return out;
}

// Greeting + 0.6s + message in a voice, cached as one clip. o: { greet, greetId, greetTrack,
// text, msgId, msgTrack, fast, budget, kind }. budget: today's character limit for this
// provider (leave out for things the user asked for on the page; the local voice has none).
// Throws Skip when it can't record without breaking a limit, or the provider's error.
export async function compose(voice, c, o) {
  const speed = speedOf(voice, c);
  const out = clipPath(voice, { ...o, speed });
  if (existsSync(out)) return out;
  const info = voiceInfo(voice, c);
  if (!info) throw new Skip(`unknown voice ${voice}`);
  const parts = [
    { id: o.greetId, text: o.greet, track: o.greetTrack, part: "greeting", speed },
    { id: o.msgId, text: o.text, track: o.msgTrack, part: "message", fast: o.fast, speed },
  ];
  const cost = costOf(voice, parts);
  if (cost) {
    const name = PROVIDER_NAMES[info.provider];
    if (!hasKey(info.provider)) throw new Skip(info.provider === "local" ? "the local voice isn't downloaded" : `no ${name} key`);
    if (info.provider !== "local" && o.budget !== undefined && spentToday(info.provider) + cost > o.budget) throw new Skip(`it would go over today's ${name} budget of ${o.budget} characters`);
  }
  const [g, m] = [await segment(voice, info, parts[0], o.kind), await segment(voice, info, parts[1], o.kind)];
  mkdirSync(dirname(out), { recursive: true });
  joinClips(g, m, out, { local: info.provider === "local" });
  if (o.msgId === "live") {
    prune(join(SEGMENTS, voice), "live-");
    prune(dirname(out), "live-");
  }
  return out;
}

// A script's sentences, for playing a long local line while the rest is being made.
// A short sentence is joined to the next so the speech doesn't sound chopped.
export function sentences(text) {
  const out = [];
  for (const s of text.split(/(?<!\b(?:e\.g|i\.e|vs|Mr|Mrs|Ms|Dr)\.)(?<=[.!?][)"'\]”’]*)\s+/).map((x) => x.trim()).filter(Boolean)) {
    if (out.length && out[out.length - 1].length < 40) out[out.length - 1] += " " + s;
    else out.push(s);
  }
  return out;
}

// Whether a line can be streamed: Claude's own words in the local voice, not made yet,
// and longer than one sentence.
export const streamable = (voice, c, o) =>
  voiceInfo(voice, c)?.provider === "local" && !composed(voice, o, c) && hasKey("local") && sentences(o.text).length > 1;

const STREAM = join(DATA, "cache", "stream");
// Like compose, for a long line in the local voice: the model makes it sentence by sentence
// and push() gets each piece as soon as it's ready (WAVs at clip loudness, with the 0.6 s
// pause as a number of ms), so playback starts after the first sentence instead of the last.
// Resolves to the finished clip, cached like any other. The pieces stay until the next
// stream, ten minutes on, since they may still be playing.
export async function composeStream(voice, c, o, push) {
  const speed = speedOf(voice, c);
  const info = voiceInfo(voice, c);
  const out = clipPath(voice, { ...o, speed });
  const dir = join(SEGMENTS, voice);
  const greetKey = keyOf(o.greetId, o.greet, false, speed);
  const msgKey = keyOf(o.msgId, o.text, o.fast, speed);
  mkdirSync(STREAM, { recursive: true });
  for (const d of readdirSync(STREAM)) {
    const p = join(STREAM, d);
    if (Date.now() - statSync(p).mtimeMs > 600_000) rmSync(p, { recursive: true, force: true });
  }
  const tmp = join(STREAM, `play-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  let n = 0;
  const send = (file) => {
    const f = join(tmp, `${n++}.wav`);
    levelClip(file, f);
    push(f);
  };
  const greetHit = cachedSegment(dir, greetKey);
  if (greetHit) (send(greetHit), push(PAUSE_MS));
  const texts = [...(greetHit ? [] : [o.greet]), ...sentences(o.text)];
  const { files, dir: made } = await localParts(info.provider_id, texts, speed, (file, i) => {
    send(file);
    if (!greetHit && i === 0) push(PAUSE_MS);
  });
  try {
    mkdirSync(dir, { recursive: true });
    const greetSeg = greetHit ?? join(dir, `${greetKey}.wav`);
    if (!greetHit) renameSync(files[0], greetSeg);
    const msgSeg = join(dir, `${msgKey}.wav`);
    concatClips(files.slice(greetHit ? 0 : 1), msgSeg);
    mkdirSync(dirname(out), { recursive: true });
    joinClips(greetSeg, msgSeg, out, { local: true });
  } finally {
    rmSync(made, { recursive: true, force: true });
  }
  if (o.msgId === "live") {
    prune(dir, "live-");
    prune(dirname(out), "live-");
  }
  return out;
}

function prune(dir, prefix) {
  try {
    const files = readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => join(dir, f));
    if (files.length <= KEEP_LIVE) return;
    files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    for (const f of files.slice(0, files.length - KEEP_LIVE)) rmSync(f, { force: true });
  } catch {
    // pruning is housekeeping; never fail a clip over it
  }
}
