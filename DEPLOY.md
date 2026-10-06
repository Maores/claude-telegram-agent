# Deploy runbook — Claude Telegram agent on a DigitalOcean VPS

Ordered steps to take this repo from zero to a 24/7 bot. Commands marked
**(local)** run on your Windows machine; **(server)** run on the droplet over SSH.

Placeholders to replace: `<YOUR_SERVER_IP>`, `<YOUR_TOKEN>`,
`<YOUR_TELEGRAM_USER_ID>`, `<YOUR_NAME>`, `<YOUR_BOT_USERNAME>`, `<YOUR_REGION>`.
The GitHub repo is already created at `Maores/claude-telegram-agent` (public).

---

## Step 0 — Create the Telegram bot and find your user ID (phone/desktop Telegram)

1. Open Telegram, search **@BotFather**, send `/newbot`.
2. Pick a display name, then a username ending in `bot` (e.g. `my_assistant_bot`).
3. BotFather replies with a token like `1234567890:AAH...`. Keep it secret.
4. Message **@userinfobot** and note your numeric **user ID** (e.g. `43965740`).

You now have: bot token, bot username, your Telegram user ID.

---

## Step 1 — Create the droplet (DigitalOcean web console)

- Image: **Ubuntu 24.04 LTS**
- Size: **1 vCPU / 1 GB RAM / 25 GB SSD** (~$6/mo). Do not use the $4 plan —
  Claude needs ~1 GB RAM.
- Region: closest to you (e.g. `fra1`).
- Authentication: **add your SSH public key**.
  - **(local)** show your existing key: `Get-Content ~/.ssh/id_ed25519_chatgpt_bot.pub`
    — paste its contents into DigitalOcean, or just select it if it's already saved
    in your account.
  - To use a fresh key instead: `ssh-keygen -t ed25519`, then show that `.pub`.
- Create, then copy the droplet's public IP into `<YOUR_SERVER_IP>`.

---

## Step 2 — Base server setup (server, as root)

```bash
ssh root@<YOUR_SERVER_IP>

apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git curl tmux
npm install -g @anthropic-ai/claude-code
```

---

## Step 3 — Create the non-root `claudebot` user (server, as root)

Claude's `--dangerously-skip-permissions` is blocked for root, so the bot runs
as `claudebot`.

```bash
useradd -m -s /bin/bash claudebot
passwd claudebot                 # set a password
usermod -aG sudo claudebot

mkdir -p /home/claudebot/.ssh
cp ~/.ssh/authorized_keys /home/claudebot/.ssh/
chown -R claudebot:claudebot /home/claudebot/.ssh
chmod 700 /home/claudebot/.ssh
chmod 600 /home/claudebot/.ssh/authorized_keys
```

Reconnect as `claudebot`:

```bash
exit
ssh claudebot@<YOUR_SERVER_IP>
```

---

## Step 4 — Install Bun for claudebot (server)

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="/home/claudebot/.bun/bin:$PATH"
bun --version    # confirm it prints a version
```

---

## Step 5 — Get the code onto the server (local push, then server clone)

This repo commits **no secrets** (`.env`, `access.json`, history and memory are
gitignored), so a **public** GitHub repo is the simplest — it clones with no auth.

The repo is already created and pushed at
**https://github.com/Maores/claude-telegram-agent** (public), so there's nothing to do
locally. **(server)** clone it into `~/claude-bot`:

```bash
cd /home/claudebot
git clone https://github.com/Maores/claude-telegram-agent.git claude-bot
cd claude-bot
```

> Prefer a **private** repo? Create it with `--private`, then on the server run
> `gh auth login` (GitHub.com → HTTPS → browser) before `git clone`. You'd
> install gh first: `sudo apt install -y gh`.

---

## Step 6 — Authenticate Claude (server, interactive — only you can do this)

```bash
cd /home/claudebot/claude-bot
claude
# Follow the OAuth flow: open the printed URL in your browser, sign in with your
# Claude Pro account, paste the code back. Then type /exit.
```

Verify headless mode works:

```bash
echo "say hi in 3 words" | claude -p --dangerously-skip-permissions
```

---

## Step 7 — Store the Telegram token (server, never commit this)

```bash
mkdir -p /home/claudebot/.claude/channels/telegram
echo "TELEGRAM_BOT_TOKEN=<YOUR_TOKEN>" > /home/claudebot/.claude/channels/telegram/.env
chmod 600 /home/claudebot/.claude/channels/telegram/.env
```

> If this token also exists on any other machine that polls it, you'll get a
> Telegram **409 conflict**. It must live only here.

---

## Step 7b — Voice notes (optional but recommended)

Voice bubbles are transcribed before Claude sees them (`transcribe.ts`).
Without configuration the bot politely says voice isn't connected yet —
nothing breaks.

**Hosted backend (default, recommended on a 1 GB droplet):**

1. Create a free API key at https://console.groq.com (no card required).
2. Append it to the bot env file:

   ```bash
   echo 'GROQ_API_KEY=gsk_...' >> /home/claudebot/.claude/channels/telegram/.env
   ```

3. Restart the poller (`sudo systemctl restart telegram-agent`). Done —
   `TRANSCRIBE_BACKEND` auto-resolves to `groq` when the key is present.

Tuning (all optional, in the same `.env`):

| var | default | meaning |
|---|---|---|
| `TRANSCRIBE_BACKEND` | auto | `groq` / `local` / `off` (explicit override) |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | hosted whisper variant |
| `VOICE_MAX_SEC` | `300` | longest voice note accepted |
| `VOICE_ECHO_BELOW` | `0.6` | echo the transcript when confidence is below this; `0` = never echo |
| `VOICE_TIMEOUT_MS` | `45000` | transcription timeout |
| `VOICE_LANGS` | `he,en` | expected note languages; an off-list whisper detection (e.g. Hebrew tagged as Arabic) triggers ONE re-transcription forced to the first entry |
| `POLL_SERIAL` | unset | `1` reverts to the old strictly-sequential update loop (rollback switch; expect button lag + queued /stop again) |

**Local backend (keyless, deferred — for a bigger droplet someday):**

`TRANSCRIBE_CMD` is a shell command template; `{input}` is replaced with the
quoted audio path, and stdout must be `{"text": "...", "confidence": 0..1?}`
JSON. Example with whisper.cpp (UNVERIFIED — validate when you provision it;
the 1 GB droplet can only hold the `small` model, whose Hebrew is mediocre):

```bash
# one-time: apt install -y ffmpeg jq; build whisper.cpp; download a quantized model
TRANSCRIBE_CMD='wav=$(mktemp --suffix .wav); ffmpeg -y -loglevel error -i {input} -ar 16000 -ac 1 "$wav" && /home/claudebot/whisper.cpp/build/bin/whisper-cli -m /home/claudebot/whisper.cpp/models/ggml-small-q5_1.bin -l auto -np -nt -oj -of "${wav%.wav}" "$wav" >/dev/null && jq -c "{text: ([.transcription[].text] | join(\"\")), confidence: null}" "${wav%.wav}.json"; rm -f "$wav" "${wav%.wav}.json"'
```

A swap file is strongly advised before trying local inference on the 1 GB box.

---

## Step 7c — Calendar and tasks (optional)

`cal.ts` and `todo.ts` read and write a real iCloud calendar and Apple Reminders
over CalDAV. Skip this and the bot simply has no calendar or task ability.

**This is the one gap that fails silently.** Without the two variables below,
both CLIs exit with `ICLOUD_USER ... not set`, and a scheduled job that depends
on them does nothing without reporting anything. Nothing reaches the chat, and
nothing lands in the log as an error — it just quietly stops working.

1. Create an app-specific password for your Apple ID at
   https://account.apple.com — Apple requires one for third-party calendar
   clients, and your normal Apple ID password will not work here.
2. Append both values to the bot env file (never commit them):

   ```bash
   echo 'ICLOUD_USER=you@example.com' >> /home/claudebot/.claude/channels/telegram/.env
   echo 'ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx' >> /home/claudebot/.claude/channels/telegram/.env
   ```

3. Restart the poller, then prove it against the real account rather than
   assuming:

   ```bash
   cd ~/claude-bot && bun run cal.ts calendars
   ```

   It should print your calendar names. An authentication error means the
   app-specific password is wrong; an empty list means the credentials work but
   the account has no calendars.

---

## Step 8 — Create the real allowlist (server)

```bash
cat > /home/claudebot/.claude/channels/telegram/access.json << 'EOF'
{
  "dmPolicy": "pairing",
  "allowFrom": ["<YOUR_TELEGRAM_USER_ID>"],
  "groups": {},
  "pending": {}
}
EOF
```

The bot answers only IDs listed in `allowFrom`.

---

## Step 9 — User-level Claude permissions (server)

Lets the headless bot run without interactive permission prompts.

```bash
mkdir -p /home/claudebot/.claude
cat > /home/claudebot/.claude/settings.json << 'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "allow": ["Bash(*)", "Read", "Write", "Edit"]
  }
}
EOF
```

(The project-level `.claude/settings.json` is already in the repo.)

> **If you are adopting this repo, read this before Step 11.** Both that file and
> the one above grant `Bash(*)` — unrestricted shell — to every Claude session the
> bot spawns. That is deliberate for a single-user assistant on a dedicated
> droplet, where the guard hook (`guard.ts` plus the PreToolUse hook) is the real
> safety floor rather than the permission prompt. If you are deploying to a shared
> box, or onto a machine holding anything you would not hand a shell to, narrow
> the `allow` list first.

---

## Step 10 — Personalize the bot identity (server or local)

Edit `CLAUDE.md` and replace `<YOUR_NAME>`, `<YOUR_BOT_USERNAME>`, `<YOUR_REGION>`.
If you edit it locally, commit/push and `git pull` on the server.

The poller auto-creates `history/` and `memory/` on first run, so there is
nothing else to set up.

---

## Step 11 — Run it as a systemd service (server)

The poller runs under systemd (since 2026-06-11; it replaced tmux + an
`@reboot` cron after a crash took its logs with it — journald keeps the
evidence and `Restart=always` self-heals). Install the unit:

```bash
sudo tee /etc/systemd/system/telegram-agent.service > /dev/null << 'EOF'
[Unit]
Description=Telegram agent poller (claude-telegram-agent)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=claudebot
WorkingDirectory=/home/claudebot/claude-bot
EnvironmentFile=/home/claudebot/.claude/channels/telegram/.env
Environment=TZ=Asia/Jerusalem
Environment=PATH=/home/claudebot/.bun/bin:/home/claudebot/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/claudebot/.bun/bin/bun run poller.ts
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-agent
```

(No memory limits on purpose: claude child processes need the 1 GB box's
headroom; the `.env` must stay plain `KEY=VALUE` lines — systemd parses it
directly, no shell quoting.)

`KillMode=mixed` means SIGTERM goes only to the poller process (bun), not to
claude child processes that are already running — they keep going during the
drain window. `TimeoutStopSec=90` gives the poller 90 seconds before systemd
sends SIGKILL. The poller drains within 80 seconds (`GRACE_MS`), so under
normal load it exits cleanly well before that deadline. A deploy's journal will
show:

```
[BOT] SIGTERM — draining queues before exit
[BOT] drained — exiting
```

This prevents consumed-but-unprocessed updates from being lost on restart —
the offset is saved the moment updates are fetched, so anything enqueued but
not yet handled would otherwise be silently dropped.

Check it:

```bash
systemctl status telegram-agent
sudo journalctl -u telegram-agent -f     # live logs; expect:
# [BOT] Poller started as @<YOUR_BOT_USERNAME>
```

Message your bot from Telegram. Expect `[MSG] …` / `[DONE] …` lines in the
journal. Reboot survival comes from `enable` — no cron entry needed (the old
`@reboot start.sh` line must NOT coexist with the service: two pollers fight
over getUpdates with 409s). `start.sh` remains useful for a one-off
foreground run while debugging.

---

## Step 12 — Backups (server + local)

The agent's accumulated state (memories, skills, chat archive, reminders,
quiz progress, the guard-hook wiring) lives outside git. `backup.ts` snapshots
all of it nightly: a WAL-safe `VACUUM INTO` copy of `memory/bot.db` plus the
JSON state files, `quiz-paused.flag`, `memory/` markdown + mirror, `skills/`,
`history/`, `data/questions.json` + `data/quiz-state.json`,
`.claude/settings.local.json`, and the Telegram allowlist. **Deliberately
excluded:** every `.env` (tokens are re-issuable; archives leave the box, so
after a restore redo steps 6-8) and `uploads/` (replaceable bulk). Archives
land in `~/backups/`, newest 14 kept, `latest.tar.gz` symlinked.

Install the timer **(server)**:

```bash
sudo tee /etc/systemd/system/telegram-agent-backup.service > /dev/null << 'EOF'
[Unit]
Description=Nightly state backup (claude-telegram-agent)

[Service]
Type=oneshot
User=claudebot
WorkingDirectory=/home/claudebot/claude-bot
Environment=TZ=Asia/Jerusalem
ExecStart=/home/claudebot/.bun/bin/bun run backup.ts run
EOF

sudo tee /etc/systemd/system/telegram-agent-backup.timer > /dev/null << 'EOF'
[Unit]
Description=Nightly state backup timer (claude-telegram-agent)

[Timer]
# Timezone is pinned here: OnCalendar is evaluated by systemd itself, so the
# service-level TZ env would not affect the firing time.
OnCalendar=*-*-* 03:30:00 Asia/Jerusalem
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now telegram-agent-backup.timer
systemctl list-timers telegram-agent-backup.timer   # next fire time
```

Manual run + restore drill (do this once after installing and after any
schema change; a backup that has never been restored is a hope, not a
backup):

```bash
cd ~/claude-bot
bun run backup.ts run
bun run backup.ts verify ~/backups/latest.tar.gz   # table + file counts; exits 1 on failure
```

Full restore onto a fresh droplet: finish steps 0-11 first, stop the service
(`sudo systemctl stop telegram-agent`), extract the archive
(`mkdir /tmp/r && tar xzf <archive> -C /tmp/r`), copy it back with the
dot-form (plain `repo/*` globs would silently skip `.claude/`, losing the
guard hook and allowlist):

```bash
cp -a /tmp/r/repo/. ~/claude-bot/
cp -a /tmp/r/home/. ~/
```

then re-create the `.env` secrets (steps 6-8) and
`sudo systemctl start telegram-agent`.

### Liveness self-check (roadmap 0.2)

`health.ts` runs from cron, independently of the poller, and messages Maor
through the Telegram Bot API directly when the agent is unhealthy. It exists for
the 2026-06-20 failure: the OAuth token expired, systemd still reported the
service active, and the agent was silently dead for 28 hours.

```bash
# hourly: service + poller heartbeat.  every 6h: also probe claude auth.
crontab -e
15 * * * * cd ~/claude-bot && set -a && . ~/.claude/channels/telegram/.env && set +a && ~/.bun/bin/bun run health.ts check >> ~/claude-bot/health.log 2>&1
30 */6 * * * cd ~/claude-bot && set -a && . ~/.claude/channels/telegram/.env && set +a && ~/.bun/bin/bun run health.ts check --auth >> ~/claude-bot/health.log 2>&1
```

`TELEGRAM_CHAT_ID` must be in that env file for alerts to have a destination.
Alerts are edge-triggered: one on the way into a fault, one on recovery, and a
single daily reminder while it stays broken, so a healthy week is silent.

What it cannot detect is the droplet being off or off-network — nothing running
on the box can report its own absence. That gap needs an outside pinger such as
healthchecks.io: create a check there and curl its ping URL from the same cron
line.

Off-box copies, two independent layers:

1. **DigitalOcean automated backups** (whole-disk, hands-off, priced as a
   percentage of the droplet): enable from the DigitalOcean control panel;
   see https://docs.digitalocean.com/products/backups/ ("How to Enable
   Backups"). Covers total droplet loss.
2. **Nightly pull to the local machine (local)**: `scripts/pull-backup.ps1`
   copies the newest archive to
   `%USERPROFILE%\OneDrive\Backups\telegram-agent` (OneDrive sync adds a free
   cloud copy) and rotates to 14. The committed defaults are placeholders;
   pass your target explicitly. Register it as a daily task (runs when the
   PC is on and you're logged in):

   ```powershell
   $pwsh = (Get-Command pwsh).Source
   $script = "<path-to-repo>\scripts\pull-backup.ps1"
   $args = "-RemoteUserHost claudebot@<YOUR_SERVER_IP> -KeyPath `"$env:USERPROFILE\.ssh\<YOUR_KEY>`""
   schtasks /Create /F /TN "TelegramAgent backup pull" /SC DAILY /ST 10:00 `
     /TR "`"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$script`" $args"
   # Post-registration settings (schtasks has no flags for these):
   # - ExecutionTimeLimit PT5M: a pull that outlives 5 minutes is hung, not
   #   transferring, and gets killed so it can't sit on a dead ssh session.
   # - StartWhenAvailable: a 10:00 window missed because the PC was off or
   #   asleep runs as soon as it can, instead of silently skipping the day.
   # - Battery flags: a laptop on battery at 10:00 otherwise refuses the run
   #   (0x800710E0) and the day is skipped.
   $t = Get-ScheduledTask -TaskName "TelegramAgent backup pull"
   $t.Settings.ExecutionTimeLimit = "PT5M"
   $t.Settings.StartWhenAvailable = $true
   $t.Settings.DisallowStartIfOnBatteries = $false
   $t.Settings.StopIfGoingOnBatteries = $false
   Set-ScheduledTask -InputObject $t | Out-Null
   ```

   Run it once by hand first:
   `pwsh -File scripts\pull-backup.ps1 -RemoteUserHost claudebot@<YOUR_SERVER_IP> -KeyPath $env:USERPROFILE\.ssh\<YOUR_KEY>`.
   The same `bun run backup.ts verify <archive>` works on Windows (run it from
   PowerShell) to check a pulled archive.

---

## Step 13 — Calendar placeholder-time check (cron)

`cal_check.sh` pings the chat at 20:00 when tomorrow has events still parked at
the 07:59 placeholder time (events created without deciding a real hour). Plain
bash + curl, no claude spawn. Install **(server)**:

```bash
crontab -l 2>/dev/null | { cat; echo '0 20 * * * /bin/bash /home/claudebot/claude-bot/cal_check.sh >> /home/claudebot/claude-bot/cal_check.log 2>&1'; } | crontab -
crontab -l   # verify the line landed
```

---

## Step 14 — Evening Claude Code digest (server + local)

At 21:30 the poller sends a Hebrew summary of the Claude Code work logged since
the previous digest. The source is the owner's daily log (an Obsidian vault on
the PC, where every session appends `- HH:MM — topic: sentence ([[Note]])` to
`Daily/YYYY-MM-DD.md`). Quiet on Shabbat and holiday nights and on nights with
nothing new. Design: `docs/superpowers/specs/2026-09-25-cc-digest-design.md`.

**(server)** nothing to install beyond the code. Once, after the deploy that
brings it (over a non-interactive ssh, `bun` is `~/.bun/bin/bun`):

```bash
cd ~/claude-bot
~/.bun/bin/bun run ccdigest.ts init      # count log entries from today on
~/.bun/bin/bun run ccdigest.ts pause     # nothing goes out until the checks below pass
~/.bun/bin/bun run ccdigest.ts calendar  # expect "0 unreadable"
~/.bun/bin/bun run ccdigest.ts status
```

**Running the local steps from a Claude session in the Claude desktop app?** The
app is a packaged Windows app: whatever its sessions write under `%LOCALAPPDATA%`
(apart from `Temp`) lands in the app's private folder
(`%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Local\...`). The session keeps
seeing those files, but the scheduled task, a separate process, does not, so it
fails without writing a log line (found 2026-09-25). Either run steps 1 and 2 in
a normal terminal outside the app, or stage the copy and the settings file under
`%TEMP%` (not redirected) and let the task put them in place once: point its
action at a short copy script, start it, then restore the action. A real push
started from a session writes its log and `last-push-ok` into that private
folder as well, so from a session run only `--dry-run` and start real pushes
through the task. Files a session wrote there by mistake hide the real ones from
later sessions: move them out.

**(local) 1. The deployed copy.** The task never runs the development checkout,
which switches branches. Build the copy from `origin/main`, and rebuild it at
every deploy that changes `ccjournal.ts` or `scripts/cc-journal-push.*`
(`status` on the server says "PC copy out of step" when it is stale):

```powershell
$repo = "<path-to-repo>"
$copy = "$env:LOCALAPPDATA\TelegramAgent\cc-journal-push"
$tar = Join-Path $env:TEMP "cc-journal-push.tar"
git -C $repo fetch origin
git -C $repo archive -o $tar origin/main ccjournal.ts scripts/cc-journal-push.ts scripts/cc-journal-push.ps1
New-Item -ItemType Directory -Force $copy | Out-Null
tar -xf $tar -C $copy
git -C $repo rev-parse --short origin/main | Set-Content -Encoding ascii (Join-Path $copy "version.txt")
```

**(local) 2. The settings file,** `%LOCALAPPDATA%\TelegramAgent\cc-journal-push.json`
(JSON, so backslashes are doubled). Write it with an editor; from a Claude
session use its Write tool, because a vault guard that refuses shell commands
naming the vault would refuse a command that writes it:

```json
{ "vault": "<vault>", "target": "claudebot@<YOUR_SERVER_IP>", "key": "<path to the ssh key>" }
```

Before anything leaves the PC, scan a dry run for contacts the sanitizer might
miss (this names no vault, so a Claude session may run it); read both lists by
eye, expecting no address and no phone number:

```powershell
$json = & "$env:LOCALAPPDATA\TelegramAgent\cc-journal-push\scripts\cc-journal-push.ps1" --dry-run
[regex]::Matches($json, '[^" ]*@[^" ]*') | ForEach-Object Value | Sort-Object -Unique
[regex]::Matches($json, '[+(0-9][0-9 ().-]{8,}[0-9]') | ForEach-Object Value | Sort-Object -Unique
```

**(local) 3. The hourly task.** Like the backup pull it runs while you are
signed in; it starts with no window, through a headless console host, and its
command line names only the launcher:

```powershell
$pwsh = (Get-Command pwsh).Source
$launcher = "$env:LOCALAPPDATA\TelegramAgent\cc-journal-push\scripts\cc-journal-push.ps1"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$pwsh`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$hourly = New-ScheduledTaskTrigger -Once -At "00:20" -RepetitionInterval (New-TimeSpan -Hours 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = "PT2M"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "TelegramAgent cc-journal push" -Action $action -Trigger $hourly, $logon -Settings $settings
(Get-ScheduledTask -TaskName "TelegramAgent cc-journal push").Triggers | Select-Object StartBoundary, @{n='Interval';e={$_.Repetition.Interval}}, @{n='Duration';e={$_.Repetition.Duration}}
Start-ScheduledTask -TaskName "TelegramAgent cc-journal push"
for ($i = 0; $i -lt 60 -and (Get-ScheduledTask -TaskName "TelegramAgent cc-journal push").State -ne 'Ready'; $i++) { Start-Sleep -Seconds 2 }
Get-Content "$env:LOCALAPPDATA\TelegramAgent\cc-journal-push.log" -Tail 3
```

Read the triggers back: the hourly one must show `PT1H` with an empty
(indefinite) duration. If it shows a finite duration instead, unregister the
task and register it again with `-RepetitionDuration (New-TimeSpan -Days 3650)`
added to `$hourly`. Each successful run touches `last-push-ok` beside the log,
and a watchdog reads its time. The action puts `conhost.exe --headless` in
front of pwsh because Windows Terminal, the default terminal on Windows 11,
ignores `-WindowStyle Hidden`: without the headless host a terminal window
opened on the first run (and that run failed). The headless host also hides the
exit code, so the task's Last Run Result reads 0 even when the push failed:
judge a run by the log's last line and by `last-push-ok`.

**Verify (server), then resume.** `preview` prints only the ask; the real run
also adds the memory block and a "New message from Maor:" line. A hand-run
`claude -p` needs the service environment, or it fails with a misleading 401;
the line below passes the poller's own flags (`digestSpawnOpts` in `poller.ts`),
with text output instead of stream-json.
Resume before 21:30 on the evening you want the first digest (a later `resume`
also lets that evening's paused run go ahead); if days passed since `init`,
run `init --force` first so the first digest covers one day:

```bash
cd ~/claude-bot
~/.bun/bin/bun run ccdigest.ts status
set -a && . ~/.claude/channels/telegram/.env && set +a && ~/.bun/bin/bun run ccdigest.ts preview | CLAUDE_AUTO_SESSION=1 claude -p --model claude-sonnet-5 --output-format text --dangerously-skip-permissions --disallowedTools "Bash(bun run remind.ts add-once *)" "Bash(bun run remind.ts add-repeat *)" "Bash(bun run monitor.ts add *)" "Bash(bun run ask.ts *)" --tools "" --strict-mcp-config
~/.bun/bin/bun run ccdigest.ts resume
```

After the first 21:30: `TZ=Asia/Jerusalem journalctl -u telegram-agent --since 21:25 --no-pager | grep -F '[DIGEST]'`
shows `[DIGEST] sent …`, `status` shows the last run as `sent`, and the usage log
has a `kind = 'auto'` row from that minute:

```bash
cd ~/claude-bot && ~/.bun/bin/bun -e 'import { Database } from "bun:sqlite"; const db = new Database("memory/bot.db", { readonly: true }); console.log(db.query("SELECT datetime(ts, \"unixepoch\", \"localtime\") AS at, kind, model FROM usage_log WHERE kind = \"auto\" ORDER BY ts DESC LIMIT 3").all())'
```

A deploy that bumps `SANITIZER_VERSION` takes effect only when the PC copy is
rebuilt: deploy the server first, then rebuild the copy (1 above). The next
evening re-keys old lines by itself; `~/.bun/bin/bun run ccdigest.ts resync` is
the manual fallback.

---

## Step 15 — Routine channel (server + local)

Claude Desktop routines on the owner's PC leave requests for him (a plain notice,
or cards he answers one at a time with ✓ מאשר, ✗ דוחה, מאשר הכל and אחר…). A PC
task hands them to the server every 5 minutes over the existing ssh key and takes
his answers back; a handler registered on the PC carries them out. New messages
wait through Shabbat and holidays (from 14:00 the day before until 21:00 on the
day). Design: `docs/superpowers/specs/2026-09-27-routine-channel-design.md`.

**(server)** nothing to install beyond the code; the store is
`~/rchannel/store.json`, outside the repo and outside the nightly backup (the PC
keeps a copy of every request it sent). After the deploy that brings it, check
the sync contract over a non-interactive ssh, where `bun` is `~/.bun/bin/bun`:

```bash
cd ~/claude-bot
echo '{"v":1,"requests":[],"acks":[],"results":[],"closes":[]}' | ~/.bun/bin/bun run rchannel.ts sync
# expect: {"v":1,"received":[],"answers":[]}
~/.bun/bin/bun run ccdigest.ts calendar   # the quiet-time check reads the same calendar: expect "0 unreadable"
```

The channel logs `[RC]` lines: `TZ=Asia/Jerusalem journalctl -u telegram-agent --since today --no-pager | grep -F '[RC]'`.

**(local)** The PC half lives in `%USERPROFILE%\.claude\tools\routine-channel`
(below: the channel's home). The Claude desktop app does not redirect that folder,
so, unlike step 14's `%LOCALAPPDATA%` folder, a Claude session may write it
directly and the scheduled task sees the same files.

**(local) 1. The deployed copy.** The task never runs the development checkout,
which switches branches. Build the copy from `origin/main`, and rebuild it at
every deploy that changes `rchannel-schema.ts` or `scripts/rchannel-*`:

```powershell
$repo = "<path-to-repo>"
$chan = "$env:USERPROFILE\.claude\tools\routine-channel"
$tar = Join-Path $env:TEMP "rchannel-app.tar"
git -C $repo fetch origin
git -C $repo archive -o $tar origin/main rchannel-schema.ts scripts/rchannel-pc.ts scripts/rchannel-sync.ps1
New-Item -ItemType Directory -Force "$chan\app" | Out-Null
tar -xf $tar -C "$chan\app"
git -C $repo rev-parse --short origin/main | Set-Content -Encoding ascii "$chan\app\version.txt"
```

**(local) 2. The settings,** two JSON files in the channel's home (backslashes
doubled). `config.json` names the server and the key's path, never a key.
`handlers.json` names, per routine, the program that carries out its answers;
the task appends a work file's path to that argv and runs it with no shell.

```json
{ "target": "claudebot@<YOUR_SERVER_IP>", "key": "<path to the ssh key>" }
```

```json
{ "map": { "argv": ["<python>", "<map script>", "--phone-answers"], "timeout_s": 120 } }
```

Check they parse: `& "$env:USERPROFILE\.bun\bin\bun.exe" "$chan\app\scripts\rchannel-pc.ts" open`
prints `nothing is waiting`.

**(local) 3. The 5-minute task,** registered like step 14's: while you are signed
in, never waking the machine, with no window through a headless console host:

```powershell
$pwsh = (Get-Command pwsh).Source
$launcher = "$env:USERPROFILE\.claude\tools\routine-channel\app\scripts\rchannel-sync.ps1"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$pwsh`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" sync"
$every5 = New-ScheduledTaskTrigger -Once -At "00:02" -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "TelegramAgent routine channel" -Action $action -Trigger $every5 -Settings $settings
(Get-ScheduledTask -TaskName "TelegramAgent routine channel").Triggers | Select-Object StartBoundary, @{n='Interval';e={$_.Repetition.Interval}}, @{n='Duration';e={$_.Repetition.Duration}}
Start-ScheduledTask -TaskName "TelegramAgent routine channel"
for ($i = 0; $i -lt 60 -and (Get-ScheduledTask -TaskName "TelegramAgent routine channel").State -ne 'Ready'; $i++) { Start-Sleep -Seconds 2 }
Get-Item "$env:USERPROFILE\.claude\tools\routine-channel\last-sync-ok" | Select-Object LastWriteTime
```

The trigger must read `PT5M` with an empty (indefinite) duration; if not, register
it again with `-RepetitionDuration (New-TimeSpan -Days 3650)` added to `$every5`.
The headless host hides the exit code (Last Run Result reads 0 even on failure):
judge a run by `last-sync-ok` and by `sync.log`, which gets a line only when
something was sent, answered or refused, or a call failed. A request file that
fails validation moves to `outbox\rejected\` with its reason in the log.

A run stays inside the task's 5 minutes: each ssh call gets at most 60 s, each
handler at most its `timeout_s` (capped at 150 s), and a second routine's handler
starts only when it can run to its timeout and still leave 60 s for the last
call before 285 s (otherwise its answers wait for the next cycle).
A handler that stays busy for an hour has its answers reported failed. A
`state.json` that cannot be read at all (busy, or not a file) stops the cycle
with a `FAILED: cannot read state.json` line and is left as it is. If it is ever
lost or damaged (a damaged one is kept aside as `state.json.corrupt-<ms>`), move the request files from `sent\` back to
`outbox\`: the next sync sends them again, the server reports them received,
and the PC records them.

---

## Step 16 — Phone inbox (server)

A Telegram group that holds only you and the bot becomes a drop box: the poller
stores each message there under `~/inbox/` (`items.json` and `files/`, outside
the repo and outside the nightly backup) and reacts 👍, with no Claude turn. A PC
session pulls the items with a key of its own when you ask; the server deletes
what landed, and after a week what was never pulled, warning in the group the
day before (never right before or during Shabbat and holidays; ten days is the
hard limit). Design: `docs/superpowers/specs/2026-10-05-phone-inbox-design.md`.
`INBOX_DIR` (another folder in place of `~/inbox/`) is for tests only: never set
it for the service, since the PC key's forced `inbox.ts gate` does not read the
service's `.env` (and part 3 checks that no other file or ssh setting brings one
in), and the two would then read different folders.

**1. The code, with the setting unset.** `./deploy.sh` (it captures droplet
edits and proves the restart). From then on a message in any group is logged
once as `[INBOX?] chat <id>` and never answered. That holds in rollback mode
(`POLL_SERIAL=1`) too: a message in a group that is not the inbox is now logged
and skipped there, not answered. Then:

```bash
cd ~/claude-bot
~/.bun/bin/bun run inbox.ts status
# expect: {"v":1,"waiting":0,"files":0,"bytes":0,"oldestAgeS":null}
TZ=Asia/Jerusalem journalctl -u telegram-agent --since today --no-pager | grep -F '[INBOX'
# expect: [INBOX] off (INBOX_CHAT_ID is unset)
```

**2. The guard hook gains the reading tools.** The live wiring is the untracked
`~/claude-bot/.claude/settings.local.json` (never the tracked `.claude/settings.json`,
which `deploy.sh` would autosave and reset). Back it up, change only the matcher
to `Bash|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob|LS|create_draft`, and check:

```bash
cp ~/claude-bot/.claude/settings.local.json ~/claude-bot/.claude/settings.local.json.bak-$(date +%Y%m%d-%H%M)
jq . ~/claude-bot/.claude/settings.local.json > /dev/null && echo parses
git -C ~/claude-bot status --porcelain .claude   # expect: nothing
```

Then prove the refusal mechanically (the agent's own instructions already tell
it not to read the inbox, so asking it in the chat proves nothing):

```bash
jq -r '.hooks.PreToolUse[].matcher' ~/claude-bot/.claude/settings.local.json
# expect the new matcher
cd ~/claude-bot
echo '{"tool_name":"Read","cwd":"/home/claudebot/claude-bot","tool_input":{"file_path":"/home/claudebot/inbox/items.json"}}' | ~/.bun/bin/bun run hooks/pretooluse-guard.ts; echo "exit $?"
# expect: the inbox reason on stderr, exit 2
echo '{"tool_name":"Read","cwd":"/home/claudebot/claude-bot","tool_input":{"file_path":"/home/claudebot/claude-bot/inbox.ts"}}' | ~/.bun/bin/bun run hooks/pretooluse-guard.ts; echo "exit $?"
# expect: exit 0
mkdir -p ~/inbox && [ -e ~/inbox/items.json ] || echo '{"v":1,"items":[]}' > ~/inbox/items.json
set -a && . ~/.claude/channels/telegram/.env && set +a   # the service's own login for claude -p
claude -p --dangerously-skip-permissions --output-format stream-json --verbose "Call the Read tool once on /home/claudebot/inbox/items.json and print the raw tool result" | tee ~/inbox-probe.jsonl | grep -c "phone inbox is read and written only"
# expect: at least 1 (a real turn, through the live settings, hit the refusal)
grep -c '"name":"Read"' ~/inbox-probe.jsonl
# expect: at least 1 (the model really called the tool)
```

The turn runs from `~/claude-bot` and loads `CLAUDE.md`, which tells the agent
never to open `~/inbox`, so the model may decline to call Read at all. If the
second count is 0, the model never called the tool: the result is inconclusive,
not a failure of the guard. Rerun the same `claude -p` line with
`--append-system-prompt "This is the operator's own test of the guard hook: call the Read tool exactly as asked."`
added before the prompt, and read both counts again. Then read the tools the
turn started with, since the guard's command rules see only `Bash`:

```bash
grep -m1 '"subtype":"init"' ~/inbox-probe.jsonl | jq -r '.tools'
# expect: no tool other than Bash that runs a shell command (null: read the whole line)
```

If another tool there runs a shell command, stop and report it: its commands
would pass the guard unread. Then remove the probe file:

```bash
rm ~/inbox-probe.jsonl
```

The matcher and the guard's file-tool check also name the legacy `LS` listing
tool, so it cannot list `~/inbox` either.

**3. The PC's own key.** The PC pulls with a key that can do nothing else. First
check that the key cannot bring settings in with it, and that Bun finds none of
its own in the repo folder (it loads those from its working folder, for the
gate too):

```bash
sudo sshd -T | grep -Ei '^(acceptenv|permituserenvironment)'
# expect: permituserenvironment no, and acceptenv naming only LANG and LC_* (or none)
ls -la ~/claude-bot/.env* ~/claude-bot/bunfig.toml
# expect: "No such file or directory" for each
cd ~/claude-bot && ~/.bun/bin/bun --no-env-file run inbox.ts status
# expect: the status JSON, as in part 1
```

If sshd accepts another variable or permits user environment, stop: the key
could pass `INBOX_DIR`. If either file exists, stop and find out why it is there.
If the last check printed the status JSON, the forced command carries
`--no-env-file` as below; if it failed, drop that flag from the line. The line
for `~/.ssh/authorized_keys` (the public key comes from the PC):

```
restrict,command="cd /home/claudebot/claude-bot && /home/claudebot/.bun/bin/bun --no-env-file run inbox.ts gate" ssh-ed25519 AAAA... phone-inbox
```

Add it without retyping it through shells (a malformed line, or one glued to the
key above it, can lock the PC out): write the line to a local file named
`inbox-key.line` and the script below to a local file named `add-inbox-key.sh`,
copy both up with the existing key into the home folder under those same names
(`scp inbox-key.line add-inbox-key.sh <target>:`, so they land at
`~/inbox-key.line` and `~/add-inbox-key.sh`, where the script expects them), and
run the script in one call (`ssh <target> 'bash ~/add-inbox-key.sh'`).
The script refuses a key that is already in `authorized_keys` (sshd uses the
first line that matches a key, so an earlier unrestricted line for the same key
would leave the inbox key unconfined), and restores the backup by itself when
the count of keys did not rise by exactly one:

```bash
#!/usr/bin/env bash
set -u
f=~/.ssh/authorized_keys
new=$(ssh-keygen -lf ~/inbox-key.line 2>/dev/null | awk '{print $2}')
if [ -n "$new" ] && ssh-keygen -lf "$f" 2>/dev/null | awk '{print $2}' | grep -qxF "$new"; then
  echo "REFUSED: this key is already in authorized_keys; generate a new one"; exit 1
fi
bak="$f.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$f" "$bak"
before=$(ssh-keygen -lf "$f" | wc -l)
[ -z "$(tail -c1 "$f")" ] || echo >> "$f"
cat ~/inbox-key.line >> "$f"
after=$(ssh-keygen -lf "$f" 2>/dev/null | wc -l)
if [ "$after" -ne $((before + 1)) ]; then cp -p "$bak" "$f"; echo "RESTORED: keys $before -> $after"; exit 1; fi
rm ~/inbox-key.line ~/add-inbox-key.sh
stat -c %a "$f"   # expect: 600
echo "added: keys $before -> $after"
```

Then, at once, a new connection with the old key (`ssh <target> echo ok`).
Then, from the PC, with the inbox key and `-o IdentitiesOnly=yes -o IdentityAgent=none`:

- `list` prints `{"v":1,"items":[]}` (the gate reads it from `SSH_ORIGINAL_COMMAND`);
- `ls`, `status` and `list; id` print `refused: the inbox key may only list, ack or get`, exit 2;
- `ssh -t ... list` prints `PTY allocation request failed` (and still answers);
- `ssh -o ExitOnForwardFailure=yes -N -R 127.0.0.1:18080:localhost:22 ...` exits at once with `remote port forwarding failed`;
- `ssh -N -L 18080:localhost:22 ...` in the background for 20 seconds, while `Test-NetConnection 127.0.0.1 -Port 18080` connects once: ssh's error output says `administratively prohibited`;
- `sftp -i <inbox key> <target>` fails without a session.

**4. The group** (with you at the phone, one step at a time):

1. In Telegram, create a group with only you and the bot.
2. Make the bot an admin and switch OFF every admin right Telegram pre-ticks
   (delete messages, invite users, pin, and the rest): it needs none, only the
   admin status, which lets it see every message under privacy mode. If Telegram
   will not keep an admin with no rights, keep the least harmful one. Do not turn
   on "remain anonymous" for yourself there.
3. Send one message in the group.
4. Read the group's chat id from the newest `[INBOX?]` line marked
   `sender allowlisted: yes` (a group upgraded to a supergroup gets a new id,
   logged as `moved to chat <id>`; the newest id is the one):
   ```bash
   TZ=Asia/Jerusalem journalctl -u telegram-agent --since today --no-pager | grep -F '[INBOX?]' | grep -F 'allowlisted: yes' | tail -3
   ```
5. Set it (this replaces any earlier value) and restart only the service (not
   `deploy.sh`, which would also bring in whatever `main` holds by then):
   ```bash
   cd ~/claude-bot
   sed -i '/^INBOX_CHAT_ID=/d' ~/.claude/channels/telegram/.env && printf '\nINBOX_CHAT_ID=%s\n' '<the id>' >> ~/.claude/channels/telegram/.env
   t=$(TZ=Asia/Jerusalem date '+%F %T')
   before=$(systemctl show telegram-agent -p ActiveEnterTimestampMonotonic --value)
   sudo systemctl restart telegram-agent
   sleep 5
   after=$(systemctl show telegram-agent -p ActiveEnterTimestampMonotonic --value)
   [ "$before" != "$after" ] && echo "restarted"
   systemctl is-active telegram-agent   # expect: active
   TZ=Asia/Jerusalem journalctl -u telegram-agent --since "$t" --no-pager | grep -F '[INBOX]'
   # expect: [INBOX] on for chat <the id>
   ```
   The poller prints that line only after its memory import and a call to
   Telegram, a few seconds after the restart; if it is not there yet, run the
   `journalctl` line again. `date` and `journalctl` both run with
   `TZ=Asia/Jerusalem`, so `--since` reads the time in the zone it was taken in.
6. Send a message in the group: it gets 👍, and `inbox.ts status` shows `"waiting":1`.
   (An album shows one 👍, on its first picture: Telegram puts every reaction on
   an album there.)
   No 👍: remove the bot from the group and add it back from the group's admin
   screen as an admin (whether promoting an existing member behaves the same is
   not documented by Telegram).

If the journal later says `[INBOX] the inbox group moved to chat <id>` (or, after
a restart, `following the moved group <id>`), set the new value with step 5.

To turn the inbox off: remove `INBOX_CHAT_ID` from the `.env` and restart. The
poller then answers nothing in the group and sends nothing there, but still
deletes what is left (warned items after their week, everything after ten days);
`cd ~/claude-bot && ~/.bun/bin/bun run inbox.ts purge` runs the same deletions
by hand.

The PC's half (the pull and the walk-through) lives outside this repo.

---

## Updating the bot later (local → server)

```powershell
# (local) after editing code or CLAUDE.md
git add . ; git commit -m "update bot" ; git push
```

```bash
# (server)
cd ~/claude-bot && git fetch origin && git reset --hard origin/main
sudo systemctl restart telegram-agent
sudo journalctl -u telegram-agent -n 5 --no-pager   # confirm the banner
```

When the update changed `ccjournal.ts` or `scripts/cc-journal-push.*`, also
rebuild the PC's deployed copy (step 14, local 1) after the server is updated.

When it changed `rchannel-schema.ts` or `scripts/rchannel-*`, rebuild the routine
channel's copy the same way (step 15, local 1).

---

## Adding integrations later (optional)

You launched with none. To add Google Workspace, Todoist, or Tavily:

```bash
# (server, as claudebot) examples:
claude mcp add -s user todoist --env TODOIST_API_TOKEN=<token> -- npx -y @doist/todoist-ai
claude mcp add -s user tavily  --env TAVILY_API_KEY=<key>     -- npx -y @tavily/mcp-server
claude mcp list   # verify "✓ Connected"
```

Then document the new tool in `CLAUDE.md` (under "Permissions granted" / a new
"Available tools" section) so the bot knows to use it, and restart.

---

## Troubleshooting

- **409 conflict on getUpdates** — another process polls the same token. Make
  sure the token exists only on this server and only one `start.sh`/`bun` runs.
  Reset webhooks if needed:
  ```bash
  TOKEN=<YOUR_TOKEN>
  curl "https://api.telegram.org/bot$TOKEN/deleteWebhook"
  ```
- **Bot receives a message but never replies** — confirm your ID is in
  `access.json` `allowFrom`; check `poller.log`; test `echo hi | claude -p
  --dangerously-skip-permissions` in `~/claude-bot`.
- **`start.sh: /bin/bash^M: bad interpreter`** — the file got CRLF endings. This
  repo's `.gitattributes` forces LF, so re-clone or run `sed -i 's/\r$//'
  start.sh`.
- **Bot stops after reboot** — `systemctl status telegram-agent` and
  `sudo journalctl -u telegram-agent -n 50`; the unit must be `enabled`.
