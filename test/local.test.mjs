import { DATA, optedIn, quiet } from "./helpers.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  const m = join(FIX, "m", "kokoro-test");
  mkdirSync(join(m, "dict"), { recursive: true });
  for (const f of ["model.int8.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-zh.txt", "dict/jieba.dict"]) writeFileSync(join(m, f), f);
  execFileSync("tar", ["-cjf", join(FIX, "model.tar.bz2"), "-C", join(FIX, "m"), "kokoro-test"]);
  server = createServer((req, res) => {
    const file = join(FIX, req.url.slice(1));
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200).end(readFileSync(file));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const sources = (overrides = {}) => ({
  engine: { url: `${base}/engine.tgz`, hash: sri("sha512", join(FIX, "engine.tgz")), bytes: readFileSync(join(FIX, "engine.tgz")).length },
  model: { url: `${base}/model.tar.bz2`, hash: sri("sha256", join(FIX, "model.tar.bz2")), bytes: readFileSync(join(FIX, "model.tar.bz2")).length },
  ...overrides,
});

test("local voice: nothing is downloaded until asked", () => {
  const s = local.localStatus();
  assert.equal(s.ready, false);
  assert.equal(s.installing, null);
  assert.equal(s.voices, local.LOCAL_VOICES.length);
  assert.ok(s.download > 100e6 && s.disk > s.download, "sizes the page shows before downloading");
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
    local.removeLocal();
    assert.equal(local.localStatus().ready, false);
    assert.equal(existsSync(local.LOCAL_DIR), false);
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

test("local voices are listed for the library, with previews once downloaded", async () => {
  const { providerVoices } = await import("../tts.mjs");
  const list = await providerVoices("local");
  assert.equal(list.length, local.LOCAL_VOICES.length);
  assert.ok(list.every((v) => v.provider === "local" && v.preview === null), "no previews before the download");
  assert.deepEqual(new Set(list.map((v) => v.accent)), new Set(["American", "British", "Indian"]));
});
