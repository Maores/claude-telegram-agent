# Undo a reminder snooze — design

Date: 2026-06-17
Status: approved (Maor, 2026-06-17)
Origin: Maor's request in chat #308 (2026-06-17) — "allow cancelling after pressing
a reminder button; after I snooze and then change my mind, let me go back."

## Problem

When a one-time task reminder fires, the bot shows two buttons: **בוצע ✓** (done)
and **תזכיר לי שוב** (remind me again). Tapping "remind me again" opens snooze
options (+1 שעה / הערב 20:00 / מחר 09:00). Tapping a snooze option does three
things and then leaves no buttons:

1. `resolveFollowup(id, "snoozed")` — marks the follow-up resolved.
2. `addOnce(chatId, snoozeTarget, text)` — creates a **new** one-time reminder.
3. Edits the message to `… — נדחה ל־<time>`.

If Maor snoozed by mistake (or changes his mind), there is currently no way back:
the new reminder is already scheduled and the buttons are gone.

## Goal

A one-tap **undo** for a snooze: cancel the reminder the snooze created and restore
the original message + done/snooze buttons so Maor can re-decide.

Decided during brainstorming:
- **Trigger = button** (not natural language). Deterministic, instant, fits the
  inline-button model already in use.
- **Scope = snooze only.** Undoing "done" is out of scope (not requested).
- **No fixed time window.** Undo is valid only while the snoozed reminder still
  exists; once it fires there is nothing left to undo.

## Design

### Flow change (poller.ts `handleCallback`, the snooze branch)

Today the snooze branch discards `addOnce`'s return. Change it to:

- `const nr = addOnce(f.chatId, t, f.text);` — keep the new reminder.
- Edit the confirmation message to `… — נדחה ל־<time>` **with** a one-button
  keyboard `undoKeyboard(f.id, nr.id)` instead of clearing the buttons.

### New callback namespace `fuu:` (follow-up undo)

`callback_data` (≤64 bytes): `fuu:<followupId>:<reminderId>`.

- `parseFuuCallback(data): { fuId, reminderId } | null` via
  `/^fuu:([\w-]+):([\w-]+)$/`. Parsed **before** `parseFuCallback` so the existing
  `fu:` parser (anchored `^fu:(done|later|s1h|seve|stom):`) never sees it; the two
  are disjoint anyway.
- `undoKeyboard(fuId, reminderId)` → `{ inline_keyboard: [[ { text: "↩️ בטל דחייה",
  callback_data: \`fuu:${fuId}:${reminderId}\` } ]] }`.

### `handleFuuCallback`

1. `cancel(chatId, reminderId)` — if it returns **false**, the snoozed reminder
   already fired or was removed → `ack("כבר טופל")`, leave the message as-is. This
   is the natural expiry: no timer needed.
2. `revertFollowup(fuId)` — snoozed → pending (see new unit). If null (already
   reverted / missing), still fine — proceed to restore the message.
3. Edit the message back to `⏰ Reminder: <text>` + `fuKeyboard(fuId)` (the exact
   format the reminder fires with), so the original state is restored.
4. `ack("בוטל ✓")`; `console.log("[REMIND] undo <fuId>")`.

### New unit — reminders.ts `revertFollowup(id): Followup | null`

Mirrors the other follow-up mutators (wrapped in `withFileLock`):

- Load follow-ups, find by id.
- If status !== "snoozed" → return null (nothing to revert).
- Set `status = "pending"`, `firedAt = now`, `nudged = false`, save, return it.

Resetting `firedAt` to now is deliberate: the nudge loop sends "עדיין רלוונטי?"
1h after `firedAt`. Without the reset, undoing a snooze made hours after the
original fire would trigger an immediate spurious nudge.

## Edge cases

- **Snoozed reminder already fired before undo** → `cancel` returns false →
  "כבר טופל", no revert. We never revive a reminder that already pinged.
- **Double-tap undo** → second tap: the reminder is already cancelled (`cancel`
  false) → stale. Safe and idempotent.
- **Forged / cross-chat `fuu:` data** → the existing allow-list check and
  `chatId/messageId` null-guards in `handleCallback` reject it (fail-safe), same as
  the other namespaces.
- **`revertFollowup` on a non-snoozed / missing follow-up** → returns null; the
  handler still restores the message harmlessly.

## Testing (TDD)

- `parseFuuCallback`: valid `fuu:f123:r4`; rejects `fu:done:x`, `fuu:`, `fuu:a`,
  garbage.
- `revertFollowup`: snoozed → pending with `firedAt` reset and `nudged=false`;
  returns null for missing id; returns null (no change) when status is "done" or
  "pending".
- `undoKeyboard`: shape + encoded `callback_data`.

## Out of scope (YAGNI)

- Undoing "בוצע ✓" (done).
- Natural-language "undo" detection.
- A fixed undo time-window / countdown.
