// Linux: PipeWire or PulseAudio for playback and the volume, PipeWire's graph (or Pulse's
// recording streams) plus /proc for calls, the desktop's own Do Not Disturb switch (GNOME,
// KDE Plasma, Xfce, dunst, swaync, mako), GNOME's idle monitor or xprintidle for idle time,
// /proc/net for locations and the Secret Service (GNOME Keyring, KWallet) for keys.
// Every check that can't see returns null, so the page and `headsup status` say so.

import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { C_LOCALE, MAC, clamp, has } from "./common.mjs";

const run = promisify(execFile);
// Output of a quick command in the C locale, or null if it's missing or fails.
const out = (cmd, args, timeout = 2000) => {
  if (!has(cmd)) return null;
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env: C_LOCALE(), stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout : null;
};

export const words = {
  os: "Linux",
  machine: "computer",
  volume: "Volume",
  focus: "Do Not Disturb",
  focusOn: "have Do Not Disturb on",
  focusWhen: "When Do Not Disturb is on",
  focusDesc: "Your desktop's Do Not Disturb switch",
  keyStore: "keyring",
  keyStoreFull: "keyring (GNOME Keyring or KWallet)",
  speakers: "Speakers",
  headphones: "Headphones and earbuds",
  micApps: "Zoom, Meet, Discord, dictation",
};
export const chimes = ["/usr/share/sounds/freedesktop/stereo/complete.oga", "/usr/share/sounds/freedesktop/stereo/message.oga"];
export const extraPath = [join(homedir(), ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin", "/home/linuxbrew/.linuxbrew/bin"];

// Is there a sound server to play to? Over SSH, in a container or on a server there isn't,
// and an alert would play into an empty room (or nowhere), so it's skipped with a reason.
export function audioReady(env = process.env) {
  if (env.PULSE_SERVER) return true;
  const rt = env.XDG_RUNTIME_DIR;
  if (rt && (existsSync(join(rt, "pulse", "native")) || existsSync(join(rt, env.PIPEWIRE_REMOTE || "pipewire-0")))) return true;
  return !env.SSH_CONNECTION && existsSync("/dev/snd") && has("ffplay"); // plain ALSA
}

// Players in order of preference. pw-play and paplay read MP3 only with libsndfile 1.1+
// (Ubuntu 24.04 has it, 22.04 doesn't), so a clip they can't open falls through to ffplay.
const PLAYERS = [
  ["pw-play", (f) => [f]],
  ["paplay", (f) => [f]],
  ["ffplay", (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f]],
  ["mpg123", (f) => ["-q", f], /\.mp3$/i],
];
const worked = new Map(); // file extension -> the player that played it last time

export async function play(file) {
  const ext = extname(file).toLowerCase();
  const first = worked.get(ext);
  const order = first ? [first, ...PLAYERS.filter((p) => p !== first)] : PLAYERS;
  let failed = null;
  for (const p of order) {
    const [cmd, args, only] = p;
    if ((only && !only.test(file)) || !has(cmd)) continue;
    try {
      await run(cmd, args(file), { timeout: 60_000 });
      worked.set(ext, p);
      return;
    } catch (e) {
      failed = `${cmd} couldn't play it`;
    }
  }
  throw new Error(failed ?? "no audio player found (install pipewire-bin, pulseaudio-utils or ffmpeg)");
}

export function openUrl(url) {
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

// `pactl list sinks` as objects. Text output works with every pactl version, PulseAudio's
// and PipeWire's; JSON output only exists from PulseAudio 16.
export function parseSinks(text) {
  return String(text ?? "").split(/^Sink #/m).slice(1).map((b) => {
    const field = (k) => b.match(new RegExp(`^[ \\t]*${k}:[ \\t]*(.*)$`, "m"))?.[1].trim() ?? null;
    const props = Object.fromEntries([...b.matchAll(/^[ \t]+([\w.-]+) = "(.*)"$/gm)].map((m) => [m[1], m[2]]));
    return { name: field("Name"), description: field("Description"), muted: field("Mute") === "yes", vol: Number(field("Volume")?.match(/(\d+)%/)?.[1]), port: field("Active Port"), props };
  });
}

export const defaultSinkName = (info) => String(info ?? "").match(/^Default Sink:\s*(.+)$/m)?.[1].trim() ?? null;

// Bluetooth or USB, a headphone form factor or port, or a name that says so. Unknown counts
// as headphones: assume ears are close.
export function headphonesFor(sink) {
  if (!sink) return true;
  const p = sink.props ?? {};
  if (/bluetooth|usb/i.test(p["device.bus"] ?? "") || /^bluez/i.test(sink.name ?? "")) return true;
  if (/headphone|headset|hands-?free|handset/i.test(p["device.form_factor"] ?? "")) return true;
  if (/headphone|headset/i.test(sink.port ?? "")) return true;
  return /headphone|airpods|buds|beats|headset/i.test(`${sink.description ?? ""} ${p["device.product.name"] ?? ""}`);
}

async function defaultSink() {
  const env = C_LOCALE();
  const [{ stdout: info }, { stdout: sinks }] = await Promise.all([run("pactl", ["info"], { env, timeout: 3000 }), run("pactl", ["list", "sinks"], { env, timeout: 3000 })]);
  const name = defaultSinkName(info);
  return parseSinks(sinks).find((s) => s.name === name) ?? null;
}

const WP_SINK = "@DEFAULT_AUDIO_SINK@";

export async function getVolume() {
  if (has("pactl")) {
    const s = await defaultSink();
    if (!s || !Number.isFinite(s.vol)) throw new Error("couldn't read the volume");
    return { vol: s.vol, muted: s.muted };
  }
  // WirePlumber only: "Volume: 0.50 [MUTED]"
  const { stdout } = await run("wpctl", ["get-volume", WP_SINK], { env: C_LOCALE(), timeout: 3000 });
  const v = Number(stdout.match(/Volume:\s*([\d.]+)/)?.[1]);
  if (!Number.isFinite(v)) throw new Error("couldn't read the volume");
  return { vol: Math.round(v * 100), muted: /MUTED/.test(stdout) };
}

// Only a number and a fixed word ever reach the command, even from a tampered lock file.
export async function setVolume(vol, muted) {
  const v = clamp(vol, 0, 100, 0);
  if (has("pactl")) {
    await run("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${v}%`], { timeout: 3000 });
    if (muted !== undefined) await run("pactl", ["set-sink-mute", "@DEFAULT_SINK@", muted === true ? "1" : "0"], { timeout: 3000 });
    return;
  }
  await run("wpctl", ["set-volume", WP_SINK, (v / 100).toFixed(2)], { timeout: 3000 });
  if (muted !== undefined) await run("wpctl", ["set-mute", WP_SINK, muted === true ? "1" : "0"], { timeout: 3000 });
}

export async function outputDevice() {
  try {
    const s = has("pactl") ? await defaultSink() : null;
    return s ? { name: s.description ?? s.name, headphones: headphonesFor(s) } : { name: "unknown", headphones: true };
  } catch {
    return { name: "unknown", headphones: true };
  }
}

// Calls. A level meter (a sound settings panel, pavucontrol) or an app recording the
// computer's own output also opens a capture stream; those don't count as a call.
const METERS = /pavucontrol|pwvucontrol|volume control|gnome-control-center|plasma-pa|kmix|helvum|qpwgraph|easyeffects|pulseeffects/i;
const yes = (v) => v === true || v === "true";

// From `pw-dump`: an app capturing audio, or a camera node streaming.
export function parsePwDump(json) {
  const nodes = (Array.isArray(json) ? json : []).filter((o) => o?.type === "PipeWire:Interface:Node" && o.info);
  const props = (n) => n.info.props ?? {};
  const running = (n) => n.info.state === "running";
  const meter = (n) => yes(props(n)["stream.monitor"]) || yes(props(n)["stream.capture.sink"]) || METERS.test(`${props(n)["application.name"] ?? ""} ${props(n)["application.process.binary"] ?? ""}`);
  return {
    mic: nodes.some((n) => props(n)["media.class"] === "Stream/Input/Audio" && running(n) && !meter(n)),
    camera: nodes.some((n) => props(n)["media.class"] === "Video/Source" && running(n)),
  };
}

// From `pactl list source-outputs` (plain PulseAudio): an uncorked recording that isn't
// reading a monitor (the output) and isn't a level meter.
export function parseSourceOutputs(text, monitors = []) {
  return String(text ?? "").split(/^Source Output #/m).slice(1).some((b) => {
    const source = b.match(/^[ \t]*Source:[ \t]*(\S+)/m)?.[1];
    const app = `${b.match(/application\.name = "(.*)"/)?.[1] ?? ""} ${b.match(/application\.process\.binary = "(.*)"/)?.[1] ?? ""}`;
    return /^[ \t]*Corked:[ \t]*no/m.test(b) && !monitors.includes(source) && !METERS.test(app);
  });
}

// Processes holding a camera device open (/dev/video*), by name. Only this user's
// processes are visible, which is the user making the call.
export function videoHolders(proc = "/proc") {
  const names = [];
  let pids = [];
  try {
    pids = readdirSync(proc).filter((p) => /^\d+$/.test(p));
  } catch {
    return names;
  }
  for (const pid of pids) {
    let fds;
    try {
      fds = readdirSync(join(proc, pid, "fd"));
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(join(proc, pid, "fd", fd));
      } catch {
        continue;
      }
      if (!/^\/dev\/video\d+$/.test(target)) continue;
      try {
        names.push(readFileSync(join(proc, pid, "comm"), "utf8").trim());
      } catch {
        names.push("unknown");
      }
      break;
    }
  }
  return names;
}

function pulseMic() {
  const outputs = out("pactl", ["list", "source-outputs"]);
  if (outputs === null) return null;
  const monitors = (out("pactl", ["list", "short", "sources"]) ?? "").split("\n").map((l) => l.split("\t")).filter((f) => /\.monitor$/.test(f[1] ?? "")).flatMap((f) => [f[0], f[1]]);
  return parseSourceOutputs(outputs, monitors);
}

// { mic, camera }, or null when nothing can be seen (no PipeWire or Pulse tools).
export function mediaInUse() {
  let graph = null;
  const dump = out("pw-dump", [], 3000);
  if (dump !== null) {
    try {
      graph = parsePwDump(JSON.parse(dump));
    } catch {
      graph = null;
    }
  }
  const mic = graph ? graph.mic : pulseMic();
  if (mic === null) return null;
  // PipeWire itself may hold a camera open on an app's behalf; its node state says if it's streaming.
  const camera = Boolean(graph?.camera) || videoHolders().some((n) => !/^(pipewire|wireplumber)/.test(n));
  return { mic, camera };
}

export const callsReady = () => has("pw-dump") || has("pactl");
export const callsSetup = "PipeWire's pw-dump and pactl weren't found. Install pipewire-bin or pulseaudio-utils.";

// Do Not Disturb. Each desktop keeps it somewhere else; the session's own desktop is asked
// first, then the notification daemons tiling setups use, then the Inhibited property
// that KDE (and some others) publish on the notifications service.
const desktop = () => `${process.env.XDG_CURRENT_DESKTOP ?? ""}:${process.env.DESKTOP_SESSION ?? ""}`.toLowerCase();
const is = (o, word) => (o === null ? null : o.trim() === word);

function inhibited() {
  const o = out("busctl", ["--user", "--auto-start=no", "get-property", "org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "Inhibited"]);
  return o === null ? null : /\btrue\b/.test(o);
}

function xfce() {
  if (!has("xfconf-query")) return null;
  const r = spawnSync("xfconf-query", ["-c", "xfce4-notifyd", "-p", "/do-not-disturb"], { encoding: "utf8", timeout: 2000, env: C_LOCALE() });
  if (r.status === 0) return r.stdout.trim() === "true";
  return /does not exist/i.test(r.stderr ?? "") ? false : null; // never switched: off
}

export const DND_CHECKS = [
  { when: /gnome|unity|ubuntu|pop|budgie/, read: () => is(out("gsettings", ["get", "org.gnome.desktop.notifications", "show-banners"]), "false") },
  { when: /kde|plasma/, read: inhibited },
  { when: /xfce/, read: xfce },
  { read: () => is(out("dunstctl", ["is-paused"]), "true") },
  { read: () => is(out("swaync-client", ["-D"]), "true") },
  { read: () => { const o = out("makoctl", ["mode"]); return o === null ? null : o.split(/\s+/).includes("do-not-disturb"); } },
  { read: inhibited },
];

// true (on), false (off) or null (can't tell), cached for a second: the page and the
// guardrails ask several times in a row.
let dndCache = { at: 0, value: null };
export function dndState(session = desktop(), checks = DND_CHECKS) {
  if (Date.now() - dndCache.at < 1000 && checks === DND_CHECKS) return dndCache.value;
  let value = null;
  for (const c of checks) {
    if (c.when && !c.when.test(session)) continue;
    value = c.read();
    if (value !== null) break;
  }
  if (checks === DND_CHECKS) dndCache = { at: Date.now(), value };
  return value;
}

export const focusReadable = () => dndState() !== null;
export const focusUnreadable = "this desktop's Do Not Disturb setting couldn't be read.";
export const activeFocus = () => (dndState() ? words.focus : null);

// Seconds since the last keyboard or mouse input, or null where the desktop doesn't say:
// GNOME (Wayland or X11) through Mutter's idle monitor, other X11 sessions through
// xprintidle. KDE on Wayland and wlroots compositors offer no way to ask.
export function idleSeconds() {
  if (/gnome|unity|ubuntu|pop|budgie/.test(desktop())) {
    const ms = Number(out("gdbus", ["call", "--session", "--dest", "org.gnome.Mutter.IdleMonitor", "--object-path", "/org/gnome/Mutter/IdleMonitor/Core", "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime"])?.match(/uint64 (\d+)/)?.[1]);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  if (process.env.DISPLAY && process.env.XDG_SESSION_TYPE !== "wayland") {
    const o = out("xprintidle", []);
    if (o !== null && /^\d+\s*$/.test(o)) return Number(o) / 1000;
  }
  return null;
}

// Location = the router's hardware (MAC) address, as on the Mac: the default routes from
// /proc/net/route, their gateways' MACs from /proc/net/arp. No commands, any interface.
const hexIp = (h) => [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join(".");

export function parseRoutes(text) {
  return String(text ?? "").trim().split("\n").slice(1).map((l) => l.trim().split(/\s+/))
    .filter((f) => f[1] === "00000000" && /^[0-9A-F]{8}$/i.test(f[2] ?? "") && f[2] !== "00000000")
    .map((f) => ({ iface: f[0], router: hexIp(f[2]) }));
}

export function parseArp(text) {
  return String(text ?? "").trim().split("\n").slice(1).map((l) => l.trim().split(/\s+/)).map((f) => ({ ip: f[0], mac: f[3], iface: f[5] }));
}

export function currentNetworks(proc = "/proc") {
  try {
    const arp = parseArp(readFileSync(join(proc, "net", "arp"), "utf8"));
    return parseRoutes(readFileSync(join(proc, "net", "route"), "utf8"))
      .map((r) => ({ ...r, mac: arp.find((a) => a.ip === r.router && a.iface === r.iface)?.mac?.toLowerCase() }))
      .filter((n, i, all) => n.mac && MAC.test(n.mac) && n.mac !== "00:00:00:00:00:00" && all.findIndex((x) => x.mac === n.mac) === i);
  } catch {
    return [];
  }
}

// Keys in the Secret Service (GNOME Keyring, KWallet) through secret-tool, which takes the
// secret on stdin, so it never shows in a process list. No keyring: environment only.
const SECRET_TIMEOUT = 10_000;

export function secretRead(service) {
  if (!has("secret-tool")) return null;
  const r = spawnSync("secret-tool", ["lookup", "service", service], { encoding: "utf8", timeout: SECRET_TIMEOUT, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export function secretSave(service, label, key) {
  if (!has("secret-tool")) throw new Error("There's no keyring tool to keep the key in. Install libsecret-tools (secret-tool), or set the key in your environment instead");
  const r = spawnSync("secret-tool", ["store", "--label", label, "service", service], { input: key, encoding: "utf8", timeout: SECRET_TIMEOUT });
  if (r.status !== 0) throw new Error("Couldn't save to your keyring. Is GNOME Keyring or KWallet running and unlocked?");
}

export function secretDelete(service) {
  if (has("secret-tool")) spawnSync("secret-tool", ["clear", "service", service], { timeout: SECRET_TIMEOUT, stdio: "ignore" });
}

export const secretDeleteHint = (service) => `secret-tool clear service ${service}`;
