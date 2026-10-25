# Heads-up

Spoken alerts on your Mac when Claude Code finishes a task or needs you, so you can step away from the keyboard and still know when to come back.

> "Hello from Kosh. I need your review."

Heads-up is a small local MCP server plus Claude Code hooks. Claude calls one tool, `notify_user`, and your Mac plays a short pre-recorded line. It stays quiet when you're at the keyboard, on a call, in a Focus mode, or away from home.

## What it does

- **20 alerts** in **7 voices** (American, British, Australian and Indian; male and female), 140 built-in clips. No API key needed for these.
- **Project names**: "Hello from Brand Bakery Hub." Each project's name is recorded once with your own ElevenLabs or Sarvam key, then cached.
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
- `ffmpeg` (Homebrew) for project names and regenerating voices
- Optional: an ElevenLabs and/or Sarvam API key, only for recording new lines

## Install

```bash
git clone https://github.com/abhishek207/headsup-mcp.git ~/Dev/headsup-mcp
cd ~/Dev/headsup-mcp
npm run build
claude mcp add --scope user heads-up -- "$(command -v node)" "$PWD/server.mjs"
ln -s "$PWD/cli.mjs" ~/.local/bin/headsup
```

Then add to `~/.claude/settings.json` (use your absolute paths):

```json
{
  "permissions": { "allow": ["mcp__heads-up__notify_user"] },
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/path/to/node /path/to/headsup-mcp/hook.mjs", "async": true, "timeout": 15 }] }],
    "Notification": [{ "matcher": "permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input", "hooks": [{ "type": "command", "command": "/path/to/node /path/to/headsup-mcp/hook.mjs", "async": true, "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "/path/to/node /path/to/headsup-mcp/hook.mjs", "async": true, "timeout": 15 }] }]
  }
}
```

The allow rule matters: without it, the first alert in each session waits on a permission prompt, which defeats the point when you're away.

Finally, tell Claude when to use it, for example in `~/.claude/CLAUDE.md`:

> At the end of every turn where I need to act or the task is finished, call `notify_user` with the matching status. The server decides whether to actually play.

## Use

```bash
headsup              # open the settings page
headsup status       # what would happen right now
headsup test review  # play an alert now
headsup mute 30      # mute for 30 minutes; headsup unmute
headsup off          # master switch; headsup on
```

## API keys

Only needed to record new lines (project names today). Add them on the settings page; they go into your macOS Keychain and are never written to a file or shown again. Heads-up also reads `ELEVENLABS_API_KEY` / `SARVAM_API_KEY` from the environment.

## Where things live

- This folder: code and built-in voices.
- `~/Library/Application Support/heads-up` (or `$HEADS_UP_HOME`): your settings, alert log, hook state, and recorded project names.

## Troubleshooting

- `hook.log` in the data folder has one line per hook decision and why.
- The settings page's "Recent alerts" shows every alert, played or skipped, with the reason.
- `HEADS_UP_DISABLED=1` silences everything for one process (handy for tests).

## Voices

Built-in clips were generated with ElevenLabs (Brian, Sarah, George, Alice, Charlie) and Sarvam Bulbul v3 (Aditya, Priya). Check each provider's terms before redistributing generated audio.
