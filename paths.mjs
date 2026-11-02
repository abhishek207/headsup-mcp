// Where heads-up keeps things.
//   ROOT    the code and built-in voices (a checkout, or the copy a plugin install made)
//   DATA    this user's settings, alert log, hook state and generated audio, or $HEADS_UP_HOME:
//             macOS    ~/Library/Application Support/heads-up
//             Linux    $XDG_DATA_HOME/heads-up (~/.local/share/heads-up)
//             Windows  %LOCALAPPDATA%\heads-up
//   HELPER  the small native helper, built into DATA/bin so it survives plugin updates:
//           the call detector on macOS, everything the OS needs on Windows, none on Linux

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));

export function defaultData(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "heads-up");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "heads-up");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "heads-up");
}

export const DATA = process.env.HEADS_UP_HOME || defaultData();
mkdirSync(DATA, { recursive: true, mode: 0o700 }); // private: alert log, Claude's lines, settings

const HELPER_NAME = { darwin: "media-in-use", win32: "headsup-win.exe" }[process.platform] ?? null;
export const HELPER = HELPER_NAME
  ? ([join(DATA, "bin", HELPER_NAME), join(ROOT, "bin", HELPER_NAME)].find((p) => existsSync(p)) ?? join(DATA, "bin", HELPER_NAME))
  : null;

// The headsup command (~/.local/bin/headsup) runs the code in DATA/root. The installer
// writes it; an installed plugin copy (under .../plugins/cache/...) keeps it current after
// an update moves the code. Checkouts and test copies never take it over.
export function rememberRoot(root = ROOT) {
  try {
    writeFileSync(join(DATA, "root"), root);
  } catch {
    // read-only DATA: the command falls back to where it was installed from
  }
}
const ROOT_FILE = join(DATA, "root");
const recorded = existsSync(ROOT_FILE) ? readFileSync(ROOT_FILE, "utf8") : null;
if (/[\\/]plugins[\\/]cache[\\/]/.test(ROOT) && recorded !== ROOT) rememberRoot();
