// Where heads-up keeps things.
//   ROOT  the code and built-in voices (the repository; safe to publish)
//   DATA  this user's settings, alert log, hook state and generated audio:
//         ~/Library/Application Support/heads-up, or $HEADS_UP_HOME

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const DATA = process.env.HEADS_UP_HOME || join(homedir(), "Library", "Application Support", "heads-up");
mkdirSync(DATA, { recursive: true });
