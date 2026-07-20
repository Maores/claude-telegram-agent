#!/bin/bash
# Daily check: find tomorrow's events with 07:59 sentinel time and remind to set a real time.
set -euo pipefail

cd /home/claudebot/claude-bot
source /home/claudebot/claude-bot/.env 2>/dev/null || true

TOMORROW_START=$(date -d 'tomorrow 00:00' +%Y-%m-%dT%H:%M:%S%:z)
TOMORROW_END=$(date -d 'tomorrow 23:59:59' +%Y-%m-%dT%H:%M:%S%:z)
TOMORROW_DATE=$(date -d 'tomorrow' '+%d/%m')

EVENTS=$(bun run cal.ts list "$TOMORROW_START" "$TOMORROW_END" 2>/dev/null || true)

UNSCHEDULED=$(echo "$EVENTS" | grep "07:59" | sed 's/^[[:space:]]*//' || true)

if [ -n "$UNSCHEDULED" ]; then
  TITLES=$(echo "$UNSCHEDULED" | sed 's/07:59 — //' | sed 's/^/  • /')
  MSG="תזכורת: יש מחר ($TOMORROW_DATE) אירועים ללא שעה מסודרת — כדאי לעדכן שעה:
$TITLES"

  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${MSG}" > /dev/null
fi
