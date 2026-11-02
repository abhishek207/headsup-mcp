// The local voice: Kokoro-82M (Apache-2.0) running on this Mac through sherpa-onnx
// (Apache-2.0; the pinned build includes espeak-ng, GPL-3.0). Optional and free: nothing
// is downloaded until the user asks, no text leaves the Mac, and lines cost no credits.
// Everything lives in DATA/local, and removing the voice deletes that folder. Each download
// is one pinned file, checked against its hash before it's unpacked.
// Speech runs in a short child process (`node local.mjs speak`), one line at a time across
// every session, so the model is only in memory while a line is being made.
// Two builds of the model are offered (MODELS): full quality, or a smaller int8 build. The
// user hears a sample of each on the settings page and picks one; one is installed at a time.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA } from "./paths.mjs";

export const LOCAL_DIR = join(DATA, "local");
const ENGINE_DIR = join(LOCAL_DIR, "engine");
const MODEL_DIR = join(LOCAL_DIR, "model");
const INSTALLED = join(LOCAL_DIR, "installed.json");
const INSTALL_LOCK = join(LOCAL_DIR, "installing.lock");
const SPEAK_LOCK = join(LOCAL_DIR, "speaking.lock");
const THREADS = 2; // short bursts on two cores, so the rest of the Mac stays responsive
// A line gets 30 s plus 0.15 s per character (a 2,000-character script: about 5 minutes,
// several times what the smaller model needs), and the next one waits up to 3 minutes for it.
const speakTimeout = (text) => 30_000 + 150 * text.length;
const SPEAK_WAIT_MS = 180_000;

// sherpa-onnx 1.13.8 is the last release with espeak-ng. 2.x reads words only from its
// lexicon and drops the rest, which would cut project names and much of Claude's lines.
const ENGINE = {
  version: "1.13.8",
  "darwin-arm64": { url: "https://registry.npmjs.org/sherpa-onnx-darwin-arm64/-/sherpa-onnx-darwin-arm64-1.13.8.tgz", hash: "sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==", bytes: 10_047_754 },
  "darwin-x64": { url: "https://registry.npmjs.org/sherpa-onnx-darwin-x64/-/sherpa-onnx-darwin-x64-1.13.8.tgz", hash: "sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==", bytes: 11_191_481 },
  // Not a supported platform for Heads-up; here so the voice can be tested on Linux.
  "linux-x64": { url: "https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.8.tgz", hash: "sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==", bytes: 11_089_653 },
};
// Kokoro v1.0 as sherpa-onnx packages it, in two builds with the same 54 voices. Full sounds
// clean. The int8 build is a third of the size but audibly rough (buzzy between the
// harmonics) and, on Apple silicon, about half as fast. disk: engine 33 MB + the unpacked
// model, rounded up. memory/seconds: what one new line typically takes (measured on an
// M4 MacBook Air); after an install the page shows what this Mac measured instead.
export const MODELS = {
  full: {
    id: "full",
    label: "Full quality",
    name: "kokoro-multi-lang-v1_0",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
    hash: "sha256-YHA3B7wFzNSNYOHrcj84sH1uR0eVoLaliNciBADg96Q=",
    bytes: 349_886_476,
    file: "model.onnx",
    disk: 420_000_000,
    memory: 730,
    seconds: 4,
  },
  small: {
    id: "small",
    label: "Smaller",
    name: "kokoro-int8-multi-lang-v1_0",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2",
    hash: "sha256-csNHIwEH74oxCY7E1GimBSRL7vXx7QDbl++hNRiABlM=",
    bytes: 132_353_410,
    file: "model.int8.onnx",
    disk: 210_000_000,
    memory: 500,
    seconds: 7,
  },
};
export const DEFAULT_MODEL = "full";
export const isModel = (id) => typeof id === "string" && Object.hasOwn(MODELS, id);
export const PINNED = { engine: ENGINE.version, model: MODELS[DEFAULT_MODEL].name, file: MODELS[DEFAULT_MODEL].file };
// The Chinese text front end isn't needed for English voices (about 17 MB).
const UNUSED = ["dict", "lexicon-zh.txt", "date-zh.fst", "number-zh.fst", "phone-zh.fst"];
// The line the install speaks to prove the model works and to measure this Mac.
const CHECK_LINE = "The checkout fix is ready, and I need your review before I merge it.";

const platform = `${process.platform}-${process.arch}`;
export const defaultSources = (model = DEFAULT_MODEL) => ({ engine: ENGINE[platform] ?? null, model: MODELS[model] });

// The English voices Kokoro rates best, plus two Hindi voices that read English with an
// Indian accent. sid is the speaker's number in this model.
export const LOCAL_VOICES = [
  ["af_heart", 3, "Heart", "American", "Female", "Kokoro's top-rated voice"],
  ["af_bella", 2, "Bella", "American", "Female", ""],
  ["af_nicole", 6, "Nicole", "American", "Female", "soft"],
  ["am_michael", 16, "Michael", "American", "Male", ""],
  ["am_fenrir", 14, "Fenrir", "American", "Male", ""],
  ["am_puck", 18, "Puck", "American", "Male", ""],
  ["bf_emma", 21, "Emma", "British", "Female", ""],
  ["bf_isabella", 22, "Isabella", "British", "Female", ""],
  ["bm_george", 26, "George", "British", "Male", ""],
  ["bm_fable", 25, "Fable", "British", "Male", ""],
  ["hf_alpha", 31, "Alpha", "Indian", "Female", "a Hindi voice reading English"],
  ["hm_omega", 33, "Omega", "Indian", "Male", "a Hindi voice reading English"],
].map(([id, sid, name, accent, gender, about]) => ({ id, sid, name, accent, gender, about }));

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const engineReady = (i) => Boolean(i && i.engine === ENGINE.version && existsSync(join(ENGINE_DIR, "sherpa-onnx.node")));

// Which model is installed ("full" or "small"), if it's one this version of Heads-up pins and
// its files are all there; otherwise null.
export function installedModel() {
  const i = readJson(INSTALLED);
  const m = Object.values(MODELS).find((x) => x.name === i?.model);
  return m && engineReady(i) && existsSync(join(MODEL_DIR, m.file)) ? m.id : null;
}
export const localReady = () => installedModel() !== null;

// What the page and CLI show: { ready, model (installed id or null), measured ({ memory MB,
// seconds } on this Mac, or null), models: [{ id, label, download, disk, memory, seconds,
// sample }], installing: { step, done, total, model } | null, error, voices, supported }.
let progress = null;
let lastError = null;
export function localStatus() {
  const held = readJson(INSTALL_LOCK);
  const elsewhere = !progress && held && held.pid !== process.pid && alive(held.pid) ? { step: "elsewhere", done: 0, total: 0, model: held.model ?? null } : null;
  const engine = ENGINE[platform] ?? null;
  const i = readJson(INSTALLED);
  const model = installedModel();
  return {
    ready: model !== null,
    model,
    measured: model && i?.measured ? i.measured : null,
    models: Object.values(MODELS).map((m) => ({
      id: m.id,
      label: m.label,
      download: (engineReady(i) ? 0 : (engine?.bytes ?? 0)) + m.bytes,
      disk: m.disk,
      memory: m.memory,
      seconds: m.seconds,
      sample: `/api/local/sample?model=${m.id}`,
    })),
    installing: progress ?? elsewhere,
    error: lastError,
    voices: LOCAL_VOICES.length,
    supported: Boolean(engine),
  };
}

// Lines recorded in a local voice were made by the model that's going away: drop them so the
// next alert is recorded again with the new one.
function forgetRecordings() {
  for (const dir of [join(DATA, "segments"), join(DATA, "cache", "clips")]) {
    for (const d of existsSync(dir) ? readdirSync(dir) : []) if (d.startsWith("local-")) rmSync(join(dir, d), { recursive: true, force: true });
  }
  rmSync(join(LOCAL_DIR, "previews"), { recursive: true, force: true });
}

// Streams a file through a hash and compares it with an SRI string ("sha256-<base64>").
export function verify(file, sri) {
  const [algo, want] = [sri.slice(0, sri.indexOf("-")), sri.slice(sri.indexOf("-") + 1)];
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("base64") === want));
  });
}

// curl handles proxies and the Mac's own certificates. HTTPS only, redirects included;
// plain http is allowed for 127.0.0.1 so tests can serve fixtures.
function download(url, out, onBytes) {
  const proto = /^http:\/\/127\.0\.0\.1[:/]/.test(url) ? "=http" : "=https";
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-fsSL", "--proto", proto, "--proto-redir", proto, "--retry", "2", "--connect-timeout", "20", "--max-time", "1800", "-o", out, url], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    const tick = setInterval(() => onBytes(statSync(out, { throwIfNoEntry: false })?.size ?? 0), 400);
    p.on("error", (e) => (clearInterval(tick), reject(e)));
    p.on("close", (code) => {
      clearInterval(tick);
      code === 0 ? resolve() : reject(new Error(err.trim().replace(/^curl: \(\d+\)\s*/, "") || `download failed (curl ${code})`));
    });
  });
}

function untar(file, dir) {
  mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["-xf", file, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`couldn't unpack ${file.split("/").pop()}: ${err.trim().slice(0, 160)}`))));
  });
}

// Downloads, checks and unpacks a model (and the engine, unless the pinned one is already
// there), then speaks one line to prove it works and to measure memory and time on this Mac.
// Installing the other model replaces the current one, which keeps working until the new one
// is in place. Returns localStatus(). Safe to call again. sources: tests only.
export async function installLocal({ model = DEFAULT_MODEL, sources, onProgress = () => {} } = {}) {
  if (!isModel(model)) throw new Error(`unknown local model ${model}`);
  if (!sources && installedModel() === model) return localStatus();
  const src = { ...defaultSources(model), ...sources };
  const m = { ...MODELS[model], ...src.model };
  if (!src.engine) throw new Error(`the local voice isn't available for ${platform}`);
  mkdirSync(LOCAL_DIR, { recursive: true });
  try {
    writeFileSync(INSTALL_LOCK, JSON.stringify({ pid: process.pid, model }), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const held = readJson(INSTALL_LOCK);
    if (held && alive(held.pid)) throw new Error("the local voice is already downloading");
    writeFileSync(INSTALL_LOCK, JSON.stringify({ pid: process.pid, model }));
  }
  const before = readJson(INSTALLED);
  const keepEngine = !sources?.engine && engineReady(before);
  const staging = join(LOCAL_DIR, `staging-${process.pid}`);
  const parts = [...(keepEngine ? [] : [["engine", src.engine, join(staging, "engine.tgz")]]), ["model", m, join(staging, "model.tar.bz2")]];
  const total = parts.reduce((n, [, p]) => n + p.bytes, 0);
  const step = (name, done) => onProgress((progress = { step: name, done, total, model }));
  lastError = null;
  let replaced = false;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    let done = 0;
    for (const [name, part, file] of parts) {
      step(name, done);
      await download(part.url, file, (n) => step(name, done + Math.min(n, part.bytes)));
      if (!(await verify(file, part.hash))) throw new Error(`the ${name} download didn't match its checksum, so it wasn't used`);
      done += part.bytes;
    }
    step("unpacking", total);
    if (!keepEngine) await untar(join(staging, "engine.tgz"), join(staging, "engine"));
    await untar(join(staging, "model.tar.bz2"), join(staging, "model"));
    const modelDir = readdirSync(join(staging, "model")).map((d) => join(staging, "model", d)).find((d) => existsSync(join(d, m.file)));
    if ((!keepEngine && !existsSync(join(staging, "engine", "package", "sherpa-onnx.node"))) || !modelDir) throw new Error("the download is missing files");
    for (const f of UNUSED) rmSync(join(modelDir, f), { recursive: true, force: true });
    // Until here the old install (if any) is untouched and still speaks. From here it's
    // replaced: unmark it first so nothing uses a half-moved folder.
    replaced = true;
    rmSync(INSTALLED, { force: true });
    if (!keepEngine) {
      rmSync(ENGINE_DIR, { recursive: true, force: true });
      renameSync(join(staging, "engine", "package"), ENGINE_DIR);
    }
    rmSync(MODEL_DIR, { recursive: true, force: true });
    renameSync(modelDir, MODEL_DIR);
    forgetRecordings();
    const record = { engine: ENGINE.version, model: m.name, at: new Date().toISOString() };
    writeFileSync(INSTALLED, JSON.stringify(record, null, 2) + "\n");
    step("checking", total);
    if (process.env.HEADS_UP_FAKE_TTS !== "1") {
      const { stats, dir } = await runSpeak(LOCAL_VOICES[0], [CHECK_LINE]);
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(INSTALLED, JSON.stringify({ ...record, measured: stats }, null, 2) + "\n");
    }
  } catch (e) {
    lastError = String(e.message).slice(0, 200);
    if (replaced) rmSync(INSTALLED, { force: true }); // the new model is in place but doesn't work
    throw e;
  } finally {
    progress = null;
    rmSync(staging, { recursive: true, force: true });
    rmSync(INSTALL_LOCK, { force: true });
  }
  return localStatus();
}

export function removeLocal() {
  if (progress) throw new Error("the local voice is still downloading");
  rmSync(LOCAL_DIR, { recursive: true, force: true });
  forgetRecordings();
  lastError = null;
}

// One line at a time across all sessions: eight sessions finishing together make eight
// lines in a row, never eight models in memory at once.
async function withSpeakLock(fn) {
  const deadline = Date.now() + SPEAK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(SPEAK_LOCK, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const held = readJson(SPEAK_LOCK);
    const age = Date.now() - (statSync(SPEAK_LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (held ? !alive(held.pid) : age > 10_000) rmSync(SPEAK_LOCK, { force: true });
    else if (Date.now() > deadline) throw new Error("the local voice is busy");
    else await sleep(150);
  }
  try {
    return await fn();
  } finally {
    rmSync(SPEAK_LOCK, { force: true });
  }
}

// The useful line of a failed child's stderr: the error, not the stack or Node's version.
const reason = (stderr) => {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l && !/^(at |Node\.js v|\^)/.test(l));
  return (lines.find((l) => /error/i.test(l)) ?? lines.pop() ?? "").slice(0, 160);
};

// Speaks text in a local voice and returns the WAV. Throws if the voice isn't installed,
// the engine fails, or it takes too long (see speakTimeout).
export async function speakLocal(voiceId, text, speed = 1) {
  const { files, dir } = await speakLocalParts(voiceId, [text], speed);
  try {
    return readFileSync(files[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Speaks several pieces (a script's sentences) in one child process, so the model loads
// once, calling onPart(file, i) as each WAV is ready: a long script can start playing
// after its first sentence. Resolves to { files, dir, stats }; the caller removes dir.
export async function speakLocalParts(voiceId, texts, speed = 1, onPart = () => {}) {
  const v = LOCAL_VOICES.find((x) => x.id === voiceId);
  if (!v) throw new Error(`unknown local voice ${voiceId}`);
  if (!localReady()) throw new Error("the local voice isn't downloaded");
  return runSpeak(v, texts, speed, onPart);
}

// The pieces in a fresh child process: { files, dir, stats: { memory (peak MB), seconds
// (start to finish, model load included: what an alert waits for) } }.
function runSpeak(v, texts, speed = 1, onPart = () => {}) {
  const file = MODELS[installedModel()]?.file;
  return withSpeakLock(
    () =>
      new Promise((resolve, reject) => {
        for (const d of readdirSync(LOCAL_DIR).filter((d) => d.startsWith("line-"))) {
          const p = join(LOCAL_DIR, d); // left by a process that was killed mid-line
          if (Date.now() - statSync(p).mtimeMs > 600_000) rmSync(p, { recursive: true, force: true });
        }
        const dir = join(LOCAL_DIR, `line-${process.pid}-${Date.now()}`);
        mkdirSync(dir, { recursive: true });
        const outs = texts.map((_, i) => join(dir, `${i}.wav`));
        const env = { ...process.env, DYLD_LIBRARY_PATH: ENGINE_DIR, LD_LIBRARY_PATH: ENGINE_DIR };
        const start = Date.now();
        const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "speak"], { env, stdio: ["pipe", "pipe", "pipe"] });
        let err = "";
        let buf = "";
        let memory = null;
        p.stdout.on("data", (d) => {
          buf += d;
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            try {
              const m = JSON.parse(line);
              if (Number.isInteger(m.part) && outs[m.part]) onPart(outs[m.part], m.part);
              if (m.memory) memory = Number(m.memory) || null;
            } catch {
              // not ours
            }
          }
        });
        p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
        const timer = setTimeout(() => p.kill("SIGKILL"), speakTimeout(texts.join(" ")));
        p.on("error", (e) => (clearTimeout(timer), rmSync(dir, { recursive: true, force: true }), reject(e)));
        p.on("close", (code, signal) => {
          clearTimeout(timer);
          if (code === 0 && outs.every((o) => existsSync(o))) return resolve({ files: outs, dir, stats: { memory, seconds: Math.round((Date.now() - start) / 100) / 10 } });
          rmSync(dir, { recursive: true, force: true });
          reject(new Error(signal ? "the local voice took too long" : `the local voice failed: ${reason(err) || `exit ${code}`}`));
        });
        p.stdin.end(JSON.stringify({ texts, sid: v.sid, british: v.id.startsWith("b"), file, outs, speed, parent: process.pid }));
      }),
  );
}

// The child process: load the engine and model, write one WAV, exit.
function speakMain() {
  const job = JSON.parse(readFileSync(0, "utf8"));
  const sherpa = createRequire(import.meta.url)(join(ENGINE_DIR, "sherpa-onnx.node"));
  const kokoro = {
    model: join(MODEL_DIR, job.file),
    voices: join(MODEL_DIR, "voices.bin"),
    tokens: join(MODEL_DIR, "tokens.txt"),
    dataDir: join(MODEL_DIR, "espeak-ng-data"),
    lexicon: join(MODEL_DIR, job.british ? "lexicon-gb-en.txt" : "lexicon-us-en.txt"),
    lang: job.british ? "en" : "en-us", // espeak-ng's "en" is British English
  };
  const tts = sherpa.createOfflineTts({ model: { kokoro, numThreads: THREADS, provider: "cpu", debug: 0 }, maxNumSentences: 1 });
  const speed = Math.min(1.5, Math.max(0.7, Number(job.speed) || 1));
  for (const [i, text] of job.texts.entries()) {
    if (job.parent && process.ppid !== job.parent) process.exit(1); // nobody left to play it
    const audio = sherpa.offlineTtsGenerate(tts, { text, sid: job.sid, speed });
    if (!audio?.samples?.length) throw new Error("no audio came back");
    sherpa.writeWave(job.outs[i], { samples: audio.samples, sampleRate: audio.sampleRate });
    process.stdout.write(JSON.stringify({ part: i }) + "\n"); // the parent can play it now
  }
  // Peak memory of this process, for the settings page (maxRSS is in kilobytes).
  process.stdout.write(JSON.stringify({ memory: Math.round(process.resourceUsage().maxRSS / 1024) }) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "speak") speakMain();
