// The OS-specific half of heads-up. core.mjs, tts.mjs and the CLI ask this module, never the
// OS, so the guardrails, play lock, volume caps and fallbacks are the same everywhere.
// Each platform module exports the same names:
//
//   words                  what the OS calls things ({ machine: "Mac", focus: "Focus", keyStore: "Keychain", ... })
//   chimes, extraPath      candidate chime files; directories to add to PATH for MCP and hook processes
//   play(file, signal?)    play one file to the end; aborting the signal stops it at once
//   audioReady()           false where no sound can reach anyone (SSH, containers)
//   getVolume(), setVolume(vol, muted?), outputDevice()
//   mediaInUse()           { mic, camera } or null; callsReady(), callsSetup
//   focusReadable(), activeFocus(), focusUnreadable
//   idleSeconds()          or null
//   currentNetworks()      [{ iface, router, mac }] for locations
//   secretRead/Save/Delete(service), secretDeleteHint(service)   the OS key store
//   openUrl(url)

const platform = process.platform === "darwin" ? await import("./darwin.mjs") : process.platform === "win32" ? await import("./win32.mjs") : await import("./linux.mjs");

export const {
  words,
  chimes,
  extraPath,
  play,
  audioReady,
  getVolume,
  setVolume,
  outputDevice,
  mediaInUse,
  callsReady,
  callsSetup,
  focusReadable,
  activeFocus,
  focusUnreadable,
  idleSeconds,
  currentNetworks,
  secretRead,
  secretSave,
  secretDelete,
  secretDeleteHint,
  openUrl,
} = platform;
