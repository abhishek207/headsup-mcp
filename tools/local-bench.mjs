#!/usr/bin/env node
// Measures the local voice on this computer: model load time, time per line, real-time
// factor and peak memory, on 2 and 4 threads. Installs the voice first if it isn't there.
//   node tools/local-bench.mjs           the installed model (installs the full one if none is)
//   node tools/local-bench.mjs --both    also the other model, for comparison (downloaded apart)
// Then times a real alert the way Claude makes one: "Hello from <project>." plus a line, first
// with nothing cached, then with the greeting cached. That part needs ffmpeg.
// Set HEADS_UP_HOME to a temp folder to keep it apart from your real settings.

import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LINES = ["Hello from Kosh.", "The checkout fix is ready, and I need your review before I merge it.", "Tests passed on the second try. Should I deploy the Brand Bakery Hub now, or wait for you?"];

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

const { LOCAL_DIR, MODELS, installLocal, installedModel, localReady, verify } = await import("../local.mjs");
if (!localReady()) {
  console.log("Installing the local voice…");
  await installLocal();
}
const engine = join(LOCAL_DIR, "engine");
const here = MODELS[installedModel()];
const models = [[here.id, join(LOCAL_DIR, "model"), here.file]];
if (process.argv.includes("--both")) {
  const other = Object.values(MODELS).find((m) => m.id !== here.id);
  const dir = join(LOCAL_DIR, `bench-${other.id}`);
  const archive = join(dir, "model.tar.bz2");
  if (!existsSync(join(dir, other.name, other.file))) {
    mkdirSync(dir, { recursive: true });
    console.log(`Downloading the ${other.label.toLowerCase()} model (${Math.round(other.bytes / 1e6)} MB)…`);
    execFileSync("curl", ["-fsSL", "--proto", "=https", "-o", archive, other.url], { stdio: "inherit" });
    if (!(await verify(archive, other.hash))) throw new Error("checksum mismatch");
    execFileSync("tar", ["-xf", archive, "-C", dir]);
  }
  models.push([other.id, join(dir, other.name), other.file]);
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
const tag = Date.now().toString(36); // fresh text each run, so re-runs aren't cache hits
const fresh = LINES[2].replace("now", `now, run ${tag}`);
const runs = [["new project, new line", "bench" + tag, LINES[1] + ` Run ${tag}.`], ["same project, new line", null, fresh], ["both cached", null, fresh]];
console.log("\nAlert, end to end (prepare: greeting + line, joined)");
for (const [label, project, message] of runs) {
  const p = project ?? runs[0][1];
  const t = Date.now();
  const r = await prepare("local-am_michael", "review", { project: p, message }, c);
  console.log(`${label.padEnd(24)} ${String(Date.now() - t).padStart(6)} ms  ${r.live ? "spoken live" : `fallback: ${r.note}`}`);
}
