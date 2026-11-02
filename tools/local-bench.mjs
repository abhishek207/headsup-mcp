#!/usr/bin/env node
// Measures the local voice on this computer: model load time, time per line, real-time
// factor and peak memory, on 2 and 4 threads. Installs the voice first if it isn't there.
//   node tools/local-bench.mjs           the pinned int8 model
//   node tools/local-bench.mjs --full    also the full-precision model (a 350 MB download)
// Then times a real alert the way Claude makes one: "Hello from <project>." plus a line, first
// with nothing cached, then with the greeting cached. That part needs ffmpeg.
// Set HEADS_UP_HOME to a temp folder to keep it apart from your real settings.

import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LINES = ["Hello from Kosh.", "The checkout fix is ready, and I need your review before I merge it.", "Tests passed on the second try. Should I deploy the Brand Bakery Hub now, or wait for you?"];
const FULL = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
  hash: "sha256-YHA3B7wFzNSNYOHrcj84sH1uR0eVoLaliNciBADg96Q=",
};

if (process.argv[2] === "child") {
  // One configuration in a fresh process, so peak memory is its own.
  const [, , , engine, dir, file, threads] = process.argv;
  const sherpa = createRequire(import.meta.url)(join(engine, "sherpa-onnx.node"));
  let t = Date.now();
  const tts = sherpa.createOfflineTts({
    model: { kokoro: { model: join(dir, file), voices: join(dir, "voices.bin"), tokens: join(dir, "tokens.txt"), dataDir: join(dir, "espeak-ng-data"), lexicon: join(dir, "lexicon-us-en.txt"), lang: "en-us" }, numThreads: Number(threads), provider: "cpu", debug: 0 },
    maxNumSentences: 1,
  });
  const load = Date.now() - t;
  const lines = LINES.map((text) => {
    t = Date.now();
    const a = sherpa.offlineTtsGenerate(tts, { text, sid: 16, speed: 1 });
    return { ms: Date.now() - t, audio: a.samples.length / a.sampleRate };
  });
  console.log(JSON.stringify({ load, lines, rssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
  process.exit(0);
}

const { LOCAL_DIR, PINNED, installLocal, localReady, verify } = await import("../local.mjs");
if (!localReady()) {
  console.log("Installing the local voice…");
  await installLocal();
}
const engine = join(LOCAL_DIR, "engine");
const models = [["int8", join(LOCAL_DIR, "model"), PINNED.file]];
if (process.argv.includes("--full")) {
  const dir = join(LOCAL_DIR, "bench-full");
  const archive = join(dir, "full.tar.bz2");
  if (!existsSync(join(dir, "kokoro-multi-lang-v1_0", "model.onnx"))) {
    mkdirSync(dir, { recursive: true });
    console.log("Downloading the full-precision model (350 MB)…");
    execFileSync("curl", ["-fsSL", "--proto", "=https", "-o", archive, FULL.url], { stdio: "inherit" });
    if (!(await verify(archive, FULL.hash))) throw new Error("checksum mismatch");
    execFileSync("tar", ["-xf", archive, "-C", dir]);
  }
  models.push(["full", join(dir, "kokoro-multi-lang-v1_0"), "model.onnx"]);
}

const cpu = process.platform === "darwin" ? spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim() : process.arch;
console.log(`\n${cpu}, ${process.platform}, Node ${process.version}`);
console.log("model  threads  load ms  per line (ms / audio s / RTF)                      peak MB");
for (const [name, dir, file] of models) {
  for (const threads of [2, 4]) {
    const env = { ...process.env, DYLD_LIBRARY_PATH: engine, LD_LIBRARY_PATH: engine };
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "child", engine, dir, file, String(threads)], { env, encoding: "utf8" });
    if (r.status !== 0) {
      console.log(`${name}  ${threads}  failed: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
      continue;
    }
    const j = JSON.parse(r.stdout.trim().split("\n").pop());
    const per = j.lines.map((l) => `${l.ms}/${l.audio.toFixed(1)}/${(l.ms / 1000 / l.audio).toFixed(2)}`).join("  ");
    console.log(`${name.padEnd(6)} ${String(threads).padEnd(8)} ${String(j.load).padEnd(8)} ${per.padEnd(50)} ${j.rssMB}`);
  }
}

// End to end, through prepare(): what the user waits for before the alert plays.
const { normalize, prepare } = await import("../core.mjs");
const c = normalize({ project_names: { enabled: true }, live: { enabled: true }, custom_voices: [{ provider: "local", provider_id: "am_michael" }], voice: "local-am_michael" });
const runs = [["new project, new line", "bench" + Date.now().toString(36), LINES[1]], ["same project, new line", null, LINES[2]], ["both cached", null, LINES[2]]];
console.log("\nAlert, end to end (prepare: greeting + line, joined)");
for (const [label, project, message] of runs) {
  const p = project ?? runs[0][1];
  const t = Date.now();
  const r = await prepare("local-am_michael", "review", { project: p, message }, c);
  console.log(`${label.padEnd(24)} ${String(Date.now() - t).padStart(6)} ms  ${r.live ? "spoken live" : `fallback: ${r.note}`}`);
}
