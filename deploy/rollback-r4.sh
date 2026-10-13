#!/bin/bash
# Way back from R4, in the rollout section's order: turns back to the poller's own user (restart),
# the egress rule off, agentturn's processes stopped, its outbox saved, its state files given to
# claudebot, the user and its home removed, the sudoers, limits and sshd drop-ins removed, the deny
# lines removed, the main home's modes restored from the record rollout-r4.sh made, and the
# firewall's OUTPUT chain compared with that record. Each step is skipped when already undone.
set -euo pipefail
S=/var/lib/telegram-agent
ENVF=/home/claudebot/.claude/channels/telegram/.env
REC=/etc/telegram-agent
G=$(id -gn)

if grep -q '^TURN_USER=' "$ENVF"; then
  cp -p "$ENVF" "$ENVF.bak-rollback-r4"
  sed -i '/^TURN_USER=/d' "$ENVF"
  echo "removed the TURN_USER line; diff against .env.bak-rollback-r4 (values hidden):"
  diff "$ENVF.bak-rollback-r4" "$ENVF" | sed -E '/^[<>] (STATE_DIR|TURN_USER)=/!s/^([<>] [^=]*=).*/\1(value hidden)/' || true
  sudo systemctl restart telegram-agent || { echo "FAILED: restart telegram-agent"; exit 1; }
  echo "telegram-agent restarted: turns run as the poller's user"
else
  echo "no TURN_USER line in the env file"
fi

if [ -e /etc/systemd/system/agentturn-egress.service ]; then
  sudo systemctl disable --now agentturn-egress.service || { echo "FAILED: disable agentturn-egress"; exit 1; }
  sudo rm -f /etc/systemd/system/agentturn-egress.service
  sudo systemctl daemon-reload
  echo "agentturn-egress removed"
fi

if id agentturn >/dev/null 2>&1; then
  sudo pkill -KILL -u agentturn || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! pgrep -u agentturn >/dev/null; then break; fi
    sleep 1
  done
  if pgrep -u agentturn >/dev/null; then echo "FAILED: agentturn processes still running"; exit 1; fi
  if sudo test -d /home/agentturn/outbox; then
    saved=/home/claudebot/tmp/outbox-saved
    if [ -e "$saved" ]; then saved="$saved-$(date +%Y%m%d%H%M%S)"; fi
    install -d -m 0700 /home/claudebot/tmp
    sudo cp -a /home/agentturn/outbox "$saved" || { echo "FAILED: save the outbox"; exit 1; }
    sudo chown -R -h "claudebot:$G" "$saved" || { echo "FAILED: chown $saved"; exit 1; }
    chmod 0700 "$saved"
    echo "outbox saved to $saved ($(find "$saved" -type f | wc -l) files)"
  fi
  if [ -d "$S" ]; then
    sudo find "$S" -user agentturn -exec chown -h claudebot {} + || { echo "FAILED: give agentturn's state files to claudebot"; exit 1; }
  fi
  left=$(sudo find / -xdev -user agentturn ! -path /home/agentturn ! -path '/home/agentturn/*' -print) || { echo "FAILED: the search for agentturn's files exited nonzero"; exit 1; }
  if [ -n "$left" ]; then
    echo "FAILED: agentturn still owns files outside /home/agentturn:"
    echo "$left"
    exit 1
  fi
  echo "agentturn owns nothing outside /home/agentturn"
  sudo userdel agentturn || { echo "FAILED: userdel agentturn"; exit 1; }
  echo "user agentturn removed"
else
  echo "user agentturn does not exist"
fi
sudo rm -rf /home/agentturn

sudo rm -f /etc/sudoers.d/telegram-agent-turn
sudo visudo -c || { echo "FAILED: visudo -c"; exit 1; }
sudo rm -f /etc/security/limits.d/agentturn.conf
if sudo test -e /etc/ssh/sshd_config.d/50-agentturn.conf; then
  sudo rm -f /etc/ssh/sshd_config.d/50-agentturn.conf
  sudo sshd -t || { echo "FAILED: sshd -t"; exit 1; }
  sudo systemctl reload ssh.service || sudo systemctl restart ssh.socket || { echo "FAILED: reload ssh"; exit 1; }
  echo "sshd drop-in removed"
fi
for f in /etc/cron.deny /etc/at.deny; do
  if sudo test -e "$f"; then
    sudo sed -i '/^agentturn$/d' "$f"
    if ! sudo test -s "$f"; then echo "$f is now empty: if R1's record shows it absent before R4, remove it by hand"; fi
  fi
done

if sudo test -f "$REC/r4-home-modes"; then
  LIST=$(mktemp) || { echo "FAILED: make a listing file"; exit 1; }
  trap 'rm -f "$LIST"' EXIT
  sudo cat "$REC/r4-home-modes" > "$LIST" || { echo "FAILED: read $REC/r4-home-modes"; exit 1; }
  while IFS= read -r -d '' rec; do
    m=${rec%% *}
    p=${rec#* }
    if ! [[ "$m" =~ ^[0-7]{1,4}$ ]]; then echo "skipped a record with a bad mode"; continue; fi
    if [ "$p" != /home/claudebot ]; then
      name=${p#/home/claudebot/}
      case "$name" in
        ""|*/*|"$p") echo "skipped a record outside the home's top level"; continue ;;
      esac
    fi
    if [ -L "$p" ]; then echo "skipped $p: it is a link now"; continue; fi
    if [ ! -e "$p" ]; then echo "gone since R4: $p"; continue; fi
    chmod "$m" "$p" || { echo "FAILED: chmod $m $p"; exit 1; }
  done < "$LIST"
  echo "home modes restored from $REC/r4-home-modes"
else
  echo "no $REC/r4-home-modes: restore the home modes from R1's record by hand"
fi

now=$(sudo iptables -S OUTPUT)
if sudo test -f "$REC/r4-iptables-output-before"; then
  before=$(sudo cat "$REC/r4-iptables-output-before")
  if [ "$now" = "$before" ]; then
    echo "iptables OUTPUT: the same as before R4"
  else
    echo "iptables OUTPUT differs from before R4:"
    diff <(echo "$before") <(echo "$now") || true
    echo "FAILED: the OUTPUT chain differs"
    exit 1
  fi
else
  echo "no record of the OUTPUT chain: compare with R1's by hand:"
  echo "$now"
fi
echo "R4 ROLLBACK DONE"
