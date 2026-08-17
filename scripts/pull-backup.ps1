# pull-backup.ps1: nightly off-box copy of the agent's state backup (roadmap 0.1).
# Pulls the newest archive from the droplet into a local folder (OneDrive by
# default, which adds a free cloud copy) and keeps the newest $Keep archives.
# Registered as a Windows scheduled task; see DEPLOY.md "Backups".
# Pass -RemoteUserHost/-KeyPath explicitly (or set AGENT_BACKUP_SSH), the
# committed defaults are placeholders.
param(
    [string]$RemoteUserHost = $(if ($env:AGENT_BACKUP_SSH) { $env:AGENT_BACKUP_SSH } else { "claudebot@<YOUR_SERVER_IP>" }),
    [string]$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519",
    [string]$Dest = "$env:USERPROFILE\OneDrive\Backups\telegram-agent",
    [int]$Keep = 14,
    # Retry budget for the network half. Small on purpose: the scheduled task is capped at
    # PT5M, and 3 attempts of a ~30s abort plus a 30s wait stays comfortably inside that.
    [int]$Attempts = 3,
    [int]$RetryDelaySeconds = 30
)
$ErrorActionPreference = "Stop"

if ($RemoteUserHost -like "*<YOUR_SERVER_IP>*") {
    throw "no target configured: pass -RemoteUserHost user@ip or set AGENT_BACKUP_SSH"
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# One timestamped line per outcome, next to the archives. Added after the 2026-08-10 failure
# that exited 1 and left nothing to read: the Task Scheduler operational channel is off and
# this script wrote nothing, so the cause had to be reconstructed by hand the next day.
# Logging never throws; a diagnostic that can fail the run it documents is worse than none.
$logPath = Join-Path $Dest 'pull-backup.log'
function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Output $line
    try { Add-Content -Path $logPath -Value $line -Encoding utf8 -ErrorAction Stop } catch { }
}

# Clear any partial download a previous interrupted run left behind.
Get-ChildItem $Dest -Filter '*.part' -ErrorAction SilentlyContinue | Remove-Item -Force

# The network half runs under retry; local work (rotation) stays outside it because it cannot
# fail transiently. The failure this exists for is the task firing while the network is still
# coming up after wake: the keepalives below already bound that to ~30s instead of hanging
# forever, but a single attempt still cost a whole day's off-box copy on 2026-08-10.
$outcome = $null
$lastErr = $null
for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
        # Resolve the newest archive's real name (latest.tar.gz is a symlink to it).
        # Keepalives matter: ConnectTimeout only covers the connect phase, and a session
        # that goes dead after that would otherwise hang forever.
        $name = ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -i $KeyPath $RemoteUserHost 'basename "$(readlink -f ~/backups/latest.tar.gz)"'
        if ($LASTEXITCODE -ne 0) { throw "ssh to $RemoteUserHost failed (exit $LASTEXITCODE)" }
        $name = "$name".Trim()
        if ($name -notmatch '^agent-backup-\d{8}-\d{6}\.tar\.gz$') {
            throw "could not resolve remote latest archive (got: '$name')"
        }

        $target = Join-Path $Dest $name
        if (Test-Path $target) {
            $outcome = "already have $name"
        } else {
            # Download to a .part name first so an interrupted transfer is never
            # mistaken for a complete archive on the next run.
            $part = "$target.part"
            scp -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -i $KeyPath "${RemoteUserHost}:backups/$name" $part
            if ($LASTEXITCODE -ne 0) {
                Remove-Item -Force $part -ErrorAction SilentlyContinue
                throw "scp failed for $name (exit $LASTEXITCODE)"
            }
            Move-Item -Force $part $target
            $outcome = "pulled $name ($([math]::Round((Get-Item $target).Length / 1KB)) KB)"
        }
        if ($attempt -gt 1) { $outcome = "$outcome (on attempt $attempt)" }
        break
    } catch {
        $lastErr = $_.Exception.Message
        if ($attempt -lt $Attempts) {
            Write-Log "attempt $attempt of $Attempts failed: $lastErr - retrying in ${RetryDelaySeconds}s"
            Start-Sleep -Seconds $RetryDelaySeconds
        }
    }
}

# $outcome stays $null only if every attempt threw. Testing for that rather than for a
# truthy value on purpose: "already have <name>" is a success and is also a non-empty string.
if ($null -eq $outcome) {
    Write-Log "FAILED after $Attempts attempt(s): $lastErr"
    throw $lastErr
}
Write-Log $outcome

# Local rotation: keep the newest $Keep by name (names embed the timestamp).
Get-ChildItem $Dest -Filter 'agent-backup-*.tar.gz' |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep |
    Remove-Item -Force

$count = (Get-ChildItem $Dest -Filter 'agent-backup-*.tar.gz').Count
Write-Log "$count archive(s) in $Dest"

# Keep the log a bounded tail rather than a growing archive. Wrapped so a locked or unreadable
# log can never fail a run whose real work already succeeded.
try {
    $logLines = @(Get-Content $logPath -ErrorAction Stop)
    if ($logLines.Count -gt 200) {
        Set-Content -Path $logPath -Value ($logLines | Select-Object -Last 200) -Encoding utf8
    }
} catch { }
