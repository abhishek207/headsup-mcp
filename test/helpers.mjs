// Every test file gets its own empty DATA folder, and nothing ever plays.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HEADS_UP_HOME = mkdtempSync(join(tmpdir(), "heads-up-test-"));
export const DATA = process.env.HEADS_UP_HOME;

// Config with every live detector off, so results don't depend on the Mac running the tests.
export const quiet = { calls: { mic: false, camera: false, focus: false }, away: { enabled: false } };
