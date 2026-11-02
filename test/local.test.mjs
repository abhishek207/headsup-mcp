import { DATA, optedIn, quiet } from "./helpers.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";

const local = await import("../local.mjs");
const core = await import("../core.mjs");
const { usageSummary } = await import("../speech.mjs");
const { normalize, prepare } = core;

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const needsFfmpeg = { skip: !ffmpeg && "ffmpeg not installed" };
const withTts = async (fn) => {
  process.env.HEADS_UP_FAKE_TTS = "1";
  try {
    return await fn();
  } finally {
    delete process.env.HEADS_UP_FAKE_TTS;
  }
};

// Stand-ins for the engine and model archives, served over http from 127.0.0.1. The fake
// engine can't speak, so the install's speech check is skipped with fake TTS.
const FIX = join(DATA, "fixtures");
const sri = (algo, file) => `${algo}-${createHash(algo).update(readFileSync(file)).digest("base64")}`;
let server, base;
before(async () => {
  mkdirSync(join(FIX, "e", "package"), { recursive: true });
  writeFileSync(join(FIX, "e", "package", "sherpa-onnx.node"), "not really an addon");
  execFileSync("tar", ["-czf", join(FIX, "engine.tgz"), "-C", join(FIX, "e"), "package"]);
  // One archive per model, each with that model's file name.
  for (const [id, m] of Object.entries(local.MODELS)) {
    const dir = join(FIX, `m-${id}`, "kokoro-test");
    mkdirSync(join(dir, "dict"), { recursive: true });
    for (const f of [m.file, "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-zh.txt", "dict/jieba.dict"]) writeFileSync(join(dir, f), `${id} ${f}`);
    execFileSync("tar", ["-cjf", join(FIX, `model-${id}.tar.bz2`), "-C", join(FIX, `m-${id}`), "kokoro-test"]);
  }
  server = createServer((req, res) => {
    const file = join(FIX, req.url.slice(1));
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200).end(readFileSync(file));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const engineSource = () => ({ url: `${base}/engine.tgz`, hash: sri("sha512", join(FIX, "engine.tgz")), bytes: readFileSync(join(FIX, "engine.tgz")).length });
const modelSource = (id = "full") => ({ url: `${base}/model-${id}.tar.bz2`, hash: sri("sha256", join(FIX, `model-${id}.tar.bz2`)), bytes: readFileSync(join(FIX, `model-${id}.tar.bz2`)).length });
const sources = (overrides = {}) => ({ engine: engineSource(), model: modelSource(), ...overrides });

test("local voice: nothing is downloaded until asked", () => {
  const s = local.localStatus();
  assert.equal(s.ready, false);
  assert.equal(s.installing, null);
  assert.equal(s.model, null);
  assert.equal(s.voices, local.LOCAL_VOICES.length);
  assert.deepEqual(s.models.map((m) => m.id), ["full", "small"], "full quality first");
  for (const m of s.models) {
    assert.ok(m.download > 100e6 && m.disk > m.download && m.memory > 0 && m.seconds > 0, `sizes and memory the page shows before downloading ${m.id}`);
    assert.ok(existsSync(new URL(`../assets/local-samples/${m.id}.mp3`, import.meta.url)), `a sample of ${m.id} ships with Heads-up`);
  }
  assert.ok(s.models[0].download > s.models[1].download);
  assert.equal(existsSync(local.LOCAL_DIR), false);
});

test("local voice: a download that doesn't match its checksum is never used", () =>
  withTts(async () => {
    const bad = sources();
    bad.model = { ...bad.model, hash: "sha256-" + Buffer.alloc(32).toString("base64") };
    await assert.rejects(local.installLocal({ sources: bad }), /model download didn't match its checksum/);
    const s = local.localStatus();
    assert.equal(s.ready, false);
    assert.match(s.error, /checksum/);
    assert.equal(existsSync(join(local.LOCAL_DIR, "installed.json")), false);
    assert.deepEqual(readdirSync(local.LOCAL_DIR), [], "no staging files or lock left behind");
  }));

test("local voice: installs from pinned files, reports progress, and removes cleanly", () =>
  withTts(async () => {
    const steps = new Set();
    const s = await local.installLocal({ sources: sources(), onProgress: (p) => steps.add(p.step) });
    assert.equal(s.ready, true);
    assert.equal(s.installing, null);
    assert.equal(s.error, null);
    assert.deepEqual([...steps], ["engine", "model", "unpacking", "checking"]);
    assert.ok(existsSync(join(local.LOCAL_DIR, "engine", "sherpa-onnx.node")));
    assert.ok(existsSync(join(local.LOCAL_DIR, "model", "voices.bin")));
    assert.equal(existsSync(join(local.LOCAL_DIR, "model", "dict")), false, "the Chinese front end is dropped");
    assert.equal(existsSync(join(local.LOCAL_DIR, "model", "lexicon-zh.txt")), false);
    assert.deepEqual(readdirSync(local.LOCAL_DIR).sort(), ["engine", "installed.json", "model"]);
    assert.equal(s.model, "full");
    local.removeLocal();
    assert.equal(local.localStatus().ready, false);
    assert.equal(existsSync(local.LOCAL_DIR), false);
  }));

test("local voice: switching models keeps the engine, replaces the model and forgets its recordings", () =>
  withTts(async () => {
    await local.installLocal({ sources: sources() });
    const engineFile = join(local.LOCAL_DIR, "engine", "sherpa-onnx.node");
    const engineTime = statSync(engineFile).mtimeMs;
    // Recordings made with the full model, plus one in a paid voice that must stay.
    for (const d of [join(DATA, "segments", "local-am_michael"), join(DATA, "cache", "clips", "local-am_michael"), join(DATA, "segments", "american-male"), join(local.LOCAL_DIR, "previews")]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "x.wav"), "");
    }
    // A switch whose download is bad leaves the full model working.
    const bad = { ...modelSource("small"), hash: "sha256-" + Buffer.alloc(32).toString("base64") };
    await assert.rejects(local.installLocal({ model: "small", sources: { model: bad } }), /checksum/);
    assert.equal(local.localStatus().model, "full");
    assert.ok(existsSync(join(DATA, "segments", "local-am_michael", "x.wav")), "nothing forgotten on a failed switch");
    const steps = [];
    const s = await local.installLocal({ model: "small", sources: { model: modelSource("small") }, onProgress: (p) => steps.at(-1) !== p.step && steps.push(p.step) });
    assert.equal(s.model, "small");
    assert.equal(s.error, null);
    assert.deepEqual(steps, ["model", "unpacking", "checking"], "the engine isn't downloaded again");
    assert.equal(statSync(engineFile).mtimeMs, engineTime);
    assert.ok(existsSync(join(local.LOCAL_DIR, "model", local.MODELS.small.file)));
    assert.equal(existsSync(join(local.LOCAL_DIR, "model", local.MODELS.full.file)), false);
    assert.equal(s.models.find((m) => m.id === "full").download, local.MODELS.full.bytes, "switching back needs only the model");
    assert.equal(existsSync(join(DATA, "segments", "local-am_michael")), false);
    assert.equal(existsSync(join(DATA, "cache", "clips", "local-am_michael")), false);
    assert.equal(existsSync(join(local.LOCAL_DIR, "previews")), false);
    assert.ok(existsSync(join(DATA, "segments", "american-male", "x.wav")), "paid voices' recordings stay");
    await assert.rejects(local.installLocal({ model: "constructor" }), /unknown local model/);
    local.removeLocal();
  }));

test("local voices: only Kokoro's listed voices can be added", () => {
  const c = normalize({ custom_voices: [{ provider: "local", provider_id: "am_michael", name: "Michael" }, { provider: "local", provider_id: "zm_yunxi" }], voice: "local-am_michael" });
  assert.deepEqual(c.custom_voices.map((v) => v.id), ["local-am_michael"]);
  assert.equal(c.voice, "local-am_michael");
  assert.equal(core.libraryVoiceId({ provider: "local", provider_id: "bf_emma" }), "local-bf_emma");
});

test("local voice not downloaded: the built-in voice plays, with a reason", async () => {
  const c = normalize({ ...optedIn, custom_voices: [{ provider: "local", provider_id: "af_heart", fallback: "british-female" }], voice: "local-af_heart" });
  const p = await prepare("local-af_heart", "review", { message: "Two tables need your review." }, c);
  assert.match(p.file, /voices\/british-female\/review\.mp3$/);
  assert.equal(p.live, false);
  assert.equal(p.note, "the local voice isn't downloaded");
});

test("local voice: Claude's lines and project names are free, with no daily budget or name cap", needsFfmpeg, () =>
  withTts(async () => {
    // Twenty new names already made today would stop any paid voice from recording another.
    const other = join(DATA, "segments", "american-male");
    mkdirSync(other, { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(other, `hello-from-p${i}-00000000.wav`), "");
    const c = normalize({ ...optedIn, live: { enabled: true, daily_chars: 0 }, custom_voices: [{ provider: "local", provider_id: "am_michael" }], voice: "local-am_michael" });
    const msg = "The checkout fix is ready, and I need your review.";
    const p = await prepare("local-am_michael", "review", { project: "kosh", message: msg }, c);
    assert.equal(p.note, null);
    assert.equal(p.live, true);
    assert.equal(p.line, `Hello from Kosh. ${msg}`);
    assert.match(p.file, /cache\/clips\/local-am_michael\//);
    assert.deepEqual(usageSummary().by, {}, "nothing is counted as spent");
    const paid = await prepare("american-male", "review", { project: "kosh" }, normalize({ ...optedIn, live: { enabled: true, daily_chars: 0 } }));
    assert.match(paid.note, /daily limit of 20 new project names/, "the cap still holds for paid voices");
  }));

test("local voice speed: clamped to 0.7–1.5 in steps of 0.05, and each speed keeps its own recordings", needsFfmpeg, () =>
  withTts(async () => {
    assert.equal(normalize({}).local.speed, 1);
    assert.equal(normalize({ local: { speed: 1.23 } }).local.speed, 1.25);
    assert.equal(normalize({ local: { speed: 3 } }).local.speed, 1.5);
    assert.equal(normalize({ local: { speed: 0.1 } }).local.speed, 0.7);
    for (const bad of ["fast", null, "", "1.2"]) assert.equal(normalize({ local: { speed: bad } }).local.speed, 1);
    const at = (speed) => normalize({ ...optedIn, local: { speed }, custom_voices: [{ provider: "local", provider_id: "am_michael" }], voice: "local-am_michael" });
    const msg = "The speed test is done, and I need you to pick a pace.";
    const normal = await prepare("local-am_michael", "input", { message: msg }, at(1));
    const quick = await prepare("local-am_michael", "input", { message: msg }, at(1.2));
    assert.equal(quick.live, true);
    assert.notEqual(quick.file, normal.file);
    assert.match(quick.file, /-x1\.2\.mp3$/);
    assert.equal((await prepare("local-am_michael", "input", { message: msg }, at(1))).file, normal.file, "back at 1x, the first recording is reused");
  }));

test("local voice: a long line starts playing after its first sentence, then is cached whole", needsFfmpeg, () =>
  withTts(async () => {
    const { sentences } = await import("../speech.mjs");
    assert.deepEqual(sentences("Done. The checkout fix is ready, e.g. the cart page and the tax rules. Should I merge it now, or wait for you?"), [
      "Done. The checkout fix is ready, e.g. the cart page and the tax rules.",
      "Should I merge it now, or wait for you?",
    ]);
    const c = normalize({ ...optedIn, custom_voices: [{ provider: "local", provider_id: "am_michael" }], voice: "local-am_michael" });
    const got = [];
    let ended = false;
    const stream = { used: false, push: (x) => got.push(x), end: () => (ended = true) };
    const msg = "The streaming test is finished, and every piece arrived in order. I need you to listen and tell me whether the pauses sound natural.";
    const p = await prepare("local-am_michael", "input", { project: "kosh", message: msg, stream }, c);
    assert.equal(p.live, true);
    assert.equal(p.stream, stream);
    assert.ok(got.length >= 2 && typeof got[0] === "string" && got[1] === 600, "greeting, then the pause");
    const file = await p.done;
    assert.ok(ended);
    const pieces = got.filter((x) => typeof x === "string");
    assert.equal(pieces.length, 1 + sentences(msg).length);
    for (const f of pieces) assert.ok(existsSync(f), `piece ${f}`);
    assert.match(file, /cache\/clips\/local-am_michael\//);
    const again = await prepare("local-am_michael", "input", { project: "kosh", message: msg, stream: { used: false, push() {}, end() {} } }, c);
    assert.equal(again.file, file, "the second time it's one cached clip, not a stream");
    const short = await prepare("local-am_michael", "input", { message: "Just one sentence here.", stream: { used: false, push: () => assert.fail("streamed"), end() {} } }, c);
    assert.equal(short.live, true);
  }));

test("local voice: Claude can say much more than with a paid voice", () => {
  const c = normalize({ ...quiet, live: { enabled: true, max_chars: 160 }, custom_voices: [{ provider: "local", provider_id: "am_michael" }], voice: "local-am_michael" });
  assert.equal(c.local.max_chars, 1000);
  assert.equal(normalize({ local: { max_chars: 99999 } }).local.max_chars, 2000);
  assert.equal(core.maxChars("local-am_michael", c), 1000);
  assert.equal(core.maxChars("american-male", c), 160);
});

test("local voices are listed for the library, each with a sample shipped in the package", async () => {
  const { providerVoices } = await import("../tts.mjs");
  const list = await providerVoices("local");
  assert.equal(list.length, local.LOCAL_VOICES.length);
  assert.ok(list.every((v) => v.provider === "local" && v.preview === `/api/local/preview?voice=${v.provider_id}`));
  for (const v of local.LOCAL_VOICES) assert.ok(statSync(new URL(`../assets/local-samples/voices/${v.id}.mp3`, import.meta.url)).size > 10_000, `sample for ${v.id}`);
  assert.deepEqual(new Set(list.map((v) => v.accent)), new Set(["American", "British", "Indian"]));
});
