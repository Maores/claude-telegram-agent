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
sudo systemctl restart telegram-agent
sleep 2
sudo journalctl -u telegram-agent -n 5 --no-pager || true
echo "Deploy complete."
