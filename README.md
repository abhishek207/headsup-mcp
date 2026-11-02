# Heads-up

Spoken alerts on your Mac, Linux or Windows PC when Claude Code finishes a task or needs you, so you can step away from the keyboard and still know when to come back.

> "Hello from Kosh. I need your review."

Heads-up is a plugin for Claude Code (and Codex): a small local MCP server, a skill that teaches the agent when to speak up, and hooks. The agent calls one tool, `notify_user`, and your computer plays a short line: one of 20 built-in clips, or Claude's own words in the voice you picked, spoken by a free voice that runs on your computer or by ElevenLabs or Sarvam with your own key. It stays quiet when you're on a call, in Focus or Do Not Disturb, or away from home, and it can also wait until you've left the keyboard.

## What it does

- **20 alerts** in **7 voices** (American, British, Australian and Indian; male and female), 140 built-in clips. No API key needed for these.
- **Works without a key**: out of the box it plays the built-in clips ("Hello. I need your review."). Project names and Claude's own words are opt-in features that switch on once you download the local voice or add your own ElevenLabs or Sarvam key.
- **Local voice** (free, optional): a voice model that speaks on your computer with no key and no account, in two sizes you can hear before downloading. 12 voices (American, British and Indian English), no daily limit. See [Local voice](#local-voice).
- **Project names** (local voice or your key): "Hello from Brand Bakery Hub." Each project's name is recorded once, then cached.
- **Which chat needs you**: with several sessions open, the line opens with the chat's title as the Claude app shows it (or your `/rename` title in Claude Code): "Hello from Kosh. Thread: Fix Safari export button. I need your review." Always with the local voice; with a paid voice only on lines Claude writes itself.
- **Claude's own words** (local voice or your key): when a fixed line doesn't say enough, Claude adds a short `message` ("The migration ran, but two tables need your review.") and it's spoken live. Lines are cleaned (no code or links), capped in length and cached. With a key they also count against a daily character budget. If it can't be recorded, the regular alert plays.
- **Any voice from your provider** (your key): add voices from your ElevenLabs account or any of Sarvam's 37 speakers on the settings page. Alerts in that voice are recorded the first time each plays, or all at once.
- **Your own wording** (local voice or your key): change what any alert says on the settings page; only that line is recorded.
- **Cost you can see**: characters used today and this month per provider, plus your ElevenLabs plan's credit counter.
- **Automatic alerts** via Claude Code hooks: permission prompts, and turns that run longer than 2 minutes, even if Claude forgets to call the tool. Background sessions (`claude -p`, SDK workers) never trigger them.
- **Polite by default**
  - Away detection (off by default): silent if you used the keyboard or mouse in the last 60 seconds. It's off because with several sessions open you're usually typing in another one when this one needs you; switch it on in settings.
  - Calls and Focus: silent while a microphone or camera is in use, or while a macOS Focus or your desktop's Do Not Disturb is on. If the mic or camera comes on while an alert is speaking (dictation, a call), it stops at once.
  - Stop: `headsup stop`, or the Stop button on the settings page, ends the alert mid-sentence (and drops any waiting behind it). Bind `headsup stop` to a key with a macOS Shortcut (or your desktop's keyboard shortcuts) if you want one keypress.
  - Locations: optionally only play on saved networks (Home, office), recognised by the router's hardware address. No GPS.
  - Quiet hours, a gap between alerts, and an hourly limit.
- **Ear-safe volume**: if your computer is muted or quiet, an alert briefly turns it up, then restores it. AirPods and headphones never go above 50%; speakers never above 90%. When Heads-up can't tell what's playing the sound, it uses the headphone limit.
- **Settings page** at `http://127.0.0.1:4777` (`headsup`), local only.

## Requirements

- Node.js 20+ and Claude Code (or Codex), on macOS, Linux or Windows 10/11
- `ffmpeg` for anything recorded, with the local voice or your key (`brew install ffmpeg`, `sudo apt install ffmpeg`, `winget install Gyan.FFmpeg`)
- Optional: the local voice (about 420 MB of disk, or 210 MB for the smaller model), or an ElevenLabs and/or Sarvam API key, only for recording new lines

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

Linux and Windows support is new in 1.7.0. Linux has been tested on PipeWire with GNOME's Do Not Disturb; other desktops are best effort. Windows is early: it hasn't run on a real PC yet, so if something doesn't work there, please open an issue. Over SSH, in a container or on a machine with no sound server, alerts are skipped with a reason instead of playing into nothing.

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
headsup stop         # stop the alert that's speaking
headsup mute 30      # mute for 30 minutes; headsup unmute
headsup off          # master switch; headsup on
headsup say "The build is green."   # hear a line of your own (local voice or your key)
headsup usage        # characters sent to your voice providers
headsup local install   # download the free local voice (full, or: headsup local install small); headsup local remove
```

## Local voice

A free voice that runs on your computer, for people who want project names and Claude's own words without paying for a key. It's off until you download it. On the settings page, under Local voice, play the sample of each model and of each of the 12 voices, download the one you like, then pick one of its 12 voices under Voice, "On this Mac" ("On this computer" on Linux, "On this PC" on Windows). It runs on macOS (Apple silicon and Intel), Linux (x64 and arm64) and Windows (x64; not yet tried on a real PC). From a terminal: `headsup local install` (full quality) or `headsup local install small`.

| Model | Sound | Download | On disk | Each new line (M4 MacBook Air) |
|---|---|---|---|---|
| Full quality (recommended) | clear and natural | about 360 MB | about 420 MB | about 4 s and 730 MB of memory |
| Smaller | a little rough and buzzy, about half as fast | about 140 MB | about 210 MB | about 7 s and 500 MB of memory |

- **What it is:** [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an 82-million-parameter text-to-speech model, run by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). The smaller model is the same one stored in 8-bit numbers, which is where its rougher sound comes from. Heads-up downloads them from their official releases, checks each file against a pinned checksum, and keeps them in the data folder. Nothing is installed anywhere else.
- **One at a time:** switching downloads the other model (the engine is kept) and replaces the current one, which keeps working until the new one is ready. Lines already recorded in a local voice are made again with the new model.
- **What it costs:** nothing per line. There's no daily budget and no limit on new project names. It uses your CPU and memory for a few seconds each time it records a new line, then frees them; after the download the settings page shows what that took on your computer. Nothing stays loaded between alerts, and lines already made are cached and play instantly.
- **Speed and length:** under Local voice, Speaking speed sets how fast it talks (0.7× to 1.5×), and Longest line sets how much Claude can say in one alert (1,000 characters by default, up to 2,000). It's free, so Claude is told to say everything it needs: what happened, which review, decision or input, and the options. A long line starts playing once its first sentence is ready, and the rest is made while it speaks. Paid voices keep their own, shorter limit under Claude's own words.
- **Voices:** 6 American, 4 British, 2 Indian (a Hindi voice reading English). For a native Indian English voice use Sarvam with your key.
- **Keys still work:** the local voice is one more choice next to ElevenLabs and Sarvam. If you'd rather not run a model on your computer, skip it and use a key.
- `headsup local remove` deletes it. If you have no key, project names and Claude's own words switch off again.

## API keys

Only needed to record new lines with ElevenLabs or Sarvam: project names, your wording, added voices and Claude's own words. The local voice needs no key. Add them on the settings page; they go into your system's key store (macOS Keychain, your Linux keyring, Windows Credential Manager) and are never written to a file or shown again. ElevenLabs keys are checked before they're saved (free), and the Test button speaks a few words with yours. Heads-up also reads `ELEVENLABS_API_KEY` / `SARVAM_API_KEY` from the environment, and Keychain items named `elevenlabs-api-key` / `sarvam-api-key`.

With a key, Claude's lines are sent to your provider to be spoken, so Claude is told to keep code, paths and secrets out of them, and Heads-up replaces any links, file paths, email addresses and key-like strings that slip through with "a link", "a file" and so on before anything is sent. The daily budget (1,000 characters by default) caps everything recorded automatically; what you record from the settings page isn't capped.

## Where things live

- The plugin folder (Claude Code keeps it under `~/.claude/plugins/`): code and built-in voices.
- The data folder (or `$HEADS_UP_HOME`): `~/Library/Application Support/heads-up` on macOS, `~/.local/share/heads-up` on Linux (`$XDG_DATA_HOME/heads-up` if set), `%LOCALAPPDATA%\heads-up` on Windows. It holds your settings, alert log, hook state, recordings (`segments/`, `cache/clips/`) the usage log (`usage.json`) and the local voice if you downloaded it (`local/`).

## Privacy and security

- **What leaves your computer:** nothing, until you add a key. The local voice speaks on your computer; downloading it fetches two files from npm and GitHub and sends nothing about you. With a key, only the text being recorded (a project's name, your wording, Claude's line) goes to ElevenLabs or Sarvam, plus free calls to list your ElevenLabs voices and plan usage. No analytics, no telemetry, no other servers.
- **What stays on your computer:** the call, Focus, away and location checks all run locally. The mic and camera check only asks the system whether a device is in use (macOS, PipeWire, or Windows' privacy record); it never opens one or records anything. Locations are your router's hardware address, kept in your settings file. The alert log (including Claude's lines) is in the data folder above, readable only by you.
- **Keys:** in your system's key store (or your environment), never in a file, a log or the settings page. `headsup uninstall` keeps them in case you reinstall and prints the command to remove them.
- **Settings page:** listens on 127.0.0.1 only, answers only to `127.0.0.1` and `localhost` (no DNS rebinding), refuses requests from other websites, can't be framed by another site, and stops after 30 idle minutes.
- **No dependencies:** plain Node and your system's own tools. The only thing fetched at runtime is the local voice, and only when you ask for it: a pinned sherpa-onnx build and Kokoro model, each checked against a SHA checksum before use.
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
- Local voice: [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0), run with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0), which uses [espeak-ng](https://github.com/espeak-ng/espeak-ng) (GPL-3.0) for pronunciation. Downloaded on demand, not shipped in this package.

Lines you record with your own key are made under your own account and your provider's terms.

## Contributing

Use it, fork it, change it. Outside pull requests aren't accepted and are closed automatically; bug reports are welcome as issues. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright (C) 2026 [Brand Bakery](https://brandbakery.tech).

The code is licensed under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only): use, change and share it freely; if you distribute a modified version, it must stay under the GPL with its source available. The built-in clips in `voices/` aren't covered by it; see [voices/NOTICE.md](voices/NOTICE.md).

---

Built and maintained by **[Brand Bakery](https://brandbakery.tech)**.
