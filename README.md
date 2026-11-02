# Heads-up

Spoken alerts on your Mac, Linux or Windows PC when Claude Code finishes a task or needs you, so you can step away from the keyboard and still know when to come back.

> "Hello from Kosh. I need your review."

Heads-up is a plugin for Claude Code (and Codex): a small local MCP server, a skill that teaches the agent when to speak up, and hooks. The agent calls one tool, `notify_user`, and your computer plays a short line: one of 20 built-in clips, or, with your own ElevenLabs or Sarvam key, Claude's own words in the voice you picked. It stays quiet when you're on a call, in Focus or Do Not Disturb, or away from home, and it can also wait until you've left the keyboard.

## What it does

- **20 alerts** in **7 voices** (American, British, Australian and Indian; male and female), 140 built-in clips. No API key needed for these.
- **Works without a key**: out of the box it plays the built-in clips ("Hello. I need your review."). Project names and Claude's own words are opt-in features that switch on once you add your own ElevenLabs or Sarvam key.
- **Project names** (your key): "Hello from Brand Bakery Hub." Each project's name is recorded once, then cached.
- **Claude's own words** (your key): when a fixed line doesn't say enough, Claude adds a short `message` ("The migration ran, but two tables need your review.") and it's spoken live. Lines are cleaned (no code or links), capped in length, cached, and counted against a daily character budget. If it can't be recorded, the regular alert plays.
- **Any voice from your provider** (your key): add voices from your ElevenLabs account or any of Sarvam's 37 speakers on the settings page. Alerts in that voice are recorded the first time each plays, or all at once.
- **Your own wording** (your key): change what any alert says on the settings page; only that line is recorded.
- **Cost you can see**: characters used today and this month per provider, plus your ElevenLabs plan's credit counter.
- **Automatic alerts** via Claude Code hooks: permission prompts, and turns that run longer than 2 minutes, even if Claude forgets to call the tool. Background sessions (`claude -p`, SDK workers) never trigger them.
- **Polite by default**
  - Away detection (off by default): silent if you used the keyboard or mouse in the last 60 seconds. It's off because with several sessions open you're usually typing in another one when this one needs you; switch it on in settings.
  - Calls and Focus: silent while a microphone or camera is in use, or while a macOS Focus or your desktop's Do Not Disturb is on.
  - Locations: optionally only play on saved networks (Home, office), recognised by the router's hardware address. No GPS.
  - Quiet hours, a gap between alerts, and an hourly limit.
- **Ear-safe volume**: if your computer is muted or quiet, an alert briefly turns it up, then restores it. AirPods and headphones never go above 50%; speakers never above 90%. When Heads-up can't tell what's playing the sound, it uses the headphone limit.
- **Settings page** at `http://127.0.0.1:4777` (`headsup`), local only.

## Requirements

- Node.js 20+ and Claude Code (or Codex), on macOS, Linux or Windows 10/11
- `ffmpeg` for anything recorded with your key (`brew install ffmpeg`, `sudo apt install ffmpeg`, `winget install Gyan.FFmpeg`)
- Optional: an ElevenLabs and/or Sarvam API key, only for recording new lines

### Platforms

| | macOS | Linux | Windows |
|---|---|---|---|
| Sound | built in (`afplay`) | PipeWire or PulseAudio (`pw-play`, `paplay`), else `ffplay` | built in |
| Safe volume | built in | `pactl` or `wpctl` | Windows helper |
| Calls (mic, camera) | call detector, built with Xcode Command Line Tools (`swiftc`) | PipeWire (`pw-dump`) or `pactl`; camera from `/dev/video*` | Windows helper (reads Windows' own mic and camera privacy record) |
| Focus / Do Not Disturb | Focus modes, manual and scheduled | GNOME, KDE Plasma, Xfce, dunst, SwayNC, mako | Do not disturb (Focus assist on Windows 10) |
| Away (idle) | built in | GNOME, or `xprintidle` on X11 | Windows helper |
| Keys | Keychain | keyring via `secret-tool` (GNOME Keyring, KWallet) | Credential Manager, via the Windows helper |

`headsup install` checks all of this and says what's missing. On Linux it prints the install line for your distribution (apt, dnf, pacman, zypper); no helper needs building. On Windows it builds the small helper with the C# compiler that ships with Windows (.NET Framework 4), so nothing extra is downloaded. Anything Heads-up can't see is reported on the settings page and by `headsup status`, never treated as "not on a call".

Linux and Windows support is new in 1.6.0. Over SSH, in a container or on a machine with no sound server, alerts are skipped with a reason instead of playing into nothing.

## Install

In Claude Code, one step:

```
/plugin install heads-up --marketplace abhishek207/headsup-mcp
```

Or from a terminal, which also builds the helper your system needs and adds the `headsup` command:

```bash
npx headsup-mcp install      # add --dry-run to see the changes first
```

From a checkout, `npm run setup` does the same with the local copy. It's safe to run again after an update. It:

1. checks Node and ffmpeg, and on Linux the sound, call and keyring tools,
2. builds the helper into the data folder: the call detector on macOS (needs `swiftc`), the Windows helper on Windows; Linux needs none,
3. adds the heads-up marketplace and installs the plugin in Claude Code, and allows its `notify_user` tool in `~/.claude/settings.json` (backup in `settings.json.heads-up-backup`). Without the allow rule the first alert in each session waits on a permission prompt, which defeats the point when you're away,
4. removes the pre-plugin setup if it finds it (MCP entry, hooks, CLAUDE.md section), so alerts don't double,
5. installs the plugin in Codex too if Codex is installed; trust its hooks there with `/hooks` (Codex asks again after every Heads-up update: until you do, `codex exec` reports the hooks as Failed),
6. writes the `headsup` command to `~/.local/bin` (`%USERPROFILE%\.local\bin\headsup.cmd` on Windows, the same folder Claude Code's own installer uses).

`headsup uninstall` takes it all out again and keeps your settings.

### What the plugin contains

| Part | Claude Code | Codex |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` (MCP server inline) | `.codex-plugin/plugin.json` |
| MCP server `heads-up` | `server.mjs` | `server.mjs` via `.codex-plugin/mcp.json` |
| Skill | `skills/heads-up/SKILL.md` | same |
| Hooks | `hooks/hooks.json`: prompt, notification, stop | `hooks/codex.json`: prompt, permission request, stop |
| Marketplace | `.claude-plugin/marketplace.json` | same file (Codex reads it) |

Check the manifests with `npm run validate`.

### Other MCP clients

Any MCP client can run the server on its own over stdio:

```bash
npx -y headsup-mcp serve
```

That gives the client the `notify_user` tool. The skill and hooks only come with the Claude Code plugin, and `npx headsup-mcp install` builds the helper.

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

Only needed to record new lines: project names, your wording, added voices and Claude's own words. Add them on the settings page; they go into your system's key store (macOS Keychain, your Linux keyring, Windows Credential Manager) and are never written to a file or shown again. ElevenLabs keys are checked before they're saved (free), and the Test button speaks a few words with yours. Heads-up also reads `ELEVENLABS_API_KEY` / `SARVAM_API_KEY` from the environment, and key store items named `elevenlabs-api-key` / `sarvam-api-key`. On a Linux system without a keyring, set the environment variables instead.

Claude's lines are sent to your provider to be spoken, so Claude is told to keep code, paths and secrets out of them, and Heads-up replaces any links, file paths, email addresses and key-like strings that slip through with "a link", "a file" and so on before anything is sent. The daily budget (1,000 characters by default) caps everything recorded automatically; what you record from the settings page isn't capped.

## Where things live

- The plugin folder (Claude Code keeps it under `~/.claude/plugins/`): code and built-in voices.
- The data folder (or `$HEADS_UP_HOME`): `~/Library/Application Support/heads-up` on macOS, `~/.local/share/heads-up` on Linux (`$XDG_DATA_HOME/heads-up` if set), `%LOCALAPPDATA%\heads-up` on Windows. It holds your settings, alert log, hook state, recordings (`segments/`, `cache/clips/`) and the usage log (`usage.json`).

## Privacy and security

- **What leaves your computer:** nothing, until you add a key. With a key, only the text being recorded (a project's name, your wording, Claude's line) goes to ElevenLabs or Sarvam, plus free calls to list your ElevenLabs voices and plan usage. No analytics, no telemetry, no other servers.
- **What stays on your computer:** the call, Focus, away and location checks all run locally. The mic and camera check only asks the system whether a device is in use (macOS, PipeWire, or Windows' privacy record); it never opens one or records anything. Locations are your router's hardware address, kept in your settings file. The alert log (including Claude's lines) is in the data folder above, readable only by you.
- **Keys:** in your system's key store (or your environment), never in a file, a log or the settings page. `headsup uninstall` keeps them in case you reinstall and prints the command to remove them.
- **Settings page:** listens on 127.0.0.1 only, answers only to `127.0.0.1` and `localhost` (no DNS rebinding), refuses requests from other websites, can't be framed by another site, and stops after 30 idle minutes.
- **No dependencies:** plain Node and your system's own tools, nothing installed from npm at runtime.
- Found a security problem? See [SECURITY.md](SECURITY.md).

## Troubleshooting

- `hook.log` in the data folder has one line per hook decision and why.
- The settings page's "Recent alerts" shows every alert, played or skipped, with the reason.
- `HEADS_UP_DISABLED=1` silences everything for one process (handy for tests).
- "No sound output on this machine" means Heads-up found no sound server (an SSH session, a container, a Linux box without PipeWire or PulseAudio). If sound does reach you some other way, set `HEADS_UP_ASSUME_AUDIO=1`.
- Linux: `headsup status` says which detectors can't see anything on your desktop (Do Not Disturb on some desktops, idle time on KDE Wayland), and those checks are simply skipped there.
- Codex doesn't tell hooks whether a session is interactive, so a long `codex exec` run also announces when it finishes. Claude Code's background runs (`claude -p`, SDK) are ignored.
- Codex in full-auto ("YOLO") mode never asks for approval, so the approval alert never fires there.

## Voices and credits

Voices powered by [ElevenLabs](https://elevenlabs.io) (elevenlabs.io) and [Sarvam AI](https://www.sarvam.ai).

- English clips: ElevenLabs voices Brian, Sarah, George, Alice and Charlie, made on the ElevenLabs free plan. Credit: elevenlabs.io. Non-commercial use only.
- Indian English clips: Sarvam Bulbul v3 voices Aditya and Priya.

Lines you record with your own key are made under your own account and your provider's terms.

## Contributing

Use it, fork it, change it. Outside pull requests aren't accepted and are closed automatically; bug reports are welcome as issues. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright (C) 2026 [Brand Bakery](https://brandbakery.tech).

The code is licensed under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only): use, change and share it freely; if you distribute a modified version, it must stay under the GPL with its source available. The built-in clips in `voices/` aren't covered by it; see [voices/NOTICE.md](voices/NOTICE.md).

---

Built and maintained by **[Brand Bakery](https://brandbakery.tech)**.
