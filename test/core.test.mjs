import { DATA, quiet } from "./helpers.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const core = await import("../core.mjs");
const { HARD_CAP, DEFAULTS, normalize, blockedReason, alertVolume, activeFocus, focusReadable, detectorProblems, spokenName, isProjectName, alert, withPlayLock } = core;

const at = (h, m = 0) => new Date(2026, 9, 25, h, m).getTime(); // a Sunday
const writeHistory = (history) => writeFileSync(join(DATA, "state.json"), JSON.stringify({ history }));

test("normalize fills defaults for an empty config", () => {
  const c = normalize({});
  assert.equal(c.enabled, true);
  assert.equal(c.voice, DEFAULTS.voice);
  assert.deepEqual(c.volume, DEFAULTS.volume);
  assert.equal(Object.keys(c.statuses).length, 20);
});

test("normalize never lets volume exceed the hard caps", () => {
  const c = normalize({ volume: { speakers: { floor: 99, target: 99, cap: 200 }, headphones: { floor: 80, target: 90, cap: 100 } } });
  assert.equal(c.volume.speakers.cap, HARD_CAP.speakers);
  assert.equal(c.volume.headphones.cap, HARD_CAP.headphones);
  assert.ok(c.volume.headphones.target <= c.volume.headphones.cap);
  assert.ok(c.volume.headphones.floor <= c.volume.headphones.target);
});

test("normalize rejects bad values", () => {
  const c = normalize({
    voice: "nope",
    cooldown_seconds: "lots",
    max_per_hour: 0,
    quiet_hours: { enabled: true, start: "25:00", end: "8am" },
    locations: [{ name: "Home", mac: "AA:BB:CC:DD:EE:FF" }, { mac: "not-a-mac" }, { mac: "aa:bb:cc:dd:ee:ff" }],
    project_names: { aliases: { kosh: "Kosh<script>", empty: "!!!" } },
    muted_until: "garbage",
  });
  assert.equal(c.voice, DEFAULTS.voice);
  assert.equal(c.cooldown_seconds, DEFAULTS.cooldown_seconds);
  assert.equal(c.max_per_hour, 1);
  assert.deepEqual([c.quiet_hours.start, c.quiet_hours.end], ["23:00", "08:00"]);
  assert.deepEqual(c.locations, [{ name: "Home", mac: "aa:bb:cc:dd:ee:ff" }]);
  assert.deepEqual(c.project_names.aliases, { kosh: "Koshscript" });
  assert.equal(c.muted_until, null);
});

test("guardrails: master switch, mute and per-alert switch", () => {
  writeHistory([]);
  assert.match(blockedReason("completed", normalize({ ...quiet, enabled: false }), at(12)), /switched off/);
  const muted = normalize({ ...quiet, muted_until: new Date(at(13)).toISOString() });
  assert.match(blockedReason("completed", muted, at(12)), /^muted until/);
  assert.equal(blockedReason("completed", muted, at(14)), null);
  assert.match(blockedReason("review", normalize({ ...quiet, statuses: { review: false } }), at(12)), /"review" alert is switched off/);
});

test("guardrails: env kill switch comes first", () => {
  process.env.HEADS_UP_DISABLED = "1";
  try {
    assert.match(blockedReason("completed", normalize({ enabled: false }), at(12)), /HEADS_UP_DISABLED/);
  } finally {
    delete process.env.HEADS_UP_DISABLED;
  }
});

test("guardrails: quiet hours that cross midnight", () => {
  writeHistory([]);
  const c = normalize({ ...quiet, quiet_hours: { enabled: true, start: "23:00", end: "08:00" } });
  assert.match(blockedReason("completed", c, at(23, 30)), /^quiet hours/);
  assert.match(blockedReason("completed", c, at(3)), /^quiet hours/);
  assert.equal(blockedReason("completed", c, at(8)), null);
  assert.equal(blockedReason("completed", c, at(22, 59)), null);
});

test("guardrails: location lock with nothing saved", () => {
  assert.match(blockedReason("completed", normalize({ ...quiet, location_lock: true }), at(12)), /no locations are saved/);
});

test("guardrails: cooldown and hourly limit", () => {
  const now = at(12);
  const played = (secsAgo) => ({ t: new Date(now - secsAgo * 1000).toISOString(), status: "completed", result: "played" });
  writeHistory([played(5)]);
  assert.match(blockedReason("completed", normalize({ ...quiet, cooldown_seconds: 20 }), now), /^cooldown/);
  writeHistory([played(30)]);
  assert.equal(blockedReason("completed", normalize({ ...quiet, cooldown_seconds: 20 }), now), null);
  writeHistory([played(100), played(200), played(300)]);
  assert.match(blockedReason("completed", normalize({ ...quiet, cooldown_seconds: 0, max_per_hour: 3 }), now), /^hourly limit/);
  writeHistory([{ ...played(5), result: "skipped" }]);
  assert.equal(blockedReason("completed", normalize({ ...quiet, cooldown_seconds: 20 }), now), null, "skipped alerts don't start a cooldown");
});

test("alert volume: raise when quiet, cap headphones, cap requests", () => {
  const sp = DEFAULTS.volume.speakers;
  const hp = DEFAULTS.volume.headphones;
  assert.equal(alertVolume({ vol: 30, muted: false }, sp, false), sp.target);
  assert.equal(alertVolume({ vol: 10, muted: true }, sp, false), sp.target);
  assert.equal(alertVolume({ vol: 70, muted: false }, sp, false), null);
  assert.equal(alertVolume({ vol: 90, muted: false }, hp, true), hp.cap);
  assert.equal(alertVolume({ vol: 20, muted: false }, hp, true), null);
  assert.equal(alertVolume({ vol: 20, muted: false }, hp, true, 100), hp.cap);
});

function focusDb({ manual, schedule }) {
  const db = mkdtempSync(join(tmpdir(), "focus-"));
  const triggers = schedule ? [{ class: "DNDModeConfigurationScheduleTrigger", enabledSetting: 2, ...schedule }] : [];
  writeFileSync(join(db, "ModeConfigurations.json"), JSON.stringify({ data: [{ modeConfigurations: { work: { mode: { name: "Work" }, triggers: { triggers } } } }] }));
  const records = manual ? [{ assertionDetails: { assertionDetailsModeIdentifier: "work" } }] : [];
  writeFileSync(join(db, "Assertions.json"), JSON.stringify({ data: [{ storeAssertionRecords: records }] }));
  return db;
}

test("Focus: manual, scheduled, and unreadable", () => {
  assert.equal(activeFocus(new Date(at(12)), focusDb({ manual: true })), "Work");
  assert.equal(activeFocus(new Date(at(12)), focusDb({})), null);
  // 22:00-07:00 on Sundays only (bit 0)
  const night = { timePeriodWeekdays: 1, timePeriodStartTimeHour: 22, timePeriodStartTimeMinute: 0, timePeriodEndTimeHour: 7, timePeriodEndTimeMinute: 0 };
  assert.equal(activeFocus(new Date(at(23)), focusDb({ schedule: night })), "Work");
  assert.equal(activeFocus(new Date(at(12)), focusDb({ schedule: night })), null);
  assert.equal(activeFocus(new Date(at(23)), focusDb({ schedule: { ...night, timePeriodWeekdays: 2 } })), null);
  const missing = mkdtempSync(join(tmpdir(), "focus-"));
  assert.equal(focusReadable(missing), false);
  assert.equal(focusReadable(focusDb({})), true);
});

test("detector problems are reported, not hidden", () => {
  const on = normalize({});
  assert.deepEqual(detectorProblems(on, { media: { mic: false, camera: false }, helper: true, focus: true }), []);
  const [notBuilt, noFocus] = detectorProblems(on, { media: null, helper: false, focus: false });
  assert.match(notBuilt, /headsup install/);
  assert.match(noFocus, /Focus detection/);
  assert.match(detectorProblems(on, { media: null, helper: true, focus: true })[0], /didn't answer/);
  assert.deepEqual(detectorProblems(normalize(quiet), { media: null, helper: false, focus: false }), [], "switched-off detectors don't warn");
});

test("project names", () => {
  assert.equal(spokenName("brand-bakery-hub", normalize({})), "Brand Bakery Hub");
  assert.equal(spokenName("ocr_api-tool", normalize({})), "OCR API Tool");
  assert.equal(spokenName("kosh", normalize({ project_names: { aliases: { kosh: "Kosh App" } } })), "Kosh App");
  for (const n of ["Downloads", "scratch-1", "tmp", "0123456789abcdef0123"]) assert.equal(isProjectName(n), false, n);
  assert.equal(isProjectName("Kosh"), true);
});

test("alert: unknown status is an error, a blocked one is recorded as skipped", () => {
  assert.equal(alert("nope").ok, false);
  process.env.HEADS_UP_DISABLED = "1";
  try {
    const r = alert("completed", { repeat: 1.5, project: "Kosh" });
    assert.equal(r.played, false);
    const last = core.loadHistory()[0];
    assert.equal(last.result, "skipped");
    assert.equal(last.project, "Kosh");
  } finally {
    delete process.env.HEADS_UP_DISABLED;
  }
});

test("play lock: one at a time, and a dead holder's lock is taken over", async () => {
  const lock = join(DATA, "playing.lock");
  const order = [];
  await Promise.all([
    withPlayLock(async () => (order.push("a+"), await new Promise((r) => setTimeout(r, 300)), order.push("a-"))),
    new Promise((r) => setTimeout(r, 50)).then(() => withPlayLock(async () => order.push("b"))),
  ]);
  assert.deepEqual(order, ["a+", "a-", "b"]);
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 1 })); // no such process
  assert.equal(await withPlayLock(async () => "ran", { waitMs: 1000 }), "ran");
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, JSON.stringify({ pid: process.pid })); // held by a live process
  await assert.rejects(withPlayLock(async () => {}, { waitMs: 300 }), /still playing/);
});
