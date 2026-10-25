#!/usr/bin/env node
// Local settings page for heads-up: http://127.0.0.1:4777
// Started by `headsup settings`; shuts itself down after 30 idle minutes.

import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { GREETING, HARD_CAP, ROOT, TEMPLATES, activeFocus, alert, blockedReason, builtinVoices, clipFor, currentLocation, detectorProblems, findClip, getVolume, idleSeconds, isProjectName, libraryVoiceId, listVoices, loadConfig, loadHistory, nameRecorded, outputDevice, probeDetectors, recordAlerts, recordingCost, saveConfig, spokenName, textFor } from "./core.mjs";
import { composed, usageSummary, voiceInfo } from "./speech.mjs";
import { PROVIDERS, checkKey, deleteKey, elevenUsage, keySource, providerVoices, saveKey } from "./tts.mjs";

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

// ElevenLabs plan usage, refreshed at most every 5 minutes (it's a network call).
let account = { at: 0, value: null };
async function elevenAccount(fresh = false) {
  if (fresh || Date.now() - account.at > 5 * 60_000) account = { at: Date.now(), value: await elevenUsage() };
  return account.value;
}

async function state() {
  const config = loadConfig();
  const keys = Object.fromEntries(PROVIDERS.map((p) => [p, keySource(p)]));
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
    keys,
    greeting: GREETING,
    // What recording costs: characters spent per provider (today, this month) and, for
    // ElevenLabs, the plan's own counter.
    usage: usageSummary(),
    account: { elevenlabs: keys.elevenlabs ? await elevenAccount() : null },
    // Characters still needed to record every alert in each voice (built-in voices: only edited lines).
    recordCost: Object.fromEntries(listVoices(config).map((v) => [v, recordingCost(v, config)])),
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
    if (req.method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")) {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
      return res.end(readFileSync(join(ROOT, "assets", "logo.svg")));
    }
    if (req.method === "GET" && url.pathname === "/api/ping") return json(200, { ok: true, app: "heads-up" });
    if (req.method === "GET" && url.pathname === "/api/state") return json(200, await state());
    // Audio for the waveform display (only known voices and alerts).
    if (req.method === "GET" && url.pathname === "/api/clip") {
      const voice = url.searchParams.get("voice");
      const id = url.searchParams.get("id");
      const c = loadConfig();
      if (!listVoices(c).includes(voice) || !TEMPLATES.some((t) => t.id === id)) return json(404, { error: "unknown clip" });
      // The recorded version if the wording or voice isn't built in, else the built-in track.
      const text = textFor(id, c);
      const own = composed(voice, { greet: GREETING, greetId: "greeting", text, msgId: id });
      const builtIn = text === TEMPLATES.find((t) => t.id === id).text && findClip(voice, id);
      const file = own ?? builtIn ?? clipFor(voiceInfo(voice, c)?.fallback ?? voice, id);
      if (!file) return json(404, { error: "missing clip" });
      res.writeHead(200, { "content-type": file.endsWith(".wav") ? "audio/wav" : "audio/mpeg", "cache-control": "no-store" });
      return createReadStream(file).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      saveConfig(await readBody(req));
      return json(200, await state());
    }
    if (req.method === "POST" && url.pathname === "/api/test") {
      const { status, voice, project, message } = await readBody(req);
      const r = alert(status, {
        force: true,
        source: "settings test",
        voice,
        project: typeof project === "string" ? project : null,
        message: typeof message === "string" ? message : null,
      });
      if (!r.ok) return json(400, { error: r.error });
      // Wait for any recording, so the page can say what played and what it cost.
      const p = await r.prepared;
      return json(200, { played: true, line: p.line, live: p.live, note: p.note });
    }
    // Voices in the user's provider account (ElevenLabs) or Sarvam's speaker list. Free.
    if (req.method === "GET" && url.pathname === "/api/library") {
      try {
        return json(200, { voices: await providerVoices(url.searchParams.get("provider")) });
      } catch (e) {
        return json(400, { error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/voices/add") {
      // Added and selected at once; it falls back to the built-in voice in use until now.
      const v = await readBody(req);
      const c = loadConfig();
      const fallback = builtinVoices().includes(c.voice) ? c.voice : voiceInfo(c.voice, c)?.fallback;
      const id = libraryVoiceId(v);
      const next = saveConfig({ ...c, custom_voices: [...c.custom_voices, { ...v, fallback }], voice: id });
      if (next.voice !== id) return json(400, { error: "That voice couldn't be added" });
      return json(200, await state());
    }
    if (req.method === "POST" && url.pathname === "/api/voices/remove") {
      const { id } = await readBody(req);
      const c = loadConfig();
      const gone = c.custom_voices.find((v) => v.id === id);
      saveConfig({ ...c, custom_voices: c.custom_voices.filter((v) => v.id !== id), voice: c.voice === id ? gone?.fallback : c.voice });
      return json(200, await state());
    }
    // Record every alert in a voice now, with the user's key. The page shows the cost first.
    if (req.method === "POST" && url.pathname === "/api/voices/record") {
      const { voice } = await readBody(req);
      const c = loadConfig();
      if (!listVoices(c).includes(voice)) return json(400, { error: "unknown voice" });
      const r = await recordAlerts(voice, c);
      return json(200, { ...r, state: await state() });
    }
    // Change an alert's words (empty text restores the original) and record it in the current voice.
    if (req.method === "POST" && url.pathname === "/api/wording") {
      const { id, text } = await readBody(req);
      if (!TEMPLATES.some((t) => t.id === id)) return json(400, { error: "unknown alert" });
      const c = loadConfig();
      const wording = { ...c.wording };
      if (String(text ?? "").trim()) wording[id] = String(text);
      else delete wording[id];
      const next = saveConfig({ ...c, wording });
      if (String(text ?? "").trim() && !next.wording[id]) return json(400, { error: "Nothing speakable in that text" });
      const r = next.wording[id] ? await recordAlerts(next.voice, next, [id], "wording") : { spent: 0, note: null };
      return json(200, { ...r, state: await state() });
    }
    // Provider keys go straight into the macOS Keychain; they're never stored in config or sent back.
    if (req.method === "POST" && url.pathname === "/api/key") {
      const { provider, key } = await readBody(req);
      const clean = String(key ?? "").trim();
      try {
        // Check with ElevenLabs first (free); a rejected key is never saved.
        if ((await checkKey(provider, clean)) === "invalid") return json(400, { error: "ElevenLabs didn't accept that key" });
        saveKey(provider, clean);
      } catch (e) {
        return json(400, { error: e.message });
      }
      await elevenAccount(true);
      return json(200, await state());
    }
    // Speak a few words with a provider's key, so the user hears that it works (~20 characters).
    if (req.method === "POST" && url.pathname === "/api/key/test") {
      const { provider } = await readBody(req);
      const c = loadConfig();
      const voice = voiceInfo(c.voice, c)?.provider === provider ? c.voice : provider === "sarvam" ? "indian-male" : "american-male";
      const r = alert("completed", { force: true, source: "settings test", voice, message: "Your key works." });
      if (!r.ok) return json(400, { error: r.error });
      const p = await r.prepared;
      return p.live ? json(200, { line: p.line, state: await state() }) : json(400, { error: p.note ?? "That key didn't work" });
    }
    if (req.method === "POST" && url.pathname === "/api/key/delete") {
      deleteKey((await readBody(req)).provider);
      await elevenAccount(true);
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
