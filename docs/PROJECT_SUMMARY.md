# Heads-up: project summary

A detailed handover of everything built so far, why it's built this way, and what's next. Written so a new Claude thread (or Claude Project) can pick up without the original conversation.

*Last updated: 25 October 2026. Version 1.4.0.*

---

## 1. What it is and why

**Problem.** Claude Code often runs for minutes, then stops to ask for a review, an approval or an answer. If you've walked away from the Mac, you don't know it's waiting.

**Solution.** Heads-up plays a short spoken line on the Mac's speaker ("Hello from Kosh. I need your review.") so you can hear it from across the room and come back. It's a local MCP server (one tool, `notify_user`) plus Claude Code hooks, with a settings page and a CLI.

**Owner and audience.** Built by Abhishek (GitHub `abhishek207`) for his own Mac first. **Nothing is public or free yet** (owner's decision, 25 Oct 2026): the repo stays private and nothing goes to npm or online until the owner decides on release and monetization. Anything that costs money (recording new audio) must use **each user's own ElevenLabs or Sarvam API key**; the built-in clips need no key.

**Principles that came out of the build**
- Speak only when it's useful: never while you're typing, on a call, in Focus, or away from home.
- Never surprise the ears: volume is capped, especially on AirPods.
- Never depend on Claude remembering: hooks cover permission prompts and long tasks.
- Nothing leaves the Mac except the user's own TTS calls; keys live in the Keychain.

---

## 2. Owner preferences (decided during the build)

These were explicit requests; keep them unless the owner changes them.

| Topic | Decision |
|---|---|
| Voice | Deep **American male**: ElevenLabs **Brian** (`american-male`). Rejected: Indian accent for himself, Sarah, River (too neutral), Eric (not heavy enough). |
| Wording | First person **"I"**, never "we". **No user name** in the audio (it's going public): "Hello." or "Hello from <project>.", then a **0.6 s pause**, then the message. Natural delivery (stability 0.4, style 0.25). |
| Alerts at | **Home** only (location lock on, Home network saved). |
| UI | **Liquid glass** on a clean gradient, **SF Pro** (professional, no italics, nothing decorative), modern design language, Auto/Light/Dark switch the user can change, hidden scrollbars. Earlier rejected: warm terracotta/beige; Schibsted Grotesk felt less professional. |
| Name | **Heads-up**: MCP server `heads-up`, command `headsup`, repo `headsup-mcp`. (Earlier: `status-voice`, `claude-voice`.) |
| Keys | Users bring their own ElevenLabs / Sarvam key. |
| Model routing (global prefs) | Design/UI work suits Claude Opus; backend/refactors can go to Codex. See the owner's `~/.claude/CLAUDE.md`. |

---

## 3. Architecture

```
Claude Code session
 ├─ calls MCP tool notify_user {status} ──► server.mjs ─┐
 └─ hook events (prompt / notification / stop) ─► hook.mjs ─┤
                                                            ▼
                                   core.mjs: alert(status, {project})
                                     1. blockedReason() guardrails
                                     2. record to DATA/state.json
                                     3. queue playback:
                                        projectClip() → "Hello from X." + message (cached)
                                        else built-in voices/<voice>/<id>.mp3
                                        chime → volume nudge (capped) → afplay → restore volume
settings.mjs (127.0.0.1:4777) ── reads/writes DATA/config.json, plays tests, saves keys to Keychain
cli.mjs (headsup) ────────────── same config, status, tests
tts.mjs ───────────────────────── ElevenLabs/Sarvam with the user's key; ffmpeg join/extract
```

- **No npm dependencies.** Node 20+ ESM. MCP protocol is hand-rolled newline-delimited JSON-RPC over stdio (`initialize`, `tools/list`, `tools/call`, `ping`).
- **Config is re-read on every call**, so the page, CLI and every running session agree instantly.
- **Two folders** (`paths.mjs`): `ROOT` = this repo (code + voices; publishable). `DATA` = `~/Library/Application Support/heads-up` or `$HEADS_UP_HOME` (config, alert log, hook state, recorded segments, project-name cache).

### Files

See the table in `CLAUDE.md`. Roughly 2,000 lines total.

---

## 4. Features in detail

### 4.1 The MCP tool
`notify_user { status: <one of 20>, repeat?: 1–3, volume?: 0–100 }`. The description lists every status with when to use it (from `templates.json`'s `when`). Returns `Playing "<line>"` or `Not played: <reason>. This is the user's setting; don't retry.` The project is detected from the MCP server's working directory.

### 4.2 The 20 alerts
Needs you: `review`, `feedback`, `input`, `approval`, `question`, `blocked` ("I'm stuck, and I need your help."), `sign_in`, `reminder` ("I'm still waiting on you.").
Finished: `completed` ("I've completed the task."), `tests_passed`, `deployed`, `pr_ready`, `next_task`.
Problems: `error`, `tests_failed`, `deploy_failed`, `limit_warning`, `limit_reached`.
Updates: `long_task` ("This will take a while. I'll let you know when it's done."), `progress`.

### 4.3 Voices (140 built-in clips)
| Folder | Speaker | Provider | Voice ID |
|---|---|---|---|
| `american-male` (default) | Brian | ElevenLabs | `nPczCjzI2devNBz1zQrb` |
| `american-female` | Sarah | ElevenLabs | `EXAVITQu4vr4xnSDxMaL` |
| `british-male` | George | ElevenLabs | `JBFqnCBsd6RMkjVDRZzb` |
| `british-female` | Alice | ElevenLabs | `Xb7hH8MSUJpSbSDYk0k2` |
| `australian-male` | Charlie | ElevenLabs | `IKne3meq5aSn9XLyUdCD` |
| `indian-male` | Aditya | Sarvam Bulbul v3 | `aditya` |
| `indian-female` | Priya | Sarvam Bulbul v3 | `priya` |

Pipeline (`tools/generate.mjs`): synthesize the greeting and each message separately → trim edge silence → join with exactly 0.6 s → loudness-normalize to −16 LUFS, mono 44.1 kHz MP3. Raw segments are cached in `DATA/segments/<voice>/<id>-<sha1(text)[:8]>.*`, so changing one line only pays for that line. When the greeting changed from "Hey Abhishek." to "Hello.", the message parts were cut out of the existing tracks at the 0.6 s gap (`--extract`) and the whole library was rebuilt for 42 characters instead of ~2,800.

### 4.4 Project names
"Hello from Brand Bakery Hub. I need your review."
- Project = git repo name (worktrees resolve to the main repo via `git rev-parse --git-common-dir`), else folder name. Skipped: home folder, `scratch*`, `tmp`, `Downloads`, `Desktop`, `Dev`, hash-like names.
- Spoken name: user alias, else auto (`brand-bakery-hub` → "Brand Bakery Hub", acronyms like OCR/API/MCP upper-cased).
- First alert for a project: synthesize "Hello from X." (~16–25 chars) with the current voice's provider and the user's key, cut the message part from the built-in track if needed, join, cache in `DATA/cache/projects/...`. Next time it's instant (0 ms cached, ~95 ms if only the join is needed).
- Falls back to the plain clip if names are off, the project is muted, there's no key, the 20-per-day limit is hit, or anything fails.
- Page: per-project spoken-name field, preview, on/off.

### 4.5 Guardrails (in order)
1. `HEADS_UP_DISABLED=1` (per process, for tests)
2. Master switch (`enabled`)
3. Mute until a time (`muted_until`)
4. Per-alert switch (`statuses[id]`)
5. Quiet hours (can cross midnight)
6. Location lock: only on saved networks
7. Focus on (`calls.focus`)
8. Camera / microphone in use (`calls.camera`, `calls.mic`)
9. Away detection: idle < `away.idle_seconds` (default 60) → skip
10. Cooldown between played alerts (`cooldown_seconds`)
11. Hourly limit (`max_per_hour`)

Test buttons (`force`) skip guardrails but never the volume caps.

### 4.6 Detectors
- **Location**: router MAC of each `enN` interface (`ipconfig getoption enN router` + `arp`). No GPS, no Location Services. (macOS redacts the Wi-Fi name without that permission.)
- **Idle**: `ioreg -c IOHIDSystem` → `HIDIdleTime`.
- **Mic/camera**: `bin/media-in-use` (Swift, CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` on input devices; CoreMediaIO `kCMIODevicePropertyDeviceIsRunningSomewhere`). Reads state only; never opens a device; ~50 ms.
- **Focus**: `~/Library/DoNotDisturb/DB/Assertions.json` (manual Focus) and `ModeConfigurations.json` (names; enabled schedule triggers). Readable without Full Disk Access on this macOS. Sleep/smart triggers aren't visible.
- **Output device**: `system_profiler SPAudioDataType -json`; Bluetooth/USB or names like AirPods/headphones = headphone limits; unknown = headphone limits.

### 4.7 Volume safety
If auto volume is on and the Mac is muted or under the floor, raise to the target for the alert only, then restore volume and mute state. Headphones above their cap are lowered for the alert. Defaults: speakers floor 50 / target 65 / cap 80; headphones 15 / 25 / 35. Hard caps that no setting can exceed: speakers 90, headphones 50. Alerts are queued so overlapping alerts never fight over the restore.

### 4.8 Hooks (`hook.mjs`, registered in `~/.claude/settings.json`, all `async: true`)
- `UserPromptSubmit`: store turn start per session in `DATA/turns.json`.
- `Notification` (matcher `permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input`): permission → `approval`; elicitation/agent input → `input`; idle → `reminder` (off by default).
- `Stop`: if the turn lasted ≥ `hooks.long_turn_seconds` (default 120) and Claude didn't already call `notify_user` that turn, play `completed`, or `input` if `last_assistant_message` ends with "?".
- Background sessions are ignored: `CLAUDE_CODE_SESSION_ATTENDED=0` or entrypoint `sdk*`. (Headless children launched from the desktop app inherit `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, so the attended flag is the reliable signal.)
- Playback runs in a detached child so hooks return immediately. Every decision is logged to `DATA/hook.log`.

### 4.9 Settings page (`headsup` → http://127.0.0.1:4777)
Status panel (big state, live waveform of the real clip with a playhead sweep, play test, on/off, mute 15m/1h/4h, location, output, Mac volume, last input, calls, Focus, recent alerts with project and "automatic"/"test" tags). Sections: Voice, Alerts (grouped), Automatic alerts, Project names, Calls and Focus, Locations, Limits (away, quiet hours, gap, hourly, chime), Volume, Voice provider keys. Auto/Light/Dark theme saved per browser. Security: binds 127.0.0.1, rejects other Host headers (DNS rebinding), JSON-only POSTs with origin check (cross-site forms), clip endpoint only serves known voice/alert pairs. Stops itself after 30 idle minutes.

### 4.10 Keys
`tts.mjs` reads `ELEVENLABS_API_KEY` / `SARVAM_API_KEY`, then Keychain `heads-up-elevenlabs` / `heads-up-sarvam`, then the generic `elevenlabs-api-key` / `sarvam-api-key` (what the owner's other MCPs use). The page saves keys with `security -i` over stdin, so the key never appears in a process list; it never sends a key back to the browser.

### 4.11 CLI
`headsup [settings|on|off|mute [min]|unmute|status|test [alert]]`. `status` reports away detection on its own line, because typing the command always counts as activity.

---

## 5. Config reference (`DATA/config.json`)

```jsonc
{
  "enabled": true,
  "voice": "american-male",
  "muted_until": null,                 // ISO time
  "location_lock": false,
  "locations": [{ "name": "Home", "mac": "aa:bb:cc:dd:ee:ff" }],
  "statuses": { "completed": true /* …all 20 */ },
  "quiet_hours": { "enabled": false, "start": "23:00", "end": "08:00" },
  "cooldown_seconds": 20,              // 0–3600
  "max_per_hour": 20,                  // 1–120
  "chime": true,                       // Glass.aiff before the voice
  "away": { "enabled": true, "idle_seconds": 60 },
  "calls": { "mic": true, "camera": true, "focus": true },
  "project_names": { "enabled": true, "aliases": {}, "muted": [] },
  "hooks": { "permission": true, "long_turn": true, "long_turn_seconds": 120, "idle_reminder": false },
  "volume": {
    "auto": true,
    "speakers":   { "floor": 50, "target": 65, "cap": 80 },
    "headphones": { "floor": 15, "target": 25, "cap": 35 }
  },
  "wording": { "review": "Your review is needed." },   // edited alert lines (≤120 chars)
  "custom_voices": [                                    // up to 30, from the user's provider
    { "id": "el-<voice_id>", "provider": "elevenlabs", "provider_id": "<voice_id>", "name": "Rachel", "accent": "American", "gender": "Female", "fallback": "american-male" }
  ],
  "live": { "enabled": true, "max_chars": 160, "daily_chars": 1000, "fast": false }
}
```
Other data files: `state.json` (last 100 alerts: time, status, source `claude` / `hook:<Event>` / `settings test` / `cli test`, project, result, reason), `turns.json`, `hook.log`, `segments/`, `cache/projects/`, `archive/` (old clip sets and the pre-glass page).

---

## 6. The owner's machine setup (for reference)

- Repo: `~/Dev/headsup-mcp`. Compatibility links: `~/.claude/mcp-servers/heads-up` → repo, `~/.claude/mcp-servers/status-voice` → `heads-up` (for sessions started before the move; safe to delete once all sessions restart).
- MCP: `claude mcp add --scope user heads-up -- /Users/abhishek/.hermes/node/bin/node ~/Dev/headsup-mcp/server.mjs` (absolute node path, because the desktop app may not inherit the shell PATH).
- `~/.claude/settings.json`: allow `mcp__heads-up__notify_user`; the three hooks pointing at `~/Dev/headsup-mcp/hook.mjs`.
- `~/.local/bin/headsup` → `cli.mjs`.
- Global `~/.claude/CLAUDE.md` has a "Voice alerts (Heads-up MCP)" section telling Claude to call `notify_user` at the end of qualifying turns.
- Current settings: voice American male; location lock on with Home saved; cooldown 10 s; speakers target 44 % / max 53 %; headphones target 25 % / max 30 %; everything else default.
- Keys: existing Keychain items `elevenlabs-api-key` and `sarvam-api-key` are picked up automatically.

---

## 7. Costs so far

- **ElevenLabs** (free tier, 10,000 chars/month, resets ~21 Nov 2026): ~5,550 used this month by the end, including ~2,905 for the 100 ElevenLabs library clips, ~1,500 for early voice auditions (Sarah, River, Eric, Brian), 30 for the "Hello." rebuild, and ~16 for "Hello from Kosh." Cost: $0.
- **Sarvam**: ~1,400 chars total (40 Indian clips + early tests). A few rupees from free credits.
- Each new project name costs ~16–25 characters, once per voice.

---

## 8. Testing status

Verified for real:
- A fresh `claude -p` session called `notify_user` with no permission prompt and audio played.
- Long-turn Stop hook in a real 50 s session played "completed".
- Headless sessions are ignored by hooks (`attended=0`).
- Away detection blocks alerts while typing (seen repeatedly from real sessions).
- Project name from a real session in `~/Dev/Kosh`; "Hello from Kosh." recorded, cached and played; muting and switch-off fall back correctly.
- Volume raise-and-restore on speakers (30 % → 65 % → 30 %).
- Settings page in light, dark and phone width; theme switch persists; bad API key rejected; host/form protections (403/415).
- Hooks firing from the owner's other real sessions (e.g. brand-bakery-hub) appear in the log.

Not yet verified live:
- Permission-prompt hook from a real prompt (only simulated; headless runs can't show prompts).
- Mic/camera "in use" positive case (needs a real call) and Focus "on" (needs a Focus switched on). `headsup status` during a call will show it.
- AirPods volume cap with AirPods connected.
- Saving a key through the page (the owner should paste their own; Claude must never enter keys).

---

### 8.1 Automated tests (`npm test`, added in 1.3.1)
21 tests with `node:test`, no dependencies: config clamps and hard caps, guardrail order, quiet hours across midnight, cooldown and hourly limit, alert volume, Focus parsing from fixture files (manual, schedules, weekday bit), detector warnings, the cross-session play lock (including a dead holder), the MCP server over stdio, and the hooks (background sessions, short and long turns, permission prompt). They run in a temp `HEADS_UP_HOME` with `HEADS_UP_DISABLED=1`, so nothing plays.

### 8.2 Fixes in 1.3.1
- Call and Focus detection no longer fail silently. If `bin/media-in-use` isn't built or the Focus files can't be read, `headsup status`, the settings page ("Unavailable") and the MCP server log say so.
- Playback is locked across processes (`DATA/playing.lock`). Two sessions alerting at once used to be able to leave the volume at the alert level (the second read the raised volume as "before"). A crash mid-alert used to do the same; the next alert now restores the saved volume first.
- A fractional `repeat` (e.g. 1.5) made playback throw while the tool still said "Playing". It's rounded now.

### 8.3 Added in 1.4.0
- **Claude's own words.** `notify_user` takes an optional `message`. It's cleaned (`cleanMessage`: no code, links or markdown, cut at a word to `live.max_chars`), recorded in the current voice with the user's key ("Hello." is cut from the built-in track, so only the message costs), cached by text, and played through the same guardrails, lock and volume caps. Fallback order in `prepare()`: message with project name → message → alert line with project name → alert line → built-in track; the tool's answer says what was spoken and why anything was dropped. ElevenLabs "fast" option uses Flash v2.5 (half the credits).
- **Daily budget and usage log.** `live.daily_chars` (default 1,000 per provider per day) caps everything recorded automatically: live lines, project names, alerts in new voices. Page actions aren't capped. `DATA/usage.json` keeps 62 days of characters per provider and kind; the page and `headsup usage` show today and this month, plus the ElevenLabs plan counter (`/v1/user/subscription`, free).
- **Voice library.** "Add a voice" on the page lists the voices in the user's ElevenLabs account (`/v2/voices`, free, browser previews) or Sarvam's 37 Bulbul v3 speakers. Added voices live in `custom_voices` with a built-in `fallback`. Alerts in them are recorded on first play or all at once (cost shown first, ~570 characters for all 20).
- **Edit wording.** Pencil on each alert: save records only that line in the current voice; other voices record it on first play; "Use original" goes back to the built-in clip. The MCP tool description uses the edited words.
- **Keys.** ElevenLabs keys are checked before saving (free); a rejected key is never stored. "Test" speaks "Your key works." (~20 characters).
- **Installer.** `npm run setup` / `headsup install` (see README). `--dry-run`, `--uninstall`. Replaces older heads-up hooks (any path containing headsup-mcp, heads-up or status-voice) instead of doubling them.
- **Logo.** "Ping" mark (owner's pick from six options), `assets/logo.svg`, used as favicon and in the page header.
- Tests: 34, including the live/wording/library/budget paths with a fake TTS (`HEADS_UP_FAKE_TTS=1`) and the installer's settings edits. Tests can't read real keys (`HEADS_UP_NO_KEYCHAIN=1`).

Not yet verified live (1.4.0): real ElevenLabs/Sarvam calls for live lines, library listing and key check with the owner's keys; the page on the Mac; the installer against the owner's real `~/.claude/settings.json`.

## 9. Known limitations

- macOS only.
- Focus: Sleep and smart (location/app) triggers aren't readable; schedule weekday bit order is assumed (Sunday = bit 0).
- Sessions started before an update keep the old MCP code until restarted.
- The settings server must be started (`headsup`); it stops after 30 idle minutes (alerts don't need it).
- Mic-in-use also catches dictation apps (fine: you're at the keyboard then).

---

## 10. Backlog / ideas (owner hasn't chosen yet unless noted)

1. ~~Edit wording on the page~~ (done in 1.4.0).
2. ~~One-command installer~~ (done in 1.4.0: `npm run setup`).
3. **Phone push when away from home** (ntfy / Pushover / iMessage to self) instead of silence.
4. **Escalation**: repeat once after 5 minutes without a reply, then push to phone.
5. **Menu bar icon** for one-click mute and status.
6. **Start the settings page at login** (launchd).
7. **Weekly summary**: alerts played, average time Claude waited for you.
8. **Public release checklist**: pick a license; confirm ElevenLabs/Sarvam terms for redistributing generated audio (ElevenLabs free tier may require attribution / limit commercial use); add screenshots; decide whether to ship `bin/` prebuilt or build on install; make the repo public.

---

## 11. How to continue in a new thread

1. Open the repo (`~/Dev/headsup-mcp`) in Claude Code, or attach this file + the GitHub repo to a Claude Project.
2. Read `CLAUDE.md` (rules, testing, gotchas) and this file.
3. Restart any Claude sessions that were open during the move so they load the latest MCP code.
4. Pick the next item from the backlog.
