import { DATA } from "./helpers.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The Linux and Windows modules only run commands when asked, so their parsers can be
// tested on any system with fixtures.
const linux = await import("../platform/linux.mjs");
const win = await import("../platform/win32.mjs");
const darwin = await import("../platform/darwin.mjs");
const { defaultData, claudeAppData } = await import("../paths.mjs");
const install = await import("../tools/install.mjs");

const INTERFACE = ["words", "chimes", "extraPath", "play", "audioReady", "getVolume", "setVolume", "outputDevice", "mediaInUse", "callsReady", "callsSetup", "focusReadable", "activeFocus", "focusUnreadable", "idleSeconds", "currentNetworks", "secretRead", "secretSave", "secretDelete", "secretDeleteHint", "openUrl"];

test("every platform module has the whole interface and the same words", () => {
  for (const [name, m] of Object.entries({ darwin, linux, win })) {
    for (const k of INTERFACE) assert.ok(m[k] !== undefined, `${name} is missing ${k}`);
    assert.deepEqual(Object.keys(m.words).sort(), Object.keys(darwin.words).sort(), `${name} words`);
  }
});

test("data folder per platform", () => {
  assert.equal(defaultData("darwin", {}, "/Users/a"), "/Users/a/Library/Application Support/heads-up");
  assert.equal(defaultData("linux", {}, "/home/a"), "/home/a/.local/share/heads-up");
  assert.equal(defaultData("linux", { XDG_DATA_HOME: "/data" }, "/home/a"), "/data/heads-up");
  assert.match(defaultData("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a"), /AppData.Local.heads-up$/);
  // The Claude desktop app's folder (for chat titles).
  assert.equal(claudeAppData("darwin", {}, "/Users/a"), "/Users/a/Library/Application Support/Claude");
  assert.equal(claudeAppData("linux", {}, "/home/a"), "/home/a/.config/Claude");
  assert.match(claudeAppData("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a"), /Roaming.Claude$/);
});

// pactl list sinks (PipeWire's pactl, C locale), trimmed.
const SINKS = `Sink #46
	State: SUSPENDED
	Name: alsa_output.pci-0000_00_1f.3.analog-stereo
	Description: Built-in Audio Analog Stereo
	Mute: no
	Volume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB
	Properties:
		device.bus = "pci"
		device.form_factor = "internal"
	Ports:
		analog-output-speaker: Speakers (type: Speaker, priority: 10000, availability unknown)
		analog-output-headphones: Headphones (type: Headphones, priority: 9900, not available)
	Active Port: analog-output-speaker

Sink #81
	State: RUNNING
	Name: bluez_output.AC_80_0A_11_22_33.1
	Description: WH-1000XM4
	Mute: yes
	Volume: front-left: 45875 /  70% / -9.29 dB,   front-right: 45875 /  70% / -9.29 dB
	Properties:
		device.bus = "bluetooth"
		device.form_factor = "headset"
	Active Port: headset-output
`;

test("Linux: sinks, default sink and headphones", () => {
  const [speaker, bt] = linux.parseSinks(SINKS);
  assert.equal(speaker.name, "alsa_output.pci-0000_00_1f.3.analog-stereo");
  assert.equal(speaker.vol, 40);
  assert.equal(speaker.muted, false);
  assert.equal(linux.headphonesFor(speaker), false);
  assert.equal(bt.vol, 70);
  assert.equal(bt.muted, true);
  assert.equal(linux.headphonesFor(bt), true);
  // The same card with the headphone jack in use.
  assert.equal(linux.headphonesFor({ ...speaker, port: "analog-output-headphones" }), true);
  assert.equal(linux.headphonesFor(null), true, "unknown device: headphone limits");
  assert.equal(linux.defaultSinkName("Server Name: PulseAudio (on PipeWire 1.0.5)\nDefault Sink: bluez_output.AC_80_0A_11_22_33.1\n"), "bluez_output.AC_80_0A_11_22_33.1");
  assert.equal(linux.defaultSinkName(""), null);
});

const node = (props, state = "running") => ({ type: "PipeWire:Interface:Node", info: { state, props } });

test("Linux: calls from the PipeWire graph", () => {
  assert.deepEqual(linux.parsePwDump([]), { mic: false, camera: false });
  assert.deepEqual(linux.parsePwDump([node({ "media.class": "Stream/Input/Audio", "application.name": "Zoom" })]), { mic: true, camera: false });
  assert.deepEqual(linux.parsePwDump([node({ "media.class": "Stream/Input/Audio", "application.name": "Zoom" }, "idle")]), { mic: false, camera: false }, "a paused stream isn't a call");
  assert.deepEqual(linux.parsePwDump([node({ "media.class": "Stream/Input/Audio", "stream.monitor": "true" })]), { mic: false, camera: false }, "level meters don't count");
  assert.deepEqual(linux.parsePwDump([node({ "media.class": "Stream/Input/Audio", "stream.capture.sink": true })]), { mic: false, camera: false }, "recording the output doesn't count");
  assert.deepEqual(linux.parsePwDump([node({ "media.class": "Stream/Input/Audio", "application.name": "pavucontrol" })]), { mic: false, camera: false });
  assert.deepEqual(linux.parsePwDump([node({ "media.class": "Video/Source" })]), { mic: false, camera: true });
  assert.deepEqual(linux.parsePwDump([node({ "media.class": "Video/Source" }, "suspended")]), { mic: false, camera: false });
  assert.deepEqual(linux.parsePwDump({ not: "an array" }), { mic: false, camera: false });
});

test("Linux: calls from pactl on plain PulseAudio", () => {
  const out = (source, corked, app) => `Source Output #12\n\tDriver: protocol-native.c\n\tSource: ${source}\n\tCorked: ${corked}\n\tProperties:\n\t\tapplication.name = "${app}"\n`;
  assert.equal(linux.parseSourceOutputs(out("1", "no", "Firefox")), true);
  assert.equal(linux.parseSourceOutputs(out("1", "yes", "Firefox")), false, "corked: not recording");
  assert.equal(linux.parseSourceOutputs(out("2", "no", "OBS"), ["2", "alsa_output.monitor"]), false, "reading a monitor");
  assert.equal(linux.parseSourceOutputs(out("1", "no", "PulseAudio Volume Control")), false);
  assert.equal(linux.parseSourceOutputs(""), false);
});

test("Linux: camera holders from /proc", () => {
  const proc = mkdtempSync(join(tmpdir(), "proc-"));
  const fake = (pid, comm, target) => {
    mkdirSync(join(proc, pid, "fd"), { recursive: true });
    writeFileSync(join(proc, pid, "comm"), `${comm}\n`);
    symlinkSync(target, join(proc, pid, "fd", "3"));
  };
  fake("100", "zoom", "/dev/video0");
  fake("200", "bash", "/dev/null");
  mkdirSync(join(proc, "self"));
  assert.deepEqual(linux.videoHolders(proc), ["zoom"]);
  assert.deepEqual(linux.videoHolders(join(proc, "missing")), []);
});

test("Linux: Do Not Disturb asks the session's desktop first", () => {
  const check = (when, value) => ({ when, read: () => value });
  const always = (value) => ({ read: () => value });
  assert.equal(linux.dndState("gnome:ubuntu", [check(/gnome/, true), always(false)]), true);
  assert.equal(linux.dndState("kde:plasma", [check(/gnome/, true), always(false)]), false, "another desktop's check is skipped");
  assert.equal(linux.dndState("sway", [always(null), always(true)]), true, "can't tell: next check");
  assert.equal(linux.dndState("sway", [always(null)]), null, "nothing can tell: unreadable, never 'off'");
});

test("Linux: locations from /proc/net", () => {
  const proc = mkdtempSync(join(tmpdir(), "proc-"));
  mkdirSync(join(proc, "net"));
  writeFileSync(
    join(proc, "net", "route"),
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\nwlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\nwlp2s0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n"
  );
  writeFileSync(
    join(proc, "net", "arp"),
    "IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.1      0x1         0x2         a4:2b:b0:11:22:33     *        wlp2s0\n192.168.1.20     0x1         0x2         00:11:22:33:44:55     *        wlp2s0\n"
  );
  assert.deepEqual(linux.parseRoutes("Iface\tDestination\tGateway\nwlp2s0\t00000000\t0101A8C0\n"), [{ iface: "wlp2s0", router: "192.168.1.1" }]);
  assert.deepEqual(linux.currentNetworks(proc), [{ iface: "wlp2s0", router: "192.168.1.1", mac: "a4:2b:b0:11:22:33" }]);
  assert.deepEqual(linux.currentNetworks(join(proc, "missing")), []);
});

test("Linux: no sound server means no alert", () => {
  const rt = mkdtempSync(join(tmpdir(), "run-"));
  assert.equal(linux.audioReady({ PULSE_SERVER: "tcp:host" }), true);
  assert.equal(linux.audioReady({ XDG_RUNTIME_DIR: rt, SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }), false);
  writeFileSync(join(rt, "pipewire-0"), "");
  assert.equal(linux.audioReady({ XDG_RUNTIME_DIR: rt }), true);
});

test("Windows: default routes and the router's MAC", () => {
  const ROUTE = `===========================================================================
IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.0.1    192.168.0.42     35
===========================================================================
Persistent Routes:
  None
`;
  assert.deepEqual(win.parseRoutePrint(ROUTE), [{ router: "192.168.0.1", iface: "192.168.0.42" }]);
  assert.deepEqual(win.parseRoutePrint(""), []);
  const ARP = `
Interface: 192.168.0.42 --- 0x7
  Internet Address      Physical Address      Type
  192.168.0.1           a4-2b-b0-11-22-33     dynamic
  192.168.0.10          00-11-22-33-44-55     dynamic
`;
  assert.equal(win.parseArpA(ARP, "192.168.0.1"), "a4:2b:b0:11:22:33");
  assert.equal(win.parseArpA(ARP, "192.168.0.100"), null, "no partial matches");
  assert.equal(win.parseArpA(ARP, "192.168.0.2"), null);
});

test("Windows: headphones from the endpoint", () => {
  assert.equal(win.headphonesFor({ name: "Speakers (Realtek(R) Audio)", formFactor: 1, enumerator: "HDAUDIO" }), false);
  assert.equal(win.headphonesFor({ name: "Headphones (Realtek(R) Audio)", formFactor: 3, enumerator: "HDAUDIO" }), true);
  assert.equal(win.headphonesFor({ name: "Headset (WH-1000XM4)", formFactor: 5, enumerator: "BTHENUM" }), true);
  assert.equal(win.headphonesFor({ name: "Speakers (USB Audio)", formFactor: 1, enumerator: "USB" }), true, "USB: assume a headset");
  assert.equal(win.headphonesFor(null), true);
  assert.equal(win.audioReady({ SSH_CONNECTION: "x" }), false);
  assert.equal(win.audioReady({}), true);
});

test("installer: the headsup command per platform", { skip: process.platform === "win32" && "needs /bin/sh" }, () => {
  assert.match(install.shim("/usr/bin/node", "/opt/x", "darwin"), /Library\/Application Support\/heads-up/);
  const lin = install.shim("/usr/bin/node", "/opt/x", "linux");
  assert.match(lin, /XDG_DATA_HOME:-\$HOME\/\.local\/share/);
  // The Linux shim runs the copy recorded in DATA/root, with DATA found the way paths.mjs finds it.
  const xdg = mkdtempSync(join(tmpdir(), "shim-xdg-"));
  const root = mkdtempSync(join(tmpdir(), "shim-root-"));
  writeFileSync(join(root, "cli.mjs"), "console.log('ran ' + process.argv.slice(2).join(' '))");
  mkdirSync(join(xdg, "heads-up"));
  writeFileSync(join(xdg, "heads-up", "root"), root);
  const file = join(DATA, "headsup-linux");
  writeFileSync(file, install.shim(process.execPath, "/nowhere", "linux"));
  const env = { ...process.env, XDG_DATA_HOME: xdg };
  delete env.HEADS_UP_HOME;
  assert.equal(spawnSync("/bin/sh", [file, "status"], { encoding: "utf8", env }).stdout.trim(), "ran status");
  assert.equal(defaultData("linux", { XDG_DATA_HOME: xdg }), join(xdg, "heads-up"));

  const cmd = install.shim("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a%b\\heads-up", "win32");
  assert.match(cmd, /^@echo off\r\n/);
  assert.match(cmd, /rem # heads-up command/, "uninstall recognises it");
  assert.match(cmd, /set "root=C:\\Users\\a%%b\\heads-up"/, "% is escaped");
  assert.match(cmd, /"%node%" "%root%\\cli\.mjs" %\*/);
});

test("installer: PATH check and Linux package hints", () => {
  assert.equal(install.onPath("C:\\Users\\A\\.local\\bin", "C:\\Windows;c:\\users\\a\\.local\\bin\\", "win32"), true);
  assert.equal(install.onPath("/home/a/.local/bin", "/usr/bin:/home/a/.local/bin/", "linux"), true);
  assert.equal(install.onPath("/home/a/.local/bin", "/usr/bin:/home/A/.local/bin", "linux"), false);
  assert.equal(install.linuxFamily('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n'), "apt");
  assert.equal(install.linuxFamily('ID="fedora"\n'), "dnf");
  assert.equal(install.linuxFamily("ID=manjaro\nID_LIKE=arch\n"), "pacman");
  assert.equal(install.linuxFamily('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n'), "zypper");
  assert.equal(install.linuxFamily("ID=nixos\n"), null);
  assert.equal(install.linuxInstall(["pw-play", "pw-dump", "pactl"], "apt"), "sudo apt install pipewire-bin pulseaudio-utils");
  assert.match(install.linuxInstall(["ffmpeg"], null), /package manager/);
});
