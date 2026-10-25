// Where heads-up keeps things.
//   ROOT    the code and built-in voices (a checkout, or the copy a plugin install made)
//   DATA    this user's settings, alert log, hook state and generated audio:
//           ~/Library/Application Support/heads-up, or $HEADS_UP_HOME
//   HELPER  the call detector, built into DATA/bin so it survives plugin updates

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const DATA = process.env.HEADS_UP_HOME || join(homedir(), "Library", "Application Support", "heads-up");
mkdirSync(DATA, { recursive: true });

export const HELPER = [join(DATA, "bin", "media-in-use"), join(ROOT, "bin", "media-in-use")].find((p) => existsSync(p)) ?? join(DATA, "bin", "media-in-use");

// The headsup command (~/.local/bin/headsup) runs the code from DATA/root: the copy that ran last.
// A plugin update moves the code, so every run keeps this pointing at itself.
const ROOT_FILE = join(DATA, "root");
try {
  if (readFileSync(ROOT_FILE, "utf8") !== ROOT) writeFileSync(ROOT_FILE, ROOT);
} catch {
  try {
    writeFileSync(ROOT_FILE, ROOT);
  } catch {
    // read-only DATA: the command falls back to where it was installed from
  }
}
