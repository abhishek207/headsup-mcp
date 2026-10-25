# Heads-up: working notes for Claude

Claude Code / Codex plugin (local macOS MCP server + skill + hooks) that speak short alerts ("Hello from Kosh. I need your review."). Zero npm dependencies, plain Node ESM, one small Swift helper. User-facing docs: `README.md`.

## Map

| File | Role |
|---|---|
| `.claude-plugin/` | `plugin.json` (Claude Code manifest, MCP server inline) and `marketplace.json` (this repo is its own marketplace, plugin source `./`). |
| `.codex-plugin/` | Codex manifest + `mcp.json`. Kept out of the repo root so Claude Code doesn't load it as a project `.mcp.json`. |
| `skills/heads-up/SKILL.md` | Teaches the agent when/how to call `notify_user`. Replaces the old CLAUDE.md section. Provider-neutral wording. |
| `hooks/hooks.json`, `hooks/codex.json` | Plugin hooks → `hook.mjs`. Codex has `PermissionRequest` instead of `Notification`. |
| `paths.mjs` | `ROOT` (code + built-in voices; the plugin cache copy when installed), `DATA` (`~/Library/Application Support/heads-up` or `$HEADS_UP_HOME`), `HELPER` (call detector, `DATA/bin` first). Writes `DATA/root` so the `headsup` shim finds the current copy. |
| `core.mjs` | Config defaults + `normalize()` (all clamping/validation), guardrails (`blockedReason`), detectors (location, idle, mic/camera, Focus), project names, volume safety, playback queue, `prepare()` (which clip and words, with fallbacks), `alert()`. |
| `speech.mjs` | Recording beyond the built-in clips: `compose()` (greeting + 0.6 s + message, cached), `cleanMessage()`, daily budget, usage log (`DATA/usage.json`), library-voice lookup. |
| `tts.mjs` | ElevenLabs/Sarvam synthesis with the user's own key (env → Keychain), voice lists (ElevenLabs account, Sarvam speakers), key check, plan usage, Keychain save/delete via `security -i`, ffmpeg join/extract. Also widens `PATH` for MCP/hook processes. |
| `server.mjs` | MCP stdio server (hand-rolled JSON-RPC, async replies). One tool: `notify_user { status, message?, repeat?, volume? }`. Project = `projectFor(process.cwd())`. Waits up to 15 s for a live line so the answer says what was spoken. |
| `hook.mjs` | Hook entry (Claude Code + Codex): UserPromptSubmit (turn start), Notification / PermissionRequest (→ `approval`), Stop (long turn → `completed`/`input`). Ignores background sessions. Plays in a detached child. Logs to `DATA/hook.log`. |
| `settings.mjs` + `settings.html` | Local settings page on 127.0.0.1:4777 (host/origin/Sec-Fetch-Site checks, JSON-only POSTs, CSP with per-request script hashes, no framing). HTML is re-read per request. |
| `cli.mjs` | `headsup` command: settings, on/off, mute/unmute, status, test, say, usage, install/uninstall. |
| `tools/install.mjs` | `headsup install` / `npm run setup` / `npx github:abhishek207/headsup-mcp install`: call detector into `DATA/bin`, marketplace add + plugin install (Claude Code, Codex), allow rule, removes pre-plugin setup, `headsup` shim. Idempotent; `--dry-run`, `--uninstall`, `--source`. |
| `assets/logo.svg` | Logo ("ping"), served as the page's favicon and header mark. |
| `templates.json` | Greeting + the 20 alerts (`id`, `text`, `when`). `when` feeds the MCP tool description. |
| `voices.json` | The 7 voices: accent, gender, speaker, provider, provider voice id. |
| `voices/<voice>/<id>.mp3` | 140 built-in clips ("Hello." + 0.6 s + message, −16 LUFS mono). |
| `tools/generate.mjs` | Rebuilds clips; caches raw segments in `DATA/segments` keyed by text hash so only changed text costs credits. `--dry-run` first, always. |
| `test/*.test.mjs` | `npm test` (node:test, no deps): config clamps, guardrail order, Focus parsing, detector warnings, play lock, MCP server, hooks, live lines/wording/library voices/budget (fake TTS), message scrubbing, installer edits and quoting, settings server security (own port via `HEADS_UP_PORT`). Runs in a temp `HEADS_UP_HOME`, never plays audio, never reads or writes real keys. |
| `tools/media-in-use.swift` | Builds `bin/media-in-use` (`npm run build`): prints `{"mic":bool,"camera":bool}` without opening devices. |

## Rules

- Never write API keys to config, logs or the page. Keys come from env or Keychain only (`tts.mjs`).
- User data goes in `DATA`, never in the repo. `.gitignore` backs this up.
- Project names and live lines are off by default and stay off without a provider key (`settings.mjs` enforces it).
- Config is re-read on every call; every new field needs a default in `DEFAULTS` and a clamp/validation in `normalize()`.
- Volume must stay under `HARD_CAP` (speakers 90, headphones 50). Unknown output device = headphone limits.
- Playback goes through `withPlayLock` (`DATA/playing.lock`): one alert at a time across all sessions, and the volume to restore is saved in the lock so a crash can't leave the Mac loud.
- A detector that can't see (helper not built, Focus file unreadable) must be reported by `detectorProblems()`, never silently treated as "not on a call".
- A skipped alert is not an error: the tool returns "Not played: <reason>" and Claude must not retry.
- Guardrail order in `blockedReason`: env kill switch → master switch → mute → per-alert switch → quiet hours → location lock → Focus → mic/camera → away (idle) → cooldown → hourly limit. `force` (tests) skips guardrails but never volume caps.
- Live speech, edited wording, library voices and project names all go through `prepare()` → `compose()`: guardrails and volume caps apply as for any alert, automatic recording respects `live.daily_chars`, and every failure falls back to a built-in clip with a `note` (never an error).
- Spending: generating audio costs the user's credits. Dry-run, state the character count, and get a go-ahead before any batch. Project names are capped at 20 new names per day.
- The settings page runs under a strict CSP: only its inline `<script>` blocks (allowed by hash, computed when served), no inline event handlers (`onclick=`), no external scripts or fonts, `fetch` to itself only. Keep it that way; build UI with `addEventListener`.
- Anything sent to a TTS provider goes through `cleanMessage()`, which also swaps links, file paths, email addresses and key-like strings for plain words. Don't bypass it.
- Keep the page's design language: liquid glass on an indigo/violet/cyan gradient, SF Pro (system font), one accent gradient for "on", amber only for "silent now", sentence case, no all-caps labels.
- Dark mode is warm charcoal with a violet-to-rose accent: no blue or navy, no glows, no edge lines. Depth comes from shadow and fill only (the owner's call). Colours and depth are CSS variables on `:root` and both dark blocks; change them there, not in component rules.

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
