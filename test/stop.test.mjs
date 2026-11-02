// Stopping an alert mid-sentence: Stop (CLI/page) and the mic opening while it speaks.
// A stand-in afplay sleeps instead of playing, so nothing is ever heard.
import { quiet, DATA } from "./helpers.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const bin = join(DATA, "fake-bin");
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "afplay"), "#!/bin/sh\nexec sleep 20\n");
chmodSync(join(bin, "afplay"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { alert, stopPlaying, loadHistory, saveConfig, normalize } = await import("../core.mjs");
const base = { ...quiet, chime: false, volume: { auto: false } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("Stop ends the alert that's speaking and drops the ones waiting behind it", async () => {
  saveConfig(normalize(base));
  const t0 = Date.now();
  const a = alert("completed", { force: true, source: "test" });
  const b = alert("review", { force: true, source: "test" });
  await wait(400);
  assert.equal(existsSync(join(DATA, "playing.lock")), true);
  assert.deepEqual(stopPlaying(), { stopped: true });
  await Promise.all([a.done, b.done]);
  assert.ok(Date.now() - t0 < 5000, "stopped long before the 20 s clip ended");
  assert.equal(existsSync(join(DATA, "playing.lock")), false);
  const stopped = loadHistory().filter((h) => h.result === "stopped");
  assert.deepEqual(stopped.map((h) => h.status).sort(), ["completed", "review"]);
  assert.ok(stopped.every((h) => h.reason === "you pressed Stop"));
  assert.deepEqual(stopPlaying(), { stopped: false }); // nothing playing now
});

test("an alert called after Stop still plays", async () => {
  await wait(5);
  const r = alert("completed", { force: true, source: "test" });
  await wait(400);
  assert.equal(existsSync(join(DATA, "playing.lock")), true);
  stopPlaying();
  await r.done;
});

test("the mic opening mid-alert stops it", async () => {
  // The call detector says no mic for its first answer, then the mic comes on.
  const helperDir = join(DATA, "bin");
  mkdirSync(helperDir, { recursive: true });
  const count = join(DATA, "polls");
  writeFileSync(
    join(helperDir, "media-in-use"),
    `#!/bin/sh\nn=$(cat "${count}" 2>/dev/null || echo 0); echo $((n+1)) > "${count}"\nif [ "$n" -lt 1 ]; then echo '{"mic":false,"camera":false}'; else echo '{"mic":true,"camera":false}'; fi\n`,
  );
  chmodSync(join(helperDir, "media-in-use"), 0o755);
  saveConfig(normalize({ ...base, cooldown_seconds: 0, calls: { mic: true, camera: true, focus: false } }));
  const t0 = Date.now();
  const r = alert("completed", { source: "test" });
  assert.equal(r.played, true, r.reason);
  await r.done;
  assert.ok(Date.now() - t0 < 6000, "stopped when the mic came on");
  assert.equal(loadHistory()[0].result, "stopped");
  assert.equal(loadHistory()[0].reason, "the microphone came on");
});
