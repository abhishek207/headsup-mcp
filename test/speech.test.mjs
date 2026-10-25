import { DATA, optedIn, quiet } from "./helpers.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

const core = await import("../core.mjs");
const speech = await import("../speech.mjs");
const { normalize, prepare, recordingCost, recordAlerts, textFor } = core;
const { cleanMessage, usageSummary } = speech;

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const needsFfmpeg = { skip: !ffmpeg && "ffmpeg not installed" };
// Fake TTS (a generated tone) stands in for the provider; unset it to act as "no key".
const withTts = async (fn) => {
  process.env.HEADS_UP_FAKE_TTS = "1";
  try {
    return await fn();
  } finally {
    delete process.env.HEADS_UP_FAKE_TTS;
  }
};
const noKeys = () => {
  for (const k of ["ELEVENLABS_API_KEY", "SARVAM_API_KEY", "HEADS_UP_FAKE_TTS"]) delete process.env[k];
};
const spent = () => usageSummary().today.elevenlabs;

test("messages are cleaned before they're spoken", () => {
  assert.equal(cleanMessage("The `migrate` step ran; see https://example.com/x for **details**"), "The migrate step ran; see a link for details.");
  assert.equal(cleanMessage("```js\nrm -rf /\n```"), "");
  assert.equal(cleanMessage("  Done!  "), "Done!");
  assert.equal(cleanMessage("line one\nline two"), "line one line two.");
  const long = cleanMessage("word ".repeat(100), 60);
  assert.ok(long.length <= 60, long);
  assert.match(long, /word\.$/, "cut at a word, ends with a full stop");
});

test("normalize: wording, library voices and live settings", () => {
  const c = normalize({
    wording: { review: "  Come and look  ", nope: "x", completed: "I've completed the task.", error: "```code```" },
    custom_voices: [
      { provider: "elevenlabs", provider_id: "abc123", name: "Rachel<script>", fallback: "british-male" },
      { provider: "elevenlabs", provider_id: "abc123" },
      { provider: "openai", provider_id: "x" },
      { provider: "sarvam", provider_id: "bad id!" },
    ],
    voice: "el-abc123",
    live: { max_chars: 5000, daily_chars: -5, fast: "yes" },
  });
  assert.deepEqual(c.wording, { review: "Come and look." }, "unknown, unchanged and unspeakable lines are dropped");
  assert.equal(c.custom_voices.length, 1);
  assert.deepEqual(c.custom_voices[0], { id: "el-abc123", provider: "elevenlabs", provider_id: "abc123", name: "Rachelscript", accent: "", gender: "", fallback: "british-male" });
  assert.equal(c.voice, "el-abc123", "a library voice can be selected");
  assert.deepEqual(c.live, { enabled: false, max_chars: 400, daily_chars: 0, fast: false });
  assert.equal(normalize({ voice: "el-gone" }).voice, "american-male", "a removed library voice falls back");
  assert.equal(textFor("review", c), "Come and look.");
});

test("built-in alerts need no key and no recording", async () => {
  noKeys();
  const p = await prepare("american-male", "review", {}, normalize(quiet));
  assert.match(p.file, /voices\/american-male\/review\.mp3$/);
  assert.equal(p.line, "Hello. I need your review.");
  assert.equal(p.note, null);
});

test("Claude's own line: recorded once, cached, counted", needsFfmpeg, () =>
  withTts(async () => {
    const c = normalize(optedIn);
    const before = spent();
    const msg = "The migration ran, but two tables need your review.";
    const p = await prepare("american-male", "review", { message: msg }, c);
    assert.equal(p.live, true);
    assert.equal(p.line, `Hello. ${msg}`);
    assert.ok(existsSync(p.file));
    assert.equal(spent() - before, msg.length, "only the message is paid for; Hello is cut from the built-in track");
    assert.equal(usageSummary().by.live >= msg.length, true);
    const again = await prepare("american-male", "review", { message: msg }, c);
    assert.equal(again.file, p.file);
    assert.equal(spent() - before, msg.length, "a repeated line costs nothing");
  }));

test("Claude's own line falls back to the alert when it can't be recorded", async () => {
  noKeys();
  const msg = "Two tables need your review.";
  let p = await prepare("american-male", "review", { message: msg }, normalize(optedIn));
  assert.equal(p.live, false);
  assert.equal(p.line, "Hello. I need your review.");
  assert.equal(p.note, "no ElevenLabs key");

  p = await prepare("american-male", "review", { message: msg }, normalize({ ...quiet, live: { enabled: false } }));
  assert.equal(p.note, "live messages are switched off");

  await withTts(async () => {
    p = await prepare("american-male", "review", { message: "x".repeat(30) + " more words here" }, normalize({ ...quiet, live: { enabled: true, daily_chars: 10 } }));
    assert.equal(p.live, false);
    assert.match(p.note, /budget of 10 characters/);
  });
});

test("a test from the page ignores the daily budget and the live switch", needsFfmpeg, () =>
  withTts(async () => {
    const p = await prepare("american-male", "completed", { message: "Testing my key now.", force: true }, normalize({ ...quiet, live: { enabled: false, daily_chars: 0 } }));
    assert.equal(p.live, true);
    assert.equal(usageSummary().by.test >= 19, true);
  }));

test("edited wording is recorded, and falls back to the original without a key", needsFfmpeg, async () => {
  const c = normalize({ ...quiet, wording: { review: "Your review is needed." } });
  noKeys();
  let p = await prepare("american-male", "review", {}, c);
  assert.equal(p.line, "Hello. I need your review.");
  assert.equal(p.note, "no ElevenLabs key");
  assert.equal(recordingCost("american-male", c), "Your review is needed.".length);
  await withTts(async () => {
    p = await prepare("american-male", "review", {}, c);
    assert.equal(p.line, "Hello. Your review is needed.");
    assert.equal(p.note, null);
    assert.equal(recordingCost("american-male", c), 0);
  });
});

test("library voice: costed, recorded on demand, falls back to its built-in voice", needsFfmpeg, async () => {
  const c = normalize({ ...quiet, custom_voices: [{ provider: "elevenlabs", provider_id: "lib1", fallback: "british-female" }], voice: "el-lib1" });
  const all = recordingCost("el-lib1", c);
  assert.ok(all > 400, `all 20 lines plus Hello (${all})`);
  noKeys();
  let p = await prepare("el-lib1", "completed", {}, c);
  assert.match(p.file, /voices\/british-female\/completed\.mp3$/);
  await withTts(async () => {
    p = await prepare("el-lib1", "completed", {}, c);
    assert.match(p.file, /cache\/clips\/el-lib1\//);
    const r = await recordAlerts("el-lib1", c);
    assert.equal(r.note, null);
    assert.equal(r.spent, all - "Hello.".length - "I've completed the task.".length);
    assert.equal(recordingCost("el-lib1", c), 0);
  });
});

test("project names: recorded once per voice", needsFfmpeg, () =>
  withTts(async () => {
    const c = normalize(optedIn);
    const p = await prepare("american-male", "review", { project: "brand-bakery-hub" }, c);
    assert.equal(p.line, "Hello from Brand Bakery Hub. I need your review.");
    assert.equal(core.nameRecorded("american-male", "brand-bakery-hub", c), true);
    const muted = normalize({ ...quiet, project_names: { enabled: true, muted: ["brand-bakery-hub"] } });
    assert.equal((await prepare("american-male", "review", { project: "brand-bakery-hub" }, muted)).line, "Hello. I need your review.");
  }));

test("out of the box: no project names and no own lines, only the built-in clip", async () => {
  noKeys();
  const p = await prepare("american-male", "review", { project: "brand-bakery-hub", message: "Two tables need your review." }, normalize(quiet));
  assert.match(p.file, /voices\/american-male\/review\.mp3$/);
  assert.equal(p.line, "Hello. I need your review.");
  assert.equal(p.note, "live messages are switched off");
});

test("alert records Claude's message and reports what will play", async () => {
  noKeys();
  process.env.HEADS_UP_DISABLED = "1";
  try {
    const r = core.alert("review", { message: "Two tables need you." });
    assert.equal(r.played, false);
    assert.equal(core.loadHistory()[0].message, "Two tables need you.");
  } finally {
    delete process.env.HEADS_UP_DISABLED;
  }
  void DATA;
});
