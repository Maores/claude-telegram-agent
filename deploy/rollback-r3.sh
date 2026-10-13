#!/bin/bash
# Way back from R3: copy every state entry back to its R1 place (the repo, and ~/cc-journal for the
# digest files), then remove the state copies, the STATE_DIR line, the marker, the drop-ins and the
# group. Refuses unless the service is stopped and, before anything is written, unless every repo
# target is absent or byte-identical to its state copy. Each folder is decided on its own: one the
# repo lacks comes back from the state folder; one the repo still holds (an R3 that stopped
# partway) must match its state copy, which is then dropped. Nothing is dropped that is not home.
set -euo pipefail
REPO=/home/claudebot/claude-bot
S=/var/lib/telegram-agent
ENVF=/home/claudebot/.claude/channels/telegram/.env
CCJ=/home/claudebot/cc-journal
G=$(id -gn)
state=$(systemctl is-active telegram-agent || true)
[ "$state" = inactive ] || { echo "REFUSED: stop telegram-agent first ($state)"; exit 1; }
if [ ! -f "$REPO/memory/bot.db" ]; then
  [ -f "$S/shared/memory/bot.db" ] || { echo "REFUSED: neither $REPO/memory/bot.db nor $S/shared/memory/bot.db exists"; exit 1; }
fi
LIST=$(mktemp) || { echo "FAILED: make a listing file"; exit 1; }
trap 'rm -f "$LIST"' EXIT

# The plan: source, target, kind (same: the target must be absent or identical; over: the state
# copy replaces the ~/cc-journal file R3 copied it from; dir: a whole folder, absent or identical).
SRC=()
DST=()
KIND=()
plan() { SRC+=("$1"); DST+=("$2"); KIND+=("$3"); }
unknown=0
odd() { echo "UNKNOWN: $1 (not a known state entry: handle it by hand)"; unknown=1; }
skip() { echo "not copied back: $1 ($2)"; }
# A folder's entries, NUL-separated, into $LIST; a listing that fails stops the script.
listinto() {
  : > "$LIST"
  if [ -d "$1" ]; then find "$1" -mindepth 1 -maxdepth 1 -printf '%f\0' > "$LIST" || { echo "FAILED: list $1"; exit 1; }; fi
}
isfile() { if [ -L "$1" ]; then return 1; fi; [ -f "$1" ]; }
present() { [ -e "$1" ] || [ -L "$1" ]; }

listinto "$S"
while IFS= read -r -d '' e; do
  case "$e" in
    data|history|uploads|cc-digest|shared) ;;
    # The poller rewrites it in the state layout only; the repo layout never reads it.
    inbox-status.json) echo "skipped inbox-status.json (regenerated)" ;;
    *) if isfile "$S/$e"; then plan "$S/$e" "$REPO/$e" same; else odd "$S/$e"; fi ;;
  esac
done < "$LIST"
listinto "$S/data"
while IFS= read -r -d '' e; do
  if isfile "$S/data/$e"; then plan "$S/data/$e" "$REPO/data/$e" same; else odd "$S/data/$e"; fi
done < "$LIST"
listinto "$S/cc-digest"
while IFS= read -r -d '' e; do
  if isfile "$S/cc-digest/$e"; then plan "$S/cc-digest/$e" "$CCJ/$e" over; else odd "$S/cc-digest/$e"; fi
done < "$LIST"
listinto "$S/shared"
while IFS= read -r -d '' e; do
  case "$e" in
    memory|skills|stores|data|cc-digest|rchannel-proposals) ;;
    *) odd "$S/shared/$e" ;;
  esac
done < "$LIST"
# The folders below are written by turns: only the names the repo layout reads come back.
listinto "$S/shared/stores"
while IFS= read -r -d '' e; do
  case "$e" in
    reminders.json|followups.json|choices.json|pending.json|quiz-paused.flag)
      if isfile "$S/shared/stores/$e"; then plan "$S/shared/stores/$e" "$REPO/$e" same; else skip "$S/shared/stores/$e" "not a regular file"; fi ;;
    *) skip "$S/shared/stores/$e" "not a store the repo layout reads" ;;
  esac
done < "$LIST"
listinto "$S/shared/data"
while IFS= read -r -d '' e; do
  case "$e" in
    avot-state.json)
      if isfile "$S/shared/data/$e"; then plan "$S/shared/data/$e" "$REPO/data/$e" same; else skip "$S/shared/data/$e" "not a regular file"; fi ;;
    *) skip "$S/shared/data/$e" "not a file the repo layout reads" ;;
  esac
done < "$LIST"
listinto "$S/shared/cc-digest"
while IFS= read -r -d '' e; do
  case "$e" in
    paused|resume-requested)
      if isfile "$S/shared/cc-digest/$e"; then plan "$S/shared/cc-digest/$e" "$CCJ/$e" over; else skip "$S/shared/cc-digest/$e" "not a regular file"; fi ;;
    *) skip "$S/shared/cc-digest/$e" "not a digest control file" ;;
  esac
done < "$LIST"
listinto "$S/shared/rchannel-proposals"
while IFS= read -r -d '' e; do
  skip "$S/shared/rchannel-proposals/$e" "a routine proposal the repo layout never reads"
done < "$LIST"
# Every folder, in either case: absent in the repo, it comes back; present, it must match.
for pair in "history:history" "uploads:uploads" "shared/memory:memory" "shared/skills:skills"; do
  if [ -d "$S/${pair%%:*}" ]; then plan "$S/${pair%%:*}" "$REPO/${pair#*:}" dir; fi
done

# Checks before any write.
[ "$unknown" = 0 ] || { echo "REFUSED: unknown entries in $S (listed above); nothing was changed"; exit 1; }
declare -A seen=()
bad=0
for i in "${!SRC[@]}"; do
  s=${SRC[$i]}
  t=${DST[$i]}
  if [ -n "${seen[$t]:-}" ]; then echo "REFUSED: two state entries go back to $t"; bad=1; fi
  seen[$t]=1
  if present "$t"; then
    case "${KIND[$i]}" in
      over) ;;
      same) if [ -L "$t" ] || ! timeout 60 cmp -s "$s" "$t"; then echo "REFUSED: $t exists and differs from $s"; bad=1; fi ;;
      dir) if [ -L "$t" ] || ! timeout 300 diff -rq --no-dereference "$s" "$t" >/dev/null 2>&1; then echo "REFUSED: $t exists and differs from $s"; bad=1; fi ;;
    esac
  fi
done
[ "$bad" = 0 ] || { echo "REFUSED: nothing was changed"; exit 1; }

# Copy back.
for i in "${!SRC[@]}"; do
  s=${SRC[$i]}
  t=${DST[$i]}
  if [ "${KIND[$i]}" = dir ]; then
    if present "$t"; then echo "already home, identical: $t"; continue; fi
    n_s=$(find "$s" -type f | wc -l)
    cp -a "$s" "$t" || { echo "FAILED: copy $s"; exit 1; }
    n_t=$(find "$t" -type f | wc -l)
    [ "$n_t" = "$n_s" ] || { echo "FAILED: $t has $n_t files, $s has $n_s"; exit 1; }
    if [ "$t" = "$REPO/memory" ]; then cmp "$s/bot.db" "$t/bot.db" || { echo "FAILED: bot.db copy differs"; exit 1; }; fi
    chgrp -R -h "$G" "$t" || { echo "FAILED: chgrp $t"; exit 1; }
    find "$t" -type d -exec chmod g-s,a-t {} + || { echo "FAILED: folder modes under $t"; exit 1; }
    echo "back: $t ($n_t files)"
  else
    mkdir -p "$(dirname "$t")"
    cp -a --remove-destination "$s" "$t" || { echo "FAILED: copy $s"; exit 1; }
    timeout 60 cmp -s "$s" "$t" || { echo "FAILED: $t differs from $s after the copy"; exit 1; }
    chgrp -h "$G" "$t" || { echo "FAILED: chgrp $t"; exit 1; }
    echo "back: $t"
  fi
done
# A pause lifted while the service ran on the state folder must not come back from ~/cc-journal.
if [ -f "$REPO/.state-dir" ]; then
  if ! present "$S/shared/cc-digest/paused"; then
    if [ -e "$CCJ/paused" ]; then rm -f "$CCJ/paused"; echo "removed $CCJ/paused (the pause was lifted after R3)"; fi
  fi
fi

sudo rm -rf "$S" || { echo "FAILED: remove $S"; exit 1; }
echo "removed $S"
if grep -q '^STATE_DIR=' "$ENVF"; then
  cp -p "$ENVF" "$ENVF.bak-rollback-r3" || { echo "FAILED: env backup"; exit 1; }
  sed -i '/^STATE_DIR=/d' "$ENVF"
  echo "removed the STATE_DIR line; diff against .env.bak-rollback-r3 (values hidden):"
  diff "$ENVF.bak-rollback-r3" "$ENVF" | sed -E '/^[<>] (STATE_DIR|TURN_USER)=/!s/^([<>] [^=]*=).*/\1(value hidden)/' || true
fi
if [ -f "$ENVF.bak-r3" ]; then
  echo "diff against .env.bak-r3 (expected: nothing, or a final newline only; values hidden):"
  diff "$ENVF.bak-r3" "$ENVF" | sed -E '/^[<>] (STATE_DIR|TURN_USER)=/!s/^([<>] [^=]*=).*/\1(value hidden)/' || true
fi
rm -f "$REPO/.state-dir"
sudo rm -f /etc/systemd/system/telegram-agent.service.d/hardening.conf
sudo rm -f /etc/systemd/system/telegram-agent-backup.service.d/state.conf
if sudo test -d /etc/systemd/system/telegram-agent-backup.service.d; then sudo rmdir --ignore-fail-on-non-empty /etc/systemd/system/telegram-agent-backup.service.d; fi
if id agentturn >/dev/null 2>&1; then
  echo "user agentturn exists: group agentdata kept"
elif getent group agentdata >/dev/null; then
  members=$(getent group agentdata | cut -d: -f4)
  case ",$members," in *,claudebot,*) sudo gpasswd -d claudebot agentdata ;; esac
  sudo groupdel agentdata || { echo "FAILED: groupdel agentdata"; exit 1; }
  echo "group agentdata removed"
fi
sudo systemctl daemon-reload
echo "R3 ROLLBACK DONE (service still stopped)"
