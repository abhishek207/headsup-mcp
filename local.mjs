// The local voice: Kokoro-82M (Apache-2.0) running on this Mac through sherpa-onnx
// (Apache-2.0; the pinned build includes espeak-ng, GPL-3.0). Optional and free: nothing
// is downloaded until the user asks, no text leaves the Mac, and lines cost no credits.
// Everything lives in DATA/local, and removing the voice deletes that folder. Each download
// is one pinned file, checked against its hash before it's unpacked.
// Speech runs in a short child process (`node local.mjs speak`), one line at a time across
// every session, so the model is only in memory while a line is being made.

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
const SPEAK_TIMEOUT_MS = 30_000;

// sherpa-onnx 1.13.8 is the last release with espeak-ng. 2.x reads words only from its
// lexicon and drops the rest, which would cut project names and much of Claude's lines.
const ENGINE = {
  version: "1.13.8",
  "darwin-arm64": { url: "https://registry.npmjs.org/sherpa-onnx-darwin-arm64/-/sherpa-onnx-darwin-arm64-1.13.8.tgz", hash: "sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==", bytes: 10_047_754 },
  "darwin-x64": { url: "https://registry.npmjs.org/sherpa-onnx-darwin-x64/-/sherpa-onnx-darwin-x64-1.13.8.tgz", hash: "sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==", bytes: 11_191_481 },
  // Not a supported platform for Heads-up; here so the voice can be tested on Linux.
  "linux-x64": { url: "https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.8.tgz", hash: "sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==", bytes: 11_089_653 },
};
// Kokoro v1.0 as sherpa-onnx packages it, full precision. The int8 build is a third of the
// size but audibly rough (buzzy between the harmonics), and on Apple silicon it's about half
// as fast, so the full model is worth the bigger download.
const MODEL = {
  name: "kokoro-multi-lang-v1_0",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
  hash: "sha256-YHA3B7wFzNSNYOHrcj84sH1uR0eVoLaliNciBADg96Q=",
  bytes: 349_886_476,
  file: "model.onnx",
};
export const PINNED = { engine: ENGINE.version, model: MODEL.name, file: MODEL.file };
// The Chinese text front end isn't needed for English voices (about 17 MB).
const UNUSED = ["dict", "lexicon-zh.txt", "date-zh.fst", "number-zh.fst", "phone-zh.fst"];
export const DISK_BYTES = 420_000_000; // engine 33 MB + model 384 MB, rounded up

const platform = `${process.platform}-${process.arch}`;
export const defaultSources = () => ({ engine: ENGINE[platform] ?? null, model: MODEL });

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

// Installed, and the same engine and model this version of Heads-up pins.
export function localReady() {
  const i = readJson(INSTALLED);
  return Boolean(i && i.engine === PINNED.engine && i.model === PINNED.model && existsSync(join(ENGINE_DIR, "sherpa-onnx.node")) && existsSync(join(MODEL_DIR, PINNED.file)));
}

// What the page and CLI show: { ready, installing: { step, done, total } | null, error,
// download (bytes), disk (bytes), voices (count), supported }.
let progress = null;
let lastError = null;
export function localStatus() {
  const held = readJson(INSTALL_LOCK);
  const elsewhere = !progress && held && held.pid !== process.pid && alive(held.pid) ? { step: "elsewhere", done: 0, total: 0 } : null;
  const { engine, model } = defaultSources();
  return {
    ready: localReady(),
    installing: progress ?? elsewhere,
    error: lastError,
    download: (engine?.bytes ?? 0) + model.bytes,
    disk: DISK_BYTES,
    voices: LOCAL_VOICES.length,
    supported: Boolean(engine),
  };
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

// Downloads, checks and unpacks the engine and model, then speaks one word to prove they
// load. Returns localStatus(). Safe to call again: a finished install is kept, a broken one
// is replaced. sources: tests only.
export async function installLocal({ sources = defaultSources(), onProgress = () => {} } = {}) {
  if (!sources.engine) throw new Error(`the local voice isn't available for ${platform}`);
  if (localReady() && sources.model === MODEL) return localStatus();
  mkdirSync(LOCAL_DIR, { recursive: true });
  try {
    writeFileSync(INSTALL_LOCK, JSON.stringify({ pid: process.pid }), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const held = readJson(INSTALL_LOCK);
    if (held && alive(held.pid)) throw new Error("the local voice is already downloading");
    writeFileSync(INSTALL_LOCK, JSON.stringify({ pid: process.pid }));
  }
  const staging = join(LOCAL_DIR, `staging-${process.pid}`);
  const total = sources.engine.bytes + sources.model.bytes;
  const step = (name, done) => onProgress((progress = { step: name, done, total }));
  lastError = null;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const parts = [
      ["engine", sources.engine, join(staging, "engine.tgz"), 0],
      ["model", sources.model, join(staging, "model.tar.bz2"), sources.engine.bytes],
    ];
    for (const [name, src, file, before] of parts) {
      step(name, before);
      await download(src.url, file, (n) => step(name, before + Math.min(n, src.bytes)));
      if (!(await verify(file, src.hash))) throw new Error(`the ${name} download didn't match its checksum, so it wasn't used`);
    }
    step("unpacking", total);
    await untar(parts[0][2], join(staging, "engine"));
    await untar(parts[1][2], join(staging, "model"));
    const modelDir = readdirSync(join(staging, "model")).map((d) => join(staging, "model", d)).find((d) => existsSync(join(d, MODEL.file)));
    if (!existsSync(join(staging, "engine", "package", "sherpa-onnx.node")) || !modelDir) throw new Error("the download is missing files");
    for (const f of UNUSED) rmSync(join(modelDir, f), { recursive: true, force: true });
    for (const d of [ENGINE_DIR, MODEL_DIR]) rmSync(d, { recursive: true, force: true });
    renameSync(join(staging, "engine", "package"), ENGINE_DIR);
    renameSync(modelDir, MODEL_DIR);
    writeFileSync(INSTALLED, JSON.stringify({ engine: ENGINE.version, model: MODEL.name, at: new Date().toISOString() }, null, 2) + "\n");
    step("checking", total);
    if (process.env.HEADS_UP_FAKE_TTS !== "1") await speakLocal("af_heart", "Hello.");
  } catch (e) {
    lastError = String(e.message).slice(0, 200);
    rmSync(INSTALLED, { force: true });
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
  lastError = null;
}

// One line at a time across all sessions: eight sessions finishing together make eight
// lines in a row, never eight models in memory at once.
async function withSpeakLock(fn) {
  const deadline = Date.now() + SPEAK_TIMEOUT_MS;
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
// the engine fails, or it takes longer than 30 seconds.
export async function speakLocal(voiceId, text) {
  const v = LOCAL_VOICES.find((x) => x.id === voiceId);
  if (!v) throw new Error(`unknown local voice ${voiceId}`);
  if (!localReady()) throw new Error("the local voice isn't downloaded");
  return withSpeakLock(
    () =>
      new Promise((resolve, reject) => {
        const out = join(LOCAL_DIR, `line-${process.pid}-${Date.now()}.wav`);
        const env = { ...process.env, DYLD_LIBRARY_PATH: ENGINE_DIR, LD_LIBRARY_PATH: ENGINE_DIR };
        const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "speak"], { env, stdio: ["pipe", "ignore", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
        const timer = setTimeout(() => p.kill("SIGKILL"), SPEAK_TIMEOUT_MS);
        p.on("error", (e) => (clearTimeout(timer), reject(e)));
        p.on("close", (code, signal) => {
          clearTimeout(timer);
          try {
            if (code !== 0) throw new Error(signal ? "the local voice took too long" : `the local voice failed: ${reason(err) || `exit ${code}`}`);
            resolve(readFileSync(out));
          } catch (e) {
            reject(e);
          } finally {
            rmSync(out, { force: true });
          }
        });
        p.stdin.end(JSON.stringify({ text, sid: v.sid, british: v.id.startsWith("b"), out }));
      }),
  );
}

// The child process: load the engine and model, write one WAV, exit.
function speakMain() {
  const job = JSON.parse(readFileSync(0, "utf8"));
  const sherpa = createRequire(import.meta.url)(join(ENGINE_DIR, "sherpa-onnx.node"));
  const kokoro = {
    model: join(MODEL_DIR, MODEL.file),
    voices: join(MODEL_DIR, "voices.bin"),
    tokens: join(MODEL_DIR, "tokens.txt"),
    dataDir: join(MODEL_DIR, "espeak-ng-data"),
    lexicon: join(MODEL_DIR, job.british ? "lexicon-gb-en.txt" : "lexicon-us-en.txt"),
    lang: job.british ? "en" : "en-us", // espeak-ng's "en" is British English
  };
  const tts = sherpa.createOfflineTts({ model: { kokoro, numThreads: THREADS, provider: "cpu", debug: 0 }, maxNumSentences: 1 });
  const audio = sherpa.offlineTtsGenerate(tts, { text: job.text, sid: job.sid, speed: 1 });
  if (!audio?.samples?.length) throw new Error("no audio came back");
  sherpa.writeWave(job.out, { samples: audio.samples, sampleRate: audio.sampleRate });
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "speak") speakMain();
