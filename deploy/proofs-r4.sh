#!/bin/bash
# R4 proofs: what the turn user agentturn can and cannot do once R4 is in place. Run as claudebot,
# one ssh call: bash /home/claudebot/claude-bot/deploy/proofs-r4.sh
# Each proof prints one PASS, FAIL or INCONCLUSIVE line. No set -e: one failure never hides the
# rest. Lines starting with two spaces are information only.
S=/var/lib/telegram-agent
H=/home/claudebot
T=/home/agentturn
AT=(sudo -n -u agentturn)
works() { local n=$1; shift; if "$@" >/dev/null 2>&1; then echo "PASS $n"; else echo "FAIL $n"; fi; }
# A must-fail proof means nothing when agentturn cannot run anything at all.
refused() {
  local n=$1; shift
  if [ "$turn_ok" != 1 ]; then echo "INCONCLUSIVE $n (agentturn cannot run commands)"; return; fi
  if "$@" >/dev/null 2>&1; then echo "FAIL $n"; else echo "PASS $n"; fi
}

if "${AT[@]}" id >/dev/null 2>&1; then echo "PASS turn-user-runs"; turn_ok=1; else echo "FAIL turn-user-runs"; turn_ok=0; fi
refused turn-user-no-sudo "${AT[@]}" sudo -n true
if [ -e "$H/inbox/items.json" ]; then
  refused inbox-unreadable "${AT[@]}" cat "$H/inbox/items.json"
else
  echo "INCONCLUSIVE inbox-unreadable (no items.json to try)"
fi
refused home-unlistable "${AT[@]}" ls "$H"
refused repo-unwritable "${AT[@]}" touch "$H/claude-bot/x"
rm -f "$H/claude-bot/x"
refused state-unwritable "${AT[@]}" touch "$S/x"
sudo rm -f "$S/x"
if [ ! -e "$S/approvals.json" ]; then install -m 0640 /dev/null "$S/approvals.json"; fi
for f in approvals.json heartbeat voice-pending.json health-state.json history/.offset; do
  refused "no-append-$f" "${AT[@]}" sh -c ": >> $S/$f"
done
works repo-readable "${AT[@]}" head -1 "$H/claude-bot/CLAUDE.md"
works stores-writable "${AT[@]}" touch "$S/shared/stores/.p"
works stores-cleanup-by-claudebot rm "$S/shared/stores/.p"

# Seal canaries: claudebot's entries in the sticky memory folder and in shared/ stay put.
if touch "$S/shared/memory/.seal-canary"; then
  refused seal-rm-canary "${AT[@]}" rm -f "$S/shared/memory/.seal-canary"
  refused seal-mv-canary "${AT[@]}" mv "$S/shared/memory/.seal-canary" "$S/shared/memory/.seal-moved"
else
  echo "INCONCLUSIVE seal-canary (claudebot could not make it)"
fi
if mkdir "$S/shared/.seal-dir"; then
  refused seal-mv-dir "${AT[@]}" mv "$S/shared/.seal-dir" "$S/shared/.seal-moved"
else
  echo "INCONCLUSIVE seal-dir (claudebot could not make it)"
fi
rm -f "$S/shared/memory/.seal-canary" "$S/shared/memory/.seal-moved"
rmdir "$S/shared/.seal-dir" "$S/shared/.seal-moved" 2>/dev/null

layout_ok=1
for e in ":2750" "data:2750" "history:2750" "uploads:2750" "cc-digest:2750" "shared:2750" \
  "shared/stores:2770" "shared/data:2770" "shared/cc-digest:2770" "shared/rchannel-proposals:2770" "shared/memory/mirror:2770" \
  "shared/memory:3770" "shared/skills:3770" "shared/skills/.archive:3770"; do
  rel=${e%%:*}
  p=$S${rel:+/$rel}
  got=$(stat -c '%a %U:%G' "$p" 2>/dev/null || echo missing)
  echo "  $got $p"
  if [ "$got" != "${e#*:} claudebot:agentdata" ]; then layout_ok=0; fi
done
if [ "$layout_ok" = 1 ]; then echo "PASS state-layout"; else echo "FAIL state-layout"; fi

works mirror-writable "${AT[@]}" test -w "$S/shared/memory/mirror"
refused home-bashrc-sealed "${AT[@]}" touch "$T/.bashrc"
refused home-claude-sealed "${AT[@]}" touch "$T/.claude/x"
sudo rm -f "$T/.claude/x"
um=$("${AT[@]}" sh -c umask 2>/dev/null)
if [ "$um" = 0007 ]; then
  echo "PASS turn-umask"
else
  echo "FAIL turn-umask (got ${um:-nothing}: pam_umask overrides; add umask 007 to TURN_WRAPPER before R6)"
fi

if ! command -v curl >/dev/null; then
  echo "INCONCLUSIVE metadata-refused (no curl)"
elif ! curl -s -m 5 -o /dev/null http://169.254.169.254/; then
  echo "INCONCLUSIVE metadata-refused (the address does not answer claudebot either)"
else
  refused metadata-refused "${AT[@]}" curl -s -m 5 http://169.254.169.254/
fi

cron_out=$("${AT[@]}" crontab -l 2>&1)
cron_rc=$?
echo "  crontab -l: rc=$cron_rc, $(printf '%s\n' "$cron_out" | head -1)"
if [ "$turn_ok" != 1 ]; then
  echo "INCONCLUSIVE crontab-denied (agentturn cannot run commands)"
elif [ "$cron_rc" = 0 ]; then
  echo "FAIL crontab-denied"
else
  case "$cron_out" in
    *"not allowed"*) echo "PASS crontab-denied" ;;
    *) echo "FAIL crontab-denied (it failed without the not-allowed message)" ;;
  esac
fi

if sudo sshd -T 2>/dev/null | grep -qi '^denyusers.*agentturn'; then echo "PASS sshd-denies"; else echo "FAIL sshd-denies"; fi

env_out=$(CLAUDE_CODE_OAUTH_TOKEN=probe-1 TELEGRAM_BOT_TOKEN=bad sudo -n -u agentturn -- /usr/bin/env 2>/dev/null)
if ! printf '%s\n' "$env_out" | grep -qx 'CLAUDE_CODE_OAUTH_TOKEN=probe-1'; then
  echo "FAIL env-keep (CLAUDE_CODE_OAUTH_TOKEN did not cross)"
elif printf '%s\n' "$env_out" | grep -q '^TELEGRAM_BOT_TOKEN='; then
  echo "FAIL env-keep (TELEGRAM_BOT_TOKEN crossed)"
else
  echo "PASS env-keep"
fi

# Signals, in one shell: claudebot cannot signal the sudo it started; agentturn stops its own.
sudo -n -u agentturn sleep 300 &
p=$!
sleep 1
refused signal-sudo-refused kill "$p"
sudo -n -u agentturn pkill -TERM -u agentturn sleep
wait "$p"
rc=$?
if [ "$rc" = 143 ] || ! pgrep -u agentturn sleep >/dev/null; then
  echo "PASS signal-as-turn-user (rc=$rc)"
else
  echo "FAIL signal-as-turn-user (rc=$rc, the sleep still runs)"
fi

echo "  by hand next: the PC's routine sync, one phone-inbox list, then the next cc-journal push and backup pull logs"
