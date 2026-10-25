# Heads-up

Spoken alerts on your Mac when Claude Code finishes a task or needs you, so you can step away from the keyboard and still know when to come back.

> "Hello from Kosh. I need your review."

Heads-up is a small local MCP server plus Claude Code hooks. Claude calls one tool, `notify_user`, and your Mac plays a short line: one of 20 built-in clips, or, with your own ElevenLabs or Sarvam key, Claude's own words in the voice you picked. It stays quiet when you're at the keyboard, on a call, in a Focus mode, or away from home.

## What it does

- **20 alerts** in **7 voices** (American, British, Australian and Indian; male and female), 140 built-in clips. No API key needed for these.
- **Project names**: "Hello from Brand Bakery Hub." Each project's name is recorded once with your own ElevenLabs or Sarvam key, then cached.
- **Claude's own words** (your key): when a fixed line doesn't say enough, Claude adds a short `message` ("The migration ran, but two tables need your review.") and it's spoken live. Lines are cleaned (no code or links), capped in length, cached, and counted against a daily character budget. If it can't be recorded, the regular alert plays.
- **Any voice from your provider** (your key): add voices from your ElevenLabs account or any of Sarvam's 37 speakers on the settings page. Alerts in that voice are recorded the first time each plays, or all at once.
- **Your own wording** (your key): change what any alert says on the settings page; only that line is recorded.
- **Cost you can see**: characters used today and this month per provider, plus your ElevenLabs plan's credit counter.
- **Automatic alerts** via Claude Code hooks: permission prompts, and turns that run longer than 2 minutes, even if Claude forgets to call the tool. Background sessions (`claude -p`, SDK workers) never trigger them.
- **Polite by default**
  - Away detection: silent if you used the keyboard or mouse in the last 60 seconds.
  - Calls and Focus: silent while a mic or camera is in use, or a macOS Focus is on.
  - Locations: optionally only play on saved networks (Home, office), recognised by the router's hardware address. No GPS.
  - Quiet hours, a gap between alerts, and an hourly limit.
- **Ear-safe volume**: if your Mac is muted or quiet, an alert briefly turns it up, then restores it. AirPods and headphones never go above 50%; speakers never above 90%.
- **Settings page** at `http://127.0.0.1:4777` (`headsup`), local only.

## Requirements

- macOS, Node.js 20+, Claude Code
- Xcode Command Line Tools (`swiftc`) to build the mic/camera checker
- `ffmpeg` (Homebrew) for anything recorded with your key
- Optional: an ElevenLabs and/or Sarvam API key, only for recording new lines

## Install

```bash
git clone https://github.com/abhishek207/headsup-mcp.git ~/Dev/headsup-mcp
cd ~/Dev/headsup-mcp
npm run setup            # add -- --dry-run to see the changes first
```

`npm run setup` (or `node tools/install.mjs`) is safe to run again after an update. It:

1. checks Node and ffmpeg,
2. builds the call detector (`bin/media-in-use`),
3. registers the MCP server with Claude Code (user scope, full Node path),
4. adds the `mcp__heads-up__notify_user` allow rule and the three hooks to `~/.claude/settings.json` (backup in `settings.json.heads-up-backup`), replacing older heads-up hooks instead of doubling them,
5. links `headsup` into `~/.local/bin`,
6. adds a short "when to call notify_user" section to `~/.claude/CLAUDE.md`, unless you already wrote your own.

The allow rule matters: without it, the first alert in each session waits on a permission prompt, which defeats the point when you're away. `headsup uninstall` takes it all out again and keeps your settings.

## Use

```bash
headsup              # open the settings page
headsup status       # what would happen right now
headsup test review  # play an alert now
headsup mute 30      # mute for 30 minutes; headsup unmute
headsup off          # master switch; headsup on
headsup say "The build is green."   # hear a line of your own (uses your key)
headsup usage        # characters sent to your voice providers
```

## API keys

Only needed to record new lines: project names, your wording, added voices and Claude's own words. Add them on the settings page; they go into your macOS Keychain and are never written to a file or shown again. ElevenLabs keys are checked before they're saved (free), and the Test button speaks a few words with yours. Heads-up also reads `ELEVENLABS_API_KEY` / `SARVAM_API_KEY` from the environment, and Keychain items named `elevenlabs-api-key` / `sarvam-api-key`.

Claude's lines are sent to your provider to be spoken, so Claude is told to keep code, paths and secrets out of them. The daily budget (1,000 characters by default) caps everything recorded automatically; what you record from the settings page isn't capped.

## Where things live

- This folder: code and built-in voices.
- `~/Library/Application Support/heads-up` (or `$HEADS_UP_HOME`): your settings, alert log, hook state, recordings (`segments/`, `cache/clips/`) and the usage log (`usage.json`).

## Troubleshooting

- `hook.log` in the data folder has one line per hook decision and why.
- The settings page's "Recent alerts" shows every alert, played or skipped, with the reason.
- `HEADS_UP_DISABLED=1` silences everything for one process (handy for tests).

## Voices

Built-in clips were generated with ElevenLabs (Brian, Sarah, George, Alice, Charlie) and Sarvam Bulbul v3 (Aditya, Priya). Check each provider's terms before redistributing generated audio.
