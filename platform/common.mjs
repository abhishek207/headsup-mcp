// Small helpers the platform modules share.

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export const MAC = /^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/i;

export const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : fallback);

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const runnable = (p) => {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Where a command is on PATH (with its .exe or .cmd on Windows), looked up without a shell.
export function which(cmd) {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const d of dirs) for (const e of exts) if (runnable(join(d, cmd + e))) return join(d, cmd + e);
  return null;
}
export const has = (cmd) => which(cmd) !== null;

// Command output in English, whatever the user's language, so it can be parsed.
export const C_LOCALE = () => ({ ...process.env, LC_ALL: "C", LANG: "C" });
