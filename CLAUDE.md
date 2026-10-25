# Heads-up: working notes for Claude

Local macOS MCP server + Claude Code hooks that speak short alerts ("Hello from Kosh. I need your review."). Zero npm dependencies, plain Node ESM, one small Swift helper. Full background and history: `docs/PROJECT_SUMMARY.md`.

## Map

| File | Role |
|---|---|
| `paths.mjs` | `ROOT` (this repo: code + built-in voices) and `DATA` (`~/Library/Application Support/heads-up` or `$HEADS_UP_HOME`: config, log, caches). |
| `core.mjs` | Config defaults + `normalize()` (all clamping/validation), guardrails (`blockedReason`), detectors (location, idle, mic/camera, Focus), project names, volume safety, playback queue, `prepare()` (which clip and words, with fallbacks), `alert()`. |
| `speech.mjs` | Recording beyond the built-in clips: `compose()` (greeting + 0.6 s + message, cached), `cleanMessage()`, daily budget, usage log (`DATA/usage.json`), library-voice lookup. |
| `tts.mjs` | ElevenLabs/Sarvam synthesis with the user's own key (env → Keychain), voice lists (ElevenLabs account, Sarvam speakers), key check, plan usage, Keychain save/delete via `security -i`, ffmpeg join/extract. Also widens `PATH` for MCP/hook processes. |
| `server.mjs` | MCP stdio server (hand-rolled JSON-RPC, async replies). One tool: `notify_user { status, message?, repeat?, volume? }`. Project = `projectFor(process.cwd())`. Waits up to 15 s for a live line so the answer says what was spoken. |
| `hook.mjs` | Claude Code hook entry: UserPromptSubmit (turn start), Notification (permission → `approval`), Stop (long turn → `completed`/`input`). Ignores background sessions. Plays in a detached child. Logs to `DATA/hook.log`. |
| `settings.mjs` + `settings.html` | Local settings page on 127.0.0.1:4777 (host/origin checks, JSON-only POSTs). HTML is re-read per request. |
| `cli.mjs` | `headsup` command: settings, on/off, mute/unmute, status, test, say, usage, install/uninstall. |
| `tools/install.mjs` | `npm run setup`: helper build, MCP registration, allow rule + hooks in `~/.claude/settings.json`, CLI link, CLAUDE.md section. Idempotent; `--dry-run`, `--uninstall`. Pure settings edits are exported for tests. |
| `assets/logo.svg` | Logo ("ping"), served as the page's favicon and header mark. |
| `templates.json` | Greeting + the 20 alerts (`id`, `text`, `when`). `when` feeds the MCP tool description. |
| `voices.json` | The 7 voices: accent, gender, speaker, provider, provider voice id. |
| `voices/<voice>/<id>.mp3` | 140 built-in clips ("Hello." + 0.6 s + message, −16 LUFS mono). |
| `tools/generate.mjs` | Rebuilds clips; caches raw segments in `DATA/segments` keyed by text hash so only changed text costs credits. `--dry-run` first, always. |
| `test/*.test.mjs` | `npm test` (node:test, no deps): config clamps, guardrail order, Focus parsing, detector warnings, play lock, MCP server, hooks, live lines/wording/library voices/budget (fake TTS), installer edits. Runs in a temp `HEADS_UP_HOME`, never plays audio, never reads real keys. |
| `tools/media-in-use.swift` | Builds `bin/media-in-use` (`npm run build`): prints `{"mic":bool,"camera":bool}` without opening devices. |

## Rules

- Never write API keys to config, logs or the page. Keys come from env or Keychain only (`tts.mjs`).
- User data goes in `DATA`, never in the repo. `.gitignore` backs this up.
- Config is re-read on every call; every new field needs a default in `DEFAULTS` and a clamp/validation in `normalize()`.
- Volume must stay under `HARD_CAP` (speakers 90, headphones 50). Unknown output device = headphone limits.
- Playback goes through `withPlayLock` (`DATA/playing.lock`): one alert at a time across all sessions, and the volume to restore is saved in the lock so a crash can't leave the Mac loud.
- A detector that can't see (helper not built, Focus file unreadable) must be reported by `detectorProblems()`, never silently treated as "not on a call".
- A skipped alert is not an error: the tool returns "Not played: <reason>" and Claude must not retry.
- Guardrail order in `blockedReason`: env kill switch → master switch → mute → per-alert switch → quiet hours → location lock → Focus → mic/camera → away (idle) → cooldown → hourly limit. `force` (tests) skips guardrails but never volume caps.
- Live speech, edited wording, library voices and project names all go through `prepare()` → `compose()`: guardrails and volume caps apply as for any alert, automatic recording respects `live.daily_chars`, and every failure falls back to a built-in clip with a `note` (never an error).
- Spending: generating audio costs the user's credits. Dry-run, state the character count, and get a go-ahead before any batch. Project names are capped at 20 new names per day.
- Keep the page's design language: liquid glass on an indigo/violet/cyan gradient, SF Pro (system font), one accent gradient for "on", amber only for "silent now", sentence case, no all-caps labels.

## Testing without noise

- `npm test` before every commit. It runs on Linux too (macOS detectors just report "unavailable").
- `HEADS_UP_DISABLED=1` makes every alert log "skipped" instead of playing.
- `HEADS_UP_FAKE_TTS=1` makes synthesis return a short tone instead of calling a provider (no credits); `HEADS_UP_NO_KEYCHAIN=1` ignores Keychain keys. The test helpers set both up so tests can never spend.
- MCP smoke test: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notify_user","arguments":{"status":"completed"}}}' | HEADS_UP_DISABLED=1 node server.mjs`
- Hooks: pipe event JSON into `node hook.mjs` (see `hook.log`). Headless sessions have `CLAUDE_CODE_SESSION_ATTENDED=0` and are ignored unless `HEADS_UP_ALLOW_HEADLESS=1`.
- Real end-to-end: `claude -p "... call notify_user ..." --model haiku` from a project folder, then read `DATA/state.json`.
- After changing `settings.mjs`, restart the page: `lsof -ti tcp:4777 | xargs kill; headsup`. Running Claude sessions keep the MCP code they started with until restarted.

## Gotchas

- zsh doesn't word-split `$VAR` commands; use functions in test scripts.
- `font-variant-numeric: tabular-nums` widens punctuation in some faces; keep it to number fields.
- macOS redacts the Wi-Fi name without Location permission; locations use the router MAC instead.
- Focus detection reads `~/Library/DoNotDisturb/DB/*.json`: manual Focus and enabled schedules only; Sleep and smart triggers aren't visible there.
