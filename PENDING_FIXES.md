# Pending Fixes — Context for Manual Resolution

## Status as of 2026-07-06

Two branches are sitting locally on the server, NOT pushed to origin:

- `feat/persist-uploads` — the main fix (see below)
- `feat/quiz-system` — empty, never built (blocked by the issue below)

---

## Root Problem: Uploaded Files Are Deleted Every Session

### What happens now (broken)
1. Maor sends a file via Telegram
2. Bot downloads it to `./uploads/`, Claude reads it
3. At end of session, `cleanupFile(attachment?.path)` deletes it
4. Next session starts fresh — file is gone

### The fix (already written, NOT deployed)
Commit `c64d835` on branch `feat/persist-uploads`:
- Removed the `cleanupFile(attachment?.path)` call for documents/images
- Added `evictUploadsToFit(MAX_UPLOADS_BYTES)` — when `uploads/` exceeds 500MB, oldest files are deleted first
- `buildPrompt()` now injects a "Recent uploaded files" block so future sessions know what's on disk
- Voice notes still deleted immediately (already transcribed, no point keeping them)

### Why it's not live
The poller process on the server started around June 20. `bun` loads code once at startup — the running process still uses the OLD code. The fix commit was never pushed to `origin/main`, so:
- A `git reset --hard origin/main` (what `deploy.sh` does) would DESTROY the fix
- The fix is safe only because `deploy.sh` hasn't been run since the commit

### What to do when you get home

**Option A — quickest:**
```bash
# From your local machine (you have GitHub credentials there)
git fetch origin
git push origin feat/persist-uploads
# Then open a PR on GitHub and merge it
# Then on the server:
bash deploy.sh
```

**Option B — directly on server (if you have a GitHub token handy):**
```bash
git remote set-url origin https://<YOUR_TOKEN>@github.com/Maores/claude-bot.git
git push origin feat/persist-uploads
```

---

## Blocked: Quiz System (feat/quiz-system)

Maor sent `quiz-system-guide.md` several times to build a quiz feature. Each time the file was deleted before the session that was supposed to build it ran. Once the persist fix is deployed, he should resend the file and ask Claude to build the quiz system.

The `feat/quiz-system` branch is currently empty — nothing was built.

---

## Quick verification after deploy

After deploying, send any file via Telegram and then in the next message ask:
"what files are in uploads?" — Claude should list the file. If it does, the fix is working.
