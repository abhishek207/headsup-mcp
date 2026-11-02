---
name: heads-up
description: When and how to call the heads-up notify_user tool, which speaks a short alert on the user's Mac so they come back to the computer. Use at the end of any turn where the user has to act (review, input, approval, an answer), when a long task finishes or fails, and when starting work they can walk away from.
---

# Heads-up voice alerts

The user may have walked away from the computer. `notify_user` plays a short spoken line on their Mac ("Hello. I need your review.") so they hear it from across the room. One well-timed alert brings them back; a stream of them gets the tool switched off.

## When to call it

Call `notify_user` **once**, as the last thing in a turn, when the user has to come back:

- you finished a task that took more than a minute or two
- you need a review, feedback, an approval, a decision or an answer
- you're blocked, something failed, or tests or a deploy finished
- you're starting something long they can step away from (`long_task`)

Don't call it:

- for quick back-and-forth replies while the user is clearly at the keyboard
- more than once per turn, or again for the same thing
- in the middle of work you're about to continue yourself
- for a permission prompt: a hook already announces those

## Picking the status

Pick the one that says why you stopped. The tool's description lists all twenty with their spoken lines. The common ones:

| Status | Use when |
|---|---|
| `completed` | the task is done |
| `review` | work is ready to look at: a diff, design or document |
| `input` / `question` | you need information, a decision or a quick answer |
| `approval` | you're waiting on a go-ahead |
| `blocked` / `error` | you can't continue without them, or something broke |
| `tests_passed` / `tests_failed` | a test run finished |
| `deployed` / `deploy_failed` | a release finished |
| `long_task` | you're starting something long |

Use `repeat: 2` only when it's urgent. Leave `volume` out; it's handled within the user's safety caps.

## Saying what you need with `message`

The user may have several sessions running at once, and "I need your review" alone doesn't tell them which one to open. Pass `message` on every call: your own line, spoken instead of the status's line, that names the thread or task and exactly what you need (which review and of what, which decision and its options, which input).

- Plain sentences, first person: "The pricing page task is done. I need you to pick hero image A or B." or "In the webhooks thread, I need to know whether refunds can wait a day. If they can, I'll batch them overnight."
- Say enough that the user knows what to do before they reach the screen. The tool's description gives the longest line the user allows. With the free local voice that limit is high: write the full script you want them to hear (what happened, what you need, the options and your recommendation). With a paid voice, every character costs the user credits, so stay brief.
- Name where you are so the user can find you among their open chats. In the Claude app (and in Claude Code after `/rename`), Heads-up reads this chat's title itself and opens the line with "Thread: <title>." When that title is generic or missing (a Remote Control session, a background run, a worker started for a project thread), open the line with the exact name the user knows the work by: the project thread's title if your instructions give it, word for word, otherwise the task in a few words. Don't invent a title.
- Don't repeat the project name: with spoken project names on, the greeting already says it ("Hello from <project>."), taken from the folder you worked in.
- If you worked in a different folder from the one the session started in (you changed into another repo, or the session runs in a parent folder like ~/Dev), pass that folder's absolute path as `folder` so the greeting names the right project. Never reuse a project name from an earlier alert or another session.
- Lines over the user's limit are cut at a word, so put the ask first.
- No names, code, file paths, ids, links, numbers that need reading, or anything secret. The text may go to the user's text-to-speech provider.
- Still set the closest `status`. Spoken lines are an opt-in feature that needs the free local voice or the user's own ElevenLabs or Sarvam key; when they're off, or the day's budget is used up, the status's built-in line plays instead.

## Reading the answer

- `Playing "..."`: done. Carry on or end the turn.
- `Not played: <reason>`: the user's settings held it back (muted, quiet hours, on a call, away, cooldown). This is not an error. **Don't retry** and don't mention it unless asked.
- `(your message wasn't spoken: ...)`: the built-in line played instead. Don't retry.

## Settings

The user controls everything on a local page: run `headsup` in a terminal (or open http://127.0.0.1:4777). Point them there if they ask how to change the voice, mute alerts, add a key, or turn on spoken project names.
