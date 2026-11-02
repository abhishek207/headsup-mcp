// Stopping an alert mid-sentence: Stop (CLI/page) and the mic opening while it speaks.
// A stand-in player (afplay on macOS, pw-play on Linux) sleeps instead of playing, so
// nothing is ever heard. Windows has no /bin/sh for the stand-ins, so it skips these.
import { quiet, DATA } from "./helpers.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const bin = join(DATA, "fake-bin");
mkdirSync(bin, { recursive: true });
for (const player of ["afplay", "pw-play"]) {
  writeFileSync(join(bin, player), "#!/bin/sh\nexec sleep 20\n");
  chmodSync(join(bin, player), 0o755);
}
const skip = process.platform === "win32" && "needs /bin/sh stand-ins";
process.env.PATH = `${bin}:${process.env.PATH}`;

const { alert, stopPlaying, loadHistory, saveConfig, normalize } = await import("../core.mjs");
const base = { ...quiet, chime: false, volume: { auto: false } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("Stop ends the alert that's speaking and drops the ones waiting behind it", { skip }, async () => {
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

test("an alert called after Stop still plays", { skip }, async () => {
  await wait(5);
  const r = alert("completed", { force: true, source: "test" });
  await wait(400);
  assert.equal(existsSync(join(DATA, "playing.lock")), true);
  stopPlaying();
  await r.done;
});

test("the mic opening mid-alert stops it", { skip }, async () => {
  // The call detector says no mic for its first answer, then the mic comes on: the Mac's
  // media-in-use helper, or PipeWire's graph from pw-dump on Linux.
  const helperDir = join(DATA, "bin");
  mkdirSync(helperDir, { recursive: true });
  const count = join(DATA, "polls");
  const answer = (off, on) => `#!/bin/sh\nn=$(cat "${count}" 2>/dev/null || echo 0); echo $((n+1)) > "${count}"\nif [ "$n" -lt 1 ]; then echo '${off}'; else echo '${on}'; fi\n`;
  const micNode = JSON.stringify([{ type: "PipeWire:Interface:Node", info: { state: "running", props: { "media.class": "Stream/Input/Audio", "application.name": "Zoom" } } }]);
  writeFileSync(join(helperDir, "media-in-use"), answer('{"mic":false,"camera":false}', '{"mic":true,"camera":false}'));
  writeFileSync(join(bin, "pw-dump"), answer("[]", micNode));
  chmodSync(join(helperDir, "media-in-use"), 0o755);
  chmodSync(join(bin, "pw-dump"), 0o755);
  saveConfig(normalize({ ...base, cooldown_seconds: 0, calls: { mic: true, camera: true, focus: false } }));
  const t0 = Date.now();
  const r = alert("completed", { source: "test" });
  assert.equal(r.played, true, r.reason);
  await r.done;
  assert.ok(Date.now() - t0 < 6000, "stopped when the mic came on");
  assert.equal(loadHistory()[0].result, "stopped");
  assert.equal(loadHistory()[0].reason, "the microphone came on");
});
