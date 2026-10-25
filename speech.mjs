// Recorded speech beyond the 140 built-in clips: edited wording, voices from the
// user's own provider library, project names and Claude's own lines (live
// messages). Every recording goes through compose(): segments are cached by their
// text, so a line is paid for once, and every character spent is logged in
// DATA/usage.json so the page can show what it cost.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA } from "./paths.mjs";
import { PROVIDERS, PROVIDER_NAMES, VOICES, cachedSegment, extractGreeting, extractMessage, hasKey, joinClips, segKey, synth } from "./tts.mjs";

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
  const mixed = (part) => part.length >= 6 && /\d/.test(part) && /[A-Za-z]/.test(part);
  if (core.length >= 20 && /^[\w+/=.-]+$/.test(core) && core.split(/[-_.]/).some(mixed)) return `${lead}a code${tail}`;
  return word;
}

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

const keyOf = (id, text, fast) => segKey(id, text) + (fast ? "-fast" : "");

// Characters a recording would cost: the parts not already cached or cut from a built-in track.
export function costOf(voice, parts) {
  const dir = join(SEGMENTS, voice);
  return parts
    .filter((p) => !(p.track && existsSync(p.track)) && !cachedSegment(dir, keyOf(p.id, p.text, p.fast)))
    .reduce((n, p) => n + p.text.length, 0);
}

const clipPath = (voice, o) => join(CLIPS, voice, segKey(o.greetId, o.greet), `${keyOf(o.msgId, o.text, o.fast)}.mp3`);
export const composed = (voice, o) => (existsSync(clipPath(voice, o)) ? clipPath(voice, o) : null);

async function segment(voice, info, { id, text, track, part, fast }, kind) {
  const dir = join(SEGMENTS, voice);
  const key = keyOf(id, text, fast);
  const hit = cachedSegment(dir, key);
  if (hit) return hit;
  mkdirSync(dir, { recursive: true });
  if (track && existsSync(track)) {
    const out = join(dir, `${key}.wav`);
    (part === "greeting" ? extractGreeting : extractMessage)(track, out);
    return out;
  }
  const { data, ext } = await synth(info, text, { fast });
  spend(info.provider, text.length, kind);
  const out = join(dir, `${key}.${ext}`);
  writeFileSync(out, data);
  return out;
}

// Greeting + 0.6s + message in a voice, cached as one clip. o: { greet, greetId, greetTrack,
// text, msgId, msgTrack, fast, budget, kind }. budget: today's character limit for this
// provider (leave out for things the user asked for on the page). Throws Skip when it
// can't record without breaking a limit, or the provider's error.
export async function compose(voice, c, o) {
  const out = clipPath(voice, o);
  if (existsSync(out)) return out;
  const info = voiceInfo(voice, c);
  if (!info) throw new Skip(`unknown voice ${voice}`);
  const parts = [
    { id: o.greetId, text: o.greet, track: o.greetTrack, part: "greeting" },
    { id: o.msgId, text: o.text, track: o.msgTrack, part: "message", fast: o.fast },
  ];
  const cost = costOf(voice, parts);
  if (cost) {
    const name = PROVIDER_NAMES[info.provider];
    if (!hasKey(info.provider)) throw new Skip(`no ${name} key`);
    if (o.budget !== undefined && spentToday(info.provider) + cost > o.budget) throw new Skip(`it would go over today's ${name} budget of ${o.budget} characters`);
  }
  const [g, m] = [await segment(voice, info, parts[0], o.kind), await segment(voice, info, parts[1], o.kind)];
  mkdirSync(dirname(out), { recursive: true });
  joinClips(g, m, out);
  if (o.msgId === "live") {
    prune(join(SEGMENTS, voice), "live-");
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
