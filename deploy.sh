#!/usr/bin/env bash
#
# deploy.sh — lossless redeploy for the Telegram agent on the droplet.
#
# The bot can hot-patch its own source live, leaving uncommitted edits to tracked
# files. A plain redeploy is `git reset --hard origin/main`, which DESTROYS those
# edits. This script captures any such edits to a `droplet-autosave/<ts>` branch
# (committed + pushed for review) BEFORE resetting, so a deploy can never silently
# lose self-written code. Untracked files (cal_check.sh, followups.json) survive a
# hard reset on their own and are intentionally left alone.
#
# Run it ON THE DROPLET from the repo dir:  ./deploy.sh
# (Never run it in a dev checkout — it resets --hard and restarts the service.)
set -euo pipefail

# Restart the service and PROVE it restarted, or fail loudly.
#
# 2026-08-10: two deploys in a row printed "Deploy complete" while the poller kept
# running the process it had started five days earlier. The new code sat on disk
# and the old process kept serving, which is invisible from the outside — a CLI
# check like `todo.ts list` even reads the NEW code, because it is a fresh
# process, so a spot-check can confirm a deploy that never happened.
#
# The proof is ActiveEnterTimestampMonotonic: microseconds since boot, taken
# before and after. It must CHANGE. Monotonic deliberately, not the wall clock —
# during that incident systemd was stamping wall-clock times five days stale, so
# a wall-clock comparison could have been fooled by the very fault this catches.
restart_and_verify() {
  local unit="${1:-telegram-agent}"
  local before after active
  # ${SUDO-sudo}: overridable so a root shell (or the tests) can run without it.
  # Plain dash, not :- , so an explicitly empty SUDO stays empty.
  before="$(systemctl show "$unit" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo "")"
  ${SUDO-sudo} systemctl restart "$unit"
  sleep 2
  after="$(systemctl show "$unit" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo "")"
  active="$(systemctl is-active "$unit" 2>/dev/null || true)"

  if [ -z "$after" ] || [ "$after" = "0" ] || [ "$after" = "$before" ]; then
    echo "❌ DEPLOY FAILED: $unit did not restart (start time unchanged: '${before}')."
    echo "   The new code is on disk but the OLD process is still serving it."
    echo "   Do NOT trust this deploy. Investigate before telling anyone it shipped."
    return 1
  fi
  if [ "$active" != "active" ]; then
    echo "❌ DEPLOY FAILED: $unit is '${active}' after the restart."
    return 1
  fi
  echo "✅ restart verified: start time ${before} → ${after}, service ${active}"
  return 0
}

# Sourced by the tests to exercise restart_and_verify against stub binaries;
# executed normally on the droplet, where the deploy below runs.
if [ "${DEPLOY_SOURCE_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

cd "$(dirname "$0")"
BUN="${BUN:-$HOME/.bun/bin/bun}"

# What would `reset --hard` destroy? (modified tracked files only)
mapfile -t FILES < <("$BUN" run selfdev-check.ts || true)

if [ "${#FILES[@]}" -gt 0 ] && [ -n "${FILES[0]:-}" ]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  BRANCH="droplet-autosave/$TS"
  echo "⚠️  Uncommitted tracked edits found — capturing to $BRANCH before deploy:"
  printf '    %s\n' "${FILES[@]}"
  git checkout -b "$BRANCH"
  git add -- "${FILES[@]}"
  git commit -m "chore(autosave): capture droplet self-edits before deploy ($TS)"
  if git push -u origin "$BRANCH"; then
    echo "✅ captured + pushed: $BRANCH (open a PR to review/merge)"
  else
    echo "⚠️  push failed — the capture commit is safe locally on branch $BRANCH"
  fi
  git checkout main
else
  echo "Working tree clean (no tracked code edits to capture)."
fi

echo "Fetching + resetting to origin/main…"
git fetch origin
git reset --hard origin/main

echo "Restarting telegram-agent…"
restart_and_verify telegram-agent

# ISO timestamps, so log lines that are actually days old cannot read as fresh.
sudo journalctl -u telegram-agent -n 5 -o short-iso --no-pager || true
echo "Deploy complete: now running $(git rev-parse --short HEAD)."
