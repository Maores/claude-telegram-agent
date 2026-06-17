# Telegram reply-context awareness — design

Date: 2026-06-17
Status: approved (Maor, 2026-06-17)
Origin: Maor's request in chat #308–#309 (2026-06-17) — "understand reply context
when I reply to a message in Telegram."

## Problem

When Maor uses Telegram's native reply (swipe-to-reply / "Reply") to quote a
specific earlier message and then types, the update carries that quoted message in
`message.reply_to_message`. The bot currently ignores it — `TgMessage` doesn't even
declare the field — so "expand on this" or "do that one" loses the pointer to which
message Maor meant. The recent-conversation history is in the prompt, but nothing
says *which* message the new one is a reply to.

## Goal

When a message is a native reply, feed the quoted message into the prompt as a
short, clearly-labeled context line, so Claude knows exactly what Maor is pointing
at — whether he replied to one of the bot's answers or to his own earlier message.

Decided during brainstorming:
- **Content = text/caption + media marker.** Quote the text/caption; if the quoted
  message was media with no caption, add an honest marker (`[תמונה]`, `[קובץ]`, …).
  The media is **not** re-read (it's deleted after the original reply) — out of scope.
- Label **who** sent the quoted message (the assistant vs Maor).

## Design

### Type change (poller.ts)

`TgMessage` gains `reply_to_message?: TgMessage`. Telegram nests the replied-to
message and it reuses the same shape (text/caption/from/media fields already exist).

### Capture the bot's own id at startup

Where `botUsername = me.username` is set after `getMe` (poller.ts ~1761), also set
`botUserId = me.id` (a module-level `let botUserId = 0`). Needed to decide whether a
quoted message was authored by the bot.

### New pure unit — `replyContextLine(replyTo, botUserId, name): string | null`

- `null` if `replyTo` is missing.
- **Author label:** `replyTo.from?.id === botUserId && botUserId !== 0` →
  "the assistant"; otherwise `name` (Maor).
- **Content:** `replyTo.text ?? replyTo.caption`, trimmed and truncated to 500 chars
  (append `…` when truncated). If neither is present, derive a media marker from the
  first set field, in this order: photo → `[תמונה]`, document → `[קובץ]`, voice →
  `[הודעה קולית]`, video/video_note → `[וידאו]`, audio → `[אודיו]`,
  animation/sticker → `[GIF/מדבקה]`, else `[הודעה]`.
- **Returns** one prompt line, addressed to Claude:
  `<name> is replying to an earlier message (sent by <author>): «<content>»`.

Pure, no IO — unit-tested in isolation.

### Prompt wiring — `buildPrompt`

Add a `replyContext = ""` parameter (last, mirroring `devDirective`). Inject it
immediately before the final lines:

```
if (replyContext) lines.push(replyContext, "");
lines.push(`New message from ${name}:`, text);
```

### handleMessage wiring

In the typed-message path, compute
`const replyContext = replyContextLine(msg.reply_to_message, botUserId, name) ?? ""`
and pass it as the new `buildPrompt` argument. The choice-tap path
(`buildPrompt(..., option, ...)`) carries no reply and is left unchanged.

History storage is unchanged — the reply linkage is transient prompt context, not
something we persist into recall/history.

## Edge cases

- **No reply** → `replyContextLine` returns null → `""` → prompt unchanged (exact
  current behavior; zero risk to normal messages).
- **Quoted message has neither text/caption nor a known media field** → `[הודעה]`.
- **Very long quote** → truncated to 500 chars + `…`.
- **Reply to a voice note** → `[הודעה קולית]` (the old transcript isn't on the
  message object; we don't reconstruct it).
- **`botUserId` not yet set (0)** → never mislabels a message as the assistant's;
  falls back to Maor's name.

## Testing (TDD)

`replyContextLine`:
- user text → "(sent by Maor): «…»".
- caption when no text.
- bot-authored (`from.id === botUserId`) → "(sent by the assistant)".
- each media marker (photo/document/voice/video/audio/sticker) when no text/caption.
- generic `[הודעה]` when nothing recognized.
- truncation past 500 chars.
- null when `replyTo` is undefined.

`buildPrompt`: includes the reply line before "New message from …" when provided;
unchanged when empty.

## Out of scope (YAGNI)

- Re-downloading / re-reading quoted media.
- Persisting reply links into history/recall.
- Threading multiple levels of replies (only the directly-quoted message is used).
