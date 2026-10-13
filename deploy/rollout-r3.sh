#!/bin/bash
# R3 of the hardening rollout: move runtime state into /var/lib/telegram-agent with exact modes.
# Refuses unless the service is stopped and the target is empty; compares counts and the database
# before it writes the marker and the environment line.
set -euo pipefail
REPO=/home/claudebot/claude-bot
S=/var/lib/telegram-agent
ENVF=/home/claudebot/.claude/channels/telegram/.env
BUN=/home/claudebot/.bun/bin/bun
state=$(systemctl is-active telegram-agent || true)
[ "$state" = inactive ] || { echo "REFUSED: stop telegram-agent first ($state)"; exit 1; }
if [ -e "$S" ]; then [ -z "$(ls -A "$S")" ] || { echo "REFUSED: $S is not empty"; exit 1; }; fi
[ -f "$REPO/memory/bot.db" ] || { echo "REFUSED: $REPO/memory/bot.db missing"; exit 1; }
count() { if [ -d "$1" ]; then find "$1" -type f | wc -l; else echo 0; fi; }
before_mem=$(count "$REPO/memory")
before_skills=$(count "$REPO/skills")
before_hist=$(count "$REPO/history")
before_upl=$(count "$REPO/uploads")
echo "before: memory $before_mem files, skills $before_skills files, history $before_hist files, uploads $before_upl files"
getent group agentdata >/dev/null || sudo groupadd --system agentdata
id -nG claudebot | tr ' ' '\n' | grep -qx agentdata || sudo usermod -aG agentdata claudebot
for d in "$S" "$S/data" "$S/history" "$S/uploads" "$S/cc-digest" "$S/shared"; do sudo install -d -o claudebot -g agentdata -m 2750 "$d"; done
for d in "$S/shared/stores" "$S/shared/data" "$S/shared/cc-digest" "$S/shared/rchannel-proposals"; do sudo install -d -o claudebot -g agentdata -m 2770 "$d"; done
for d in "$S/shared/memory" "$S/shared/skills" "$S/shared/skills/.archive"; do sudo install -d -o claudebot -g agentdata -m 3770 "$d"; done
install -d -m 0700 /home/claudebot/tmp
mvif() { if [ -e "$1" ]; then mv "$1" "$2" || { echo "FAILED: move $1"; exit 1; }; echo "moved $1"; else echo "absent $1"; fi; }
cpdir() { if [ -d "$1" ]; then cp -a "$1/." "$2/" || { echo "FAILED: copy $1"; exit 1; }; fi; }
for f in heartbeat health-state.json cal_notified.json voice-pending.json; do mvif "$REPO/$f" "$S/$f"; done
mvif "$REPO/data/quiz-state.json" "$S/data/quiz-state.json"
for f in reminders.json followups.json choices.json pending.json quiz-paused.flag; do mvif "$REPO/$f" "$S/shared/stores/$f"; done
mvif "$REPO/data/avot-state.json" "$S/shared/data/avot-state.json"
cpdir "$REPO/history" "$S/history"
cpdir "$REPO/uploads" "$S/uploads"
cpdir "$REPO/memory" "$S/shared/memory"
cpdir "$REPO/skills" "$S/shared/skills"
cmp "$REPO/memory/bot.db" "$S/shared/memory/bot.db" || { echo "FAILED: bot.db copy differs"; exit 1; }
qc=$("$BUN" -e "const{Database}=require('bun:sqlite');console.log(new Database('$S/shared/memory/bot.db',{readonly:true}).query('pragma quick_check').get().quick_check)")
[ "$qc" = ok ] || { echo "FAILED: quick_check $qc"; exit 1; }
after_mem=$(count "$S/shared/memory")
after_skills=$(count "$S/shared/skills")
[ "$after_mem" -ge "$before_mem" ] || { echo "FAILED: memory count $before_mem -> $after_mem"; exit 1; }
[ "$after_skills" -ge "$before_skills" ] || { echo "FAILED: skills count $before_skills -> $after_skills"; exit 1; }
after_hist=$(count "$S/history")
after_upl=$(count "$S/uploads")
[ "$after_hist" -ge "$before_hist" ] || { echo "FAILED: history count $before_hist -> $after_hist"; exit 1; }
[ "$after_upl" -ge "$before_upl" ] || { echo "FAILED: uploads count $before_upl -> $after_upl"; exit 1; }
rm -rf "$REPO/history" "$REPO/uploads" "$REPO/memory" "$REPO/skills"
if [ -e /home/claudebot/cc-journal/paused ]; then cp -p /home/claudebot/cc-journal/paused "$S/shared/cc-digest/"; fi
if [ -e /home/claudebot/cc-journal/last-digest.txt ]; then cp -p /home/claudebot/cc-journal/last-digest.txt "$S/cc-digest/"; fi
sudo chown -R claudebot:agentdata "$S"
sudo find "$S" -path "$S/shared" -prune -o -type f -exec chmod 0640 {} +
sudo find "$S/shared" -type f -exec chmod 0660 {} +
for d in "$S" "$S/data" "$S/history" "$S/uploads" "$S/cc-digest" "$S/shared"; do sudo chmod 2750 "$d"; done
sudo find "$S/history" "$S/uploads" -mindepth 1 -type d -exec chmod 2750 {} +
sudo find "$S/shared" -mindepth 1 -type d -exec chmod 2770 {} +
for d in "$S/shared/memory" "$S/shared/skills" "$S/shared/skills/.archive"; do sudo chmod 3770 "$d"; done
cp -p "$ENVF" "$ENVF.bak-r3"
if ! grep -q '^STATE_DIR=' "$ENVF"; then
  if [ -n "$(tail -c1 "$ENVF")" ]; then echo >> "$ENVF"; fi
  echo "STATE_DIR=$S" >> "$ENVF"
fi
echo "$S" > "$REPO/.state-dir"
chmod 0644 "$REPO/.state-dir"
sudo install -D -m 0644 "$REPO/deploy/telegram-agent-hardening.conf" /etc/systemd/system/telegram-agent.service.d/hardening.conf
sudo install -d /etc/systemd/system/telegram-agent-backup.service.d
printf '[Service]\nEnvironment=STATE_DIR=%s\nUMask=0027\n' "$S" | sudo tee /etc/systemd/system/telegram-agent-backup.service.d/state.conf >/dev/null
sudo systemctl daemon-reload
echo "after: memory $after_mem files, skills $after_skills files, history $after_hist files, uploads $after_upl files"
echo "R3 MOVE DONE (service still stopped)"
