#!/usr/bin/env node
// Builds voices/<voice>/<template>.mp3 from templates.json and voices.json.
// The greeting and each message are synthesized separately, then joined with a
// fixed pause and loudness-normalized with ffmpeg, so every voice sounds alike.
// Raw segments are cached in DATA/segments/<voice>/, keyed by their text, so
// changing the greeting or one message only pays for what changed.
//
//   node tools/generate.mjs --dry-run            count characters, call nothing
//   node tools/generate.mjs                      generate missing tracks
//   node tools/generate.mjs --force              rebuild all tracks (reuses cached segments)
//   node tools/generate.mjs --extract            recover message segments from existing tracks
//   node tools/generate.mjs --voice american-male --force
//
// Uses your own ElevenLabs / Sarvam key (environment or Keychain; see tts.mjs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../paths.mjs";
import { VOICES, cachedSegment, extractMessage, joinClips, segKey, synth } from "../tts.mjs";

const { greeting, templates } = JSON.parse(readFileSync(join(ROOT, "templates.json"), "utf8"));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const extract = args.includes("--extract");
const only = args.includes("--voice") ? args[args.indexOf("--voice") + 1] : null;

async function segment(name, provider, segDir, key, text, usage) {
  const hit = cachedSegment(segDir, key);
  if (hit) return hit;
  usage[provider] += text.length;
  if (dryRun) return null;
  const { data, ext } = await synth(name, text);
  const file = join(segDir, `${key}.${ext}`);
  writeFileSync(file, data);
  return file;
}

const usage = { elevenlabs: 0, sarvam: 0 };
let made = 0;
for (const [name, voice] of Object.entries(VOICES)) {
  if (only && name !== only) continue;
  const dir = join(ROOT, "voices", name);
  const segDir = join(DATA, "segments", name);
  mkdirSync(segDir, { recursive: true });

  if (extract) {
    for (const t of templates) {
      const track = join(dir, `${t.id}.mp3`);
      const key = segKey(t.id, t.text);
      if (existsSync(track) && !cachedSegment(segDir, key)) extractMessage(track, join(segDir, `${key}.wav`));
    }
    console.log(`${name}: message segments extracted`);
    continue;
  }

  const todo = templates.filter((t) => force || !existsSync(join(dir, `${t.id}.mp3`)));
  if (!todo.length) continue;
  const before = usage[voice.provider];
  const gFile = await segment(name, voice.provider, segDir, segKey("greeting", greeting), greeting, usage);
  mkdirSync(dir, { recursive: true });
  for (const t of todo) {
    const mFile = await segment(name, voice.provider, segDir, segKey(t.id, t.text), t.text, usage);
    if (dryRun) continue;
    joinClips(gFile, mFile, join(dir, `${t.id}.mp3`));
    made++;
    process.stdout.write(`\r${name}: ${todo.indexOf(t) + 1}/${todo.length}`);
  }
  if (dryRun) console.log(`${name.padEnd(16)} ${voice.provider.padEnd(10)} ${todo.length} tracks, ${usage[voice.provider] - before} new chars`);
  else console.log();
}
if (!extract) console.log(`${dryRun ? "Would use" : `Made ${made} tracks, used`} ~${usage.elevenlabs} ElevenLabs chars, ~${usage.sarvam} Sarvam chars`);
