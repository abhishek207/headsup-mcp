#!/usr/bin/env node
// Local settings page for heads-up: http://127.0.0.1:4777
// Started by `headsup settings`; shuts itself down after 30 idle minutes.

import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { HARD_CAP, ROOT, TEMPLATES, activeFocus, alert, blockedReason, clipFor, currentLocation, detectorProblems, getVolume, idleSeconds, isProjectName, listVoices, loadConfig, loadHistory, nameRecorded, outputDevice, probeDetectors, saveConfig, spokenName } from "./core.mjs";
import { PROVIDERS, deleteKey, keySource, saveKey } from "./tts.mjs";

export const PORT = 4777;
const IDLE_MS = 30 * 60 * 1000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  } catch {
    return fallback;
  }
};

async function state() {
  const config = loadConfig();
  const [volume, device] = await Promise.all([getVolume().catch(() => null), outputDevice()]);
  const probe = probeDetectors();
  // Overall state: ignore per-alert switches (shown separately) and away
  // detection (you're always at the keyboard while using this page).
  const allOn = Object.fromEntries(Object.keys(config.statuses).map((s) => [s, true]));
  const reason = blockedReason("completed", { ...config, statuses: allOn, away: { ...config.away, enabled: false } });
  return {
    config,
    voices: listVoices(),
    voiceInfo: readJson("voices.json", {}),
    templates: TEMPLATES,
    hardCap: HARD_CAP,
    here: currentLocation(config),
    // Cooldown is pacing between alerts, not a reason the page should look "silent".
    blocked: reason && !reason.startsWith("cooldown") ? reason : null,
    history: loadHistory().slice(0, 25),
    volume,
    device,
    idle: idleSeconds(),
    media: probe.media,
    focus: activeFocus(),
    focusReadable: probe.focus,
    // Switched-on detectors that can't see anything (helper not built, Focus file unreadable).
    detectorProblems: detectorProblems(config, probe),
    projects: projects(config),
    // Where each provider's key comes from; the key itself never leaves the server.
    keys: Object.fromEntries(PROVIDERS.map((p) => [p, keySource(p)])),
  };
}

// Projects seen in the alert log, plus any with a saved alias or mute.
function projects(c) {
  const names = new Set([
    ...loadHistory().map((h) => h.project).filter(Boolean),
    ...Object.keys(c.project_names.aliases),
    ...c.project_names.muted,
  ]);
  return [...names].filter(isProjectName).sort((a, b) => a.localeCompare(b)).map((name) => ({
    name,
    spoken: spokenName(name, c),
    alias: c.project_names.aliases[name] ?? "",
    muted: c.project_names.muted.includes(name),
    recorded: nameRecorded(c.voice, name, c),
  }));
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });

let idleTimer;
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_MS);
};

const server = createServer(async (req, res) => {
  resetIdle();
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  // Only answer to localhost names (blocks DNS-rebinding) and JSON posts (blocks cross-site form posts).
  if (!ALLOWED_HOSTS.has(req.headers.host)) return json(403, { error: "forbidden host" });
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return json(403, { error: "forbidden origin" });
    if (!String(req.headers["content-type"]).startsWith("application/json")) return json(415, { error: "json only" });
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(join(ROOT, "settings.html")));
    }
    if (req.method === "GET" && url.pathname === "/api/ping") return json(200, { ok: true, app: "heads-up" });
    if (req.method === "GET" && url.pathname === "/api/state") return json(200, await state());
    // Audio for the waveform display (only known voices and alerts).
    if (req.method === "GET" && url.pathname === "/api/clip") {
      const voice = url.searchParams.get("voice");
      const id = url.searchParams.get("id");
      if (!listVoices().includes(voice) || !TEMPLATES.some((t) => t.id === id)) return json(404, { error: "unknown clip" });
      const file = clipFor(voice, id);
      if (!file) return json(404, { error: "missing clip" });
      res.writeHead(200, { "content-type": file.endsWith(".wav") ? "audio/wav" : "audio/mpeg", "cache-control": "no-store" });
      return createReadStream(file).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      saveConfig(await readBody(req));
      return json(200, await state());
    }
    if (req.method === "POST" && url.pathname === "/api/test") {
      const { status, voice, project } = await readBody(req);
      const r = alert(status, { force: true, source: "settings test", voice, project: typeof project === "string" ? project : null });
      return json(r.ok ? 200 : 400, r.ok ? { played: true, line: r.line } : { error: r.error });
    }
    // Provider keys go straight into the macOS Keychain; they're never stored in config or sent back.
    if (req.method === "POST" && url.pathname === "/api/key") {
      const { provider, key } = await readBody(req);
      try {
        saveKey(provider, String(key ?? "").trim());
      } catch (e) {
        return json(400, { error: e.message });
      }
      return json(200, await state());
    }
    if (req.method === "POST" && url.pathname === "/api/key/delete") {
      deleteKey((await readBody(req)).provider);
      return json(200, await state());
    }
    json(404, { error: "not found" });
  } catch (e) {
    json(500, { error: e.message });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") process.exit(0); // already running
  throw e;
});
server.listen(PORT, "127.0.0.1", resetIdle);
