// Every test file gets its own empty DATA folder, nothing ever plays, and no provider is called.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HEADS_UP_HOME = mkdtempSync(join(tmpdir(), "heads-up-test-"));
export const DATA = process.env.HEADS_UP_HOME;
// Never read the real Keychain or environment keys: no test may spend the user's credits.
process.env.HEADS_UP_NO_KEYCHAIN = "1";
delete process.env.ELEVENLABS_API_KEY;
delete process.env.SARVAM_API_KEY;
delete process.env.HEADS_UP_FAKE_TTS;

// Config with every live detector off, so results don't depend on the Mac running the tests.
export const quiet = { calls: { mic: false, camera: false, focus: false }, away: { enabled: false } };
