#!/bin/bash
# Daily check: find tomorrow's events with 07:59 sentinel time and remind to set a real time.
set -euo pipefail

cd /home/claudebot/claude-bot
source /home/claudebot/claude-bot/.env 2>/dev/null || true

# cron runs this with PATH=/usr/bin:/bin, where `bun` is NOT resolvable, so it
# has to be located explicitly. This is not a detail: from 2026-06-08 until this
# was fixed the script was a silent no-op, because the calendar read below failed
# into an empty string and an empty string matches no events. Nothing errored,
# the log stayed empty, and no reminder was ever sent.
BUN=$(command -v bun || true)
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
if [ ! -x "$BUN" ]; then
  echo "cal_check: bun not found on PATH or at $BUN — check did NOT run" >&2
  exit 1
fi

TOMORROW_START=$(date -d 'tomorrow 00:00' +%Y-%m-%dT%H:%M:%S%:z)
TOMORROW_END=$(date -d 'tomorrow 23:59:59' +%Y-%m-%dT%H:%M:%S%:z)
TOMORROW_DATE=$(date -d 'tomorrow' '+%d/%m')

# Failures are reported, not swallowed. Losing the calendar read is why this
# check went unnoticed for three months.
if ! EVENTS=$("$BUN" run cal.ts list "$TOMORROW_START" "$TOMORROW_END" 2>&1); then
  echo "cal_check: reading the calendar failed — $EVENTS" >&2
  exit 1
fi

UNSCHEDULED=$(echo "$EVENTS" | grep "07:59" | sed 's/^[[:space:]]*//' || true)

if [ -n "$UNSCHEDULED" ]; then
  TITLES=$(echo "$UNSCHEDULED" | sed 's/07:59 — //' | sed 's/^/  • /')
  MSG="תזכורת: יש מחר ($TOMORROW_DATE) אירועים ללא שעה מסודרת — כדאי לעדכן שעה:
$TITLES"

  # Same bidi treatment the poller gives every outgoing message, so an English
  # event title inside this Hebrew line cannot flip the line's direction.
  # Falls back to the raw text if the filter fails — a cosmetic fix must never
  # be the reason the reminder does not go out.
  ISOLATED=$(printf '%s' "$MSG" | "$BUN" run bidi.ts 2>/dev/null || true)
  [ -n "$ISOLATED" ] && MSG="$ISOLATED" || true

  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${MSG}" > /dev/null
fi
