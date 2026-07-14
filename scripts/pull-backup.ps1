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
    [int]$Keep = 14
)
$ErrorActionPreference = "Stop"

if ($RemoteUserHost -like "*<YOUR_SERVER_IP>*") {
    throw "no target configured: pass -RemoteUserHost user@ip or set AGENT_BACKUP_SSH"
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# Clear any partial download a previous interrupted run left behind.
Get-ChildItem $Dest -Filter '*.part' -ErrorAction SilentlyContinue | Remove-Item -Force

# Resolve the newest archive's real name (latest.tar.gz is a symlink to it).
# Keepalives matter: ConnectTimeout only covers the connect phase, and a session
# that goes dead after that (e.g. the task firing while the network is still
# coming up after wake-from-sleep) would otherwise hang forever.
$name = ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -i $KeyPath $RemoteUserHost 'basename "$(readlink -f ~/backups/latest.tar.gz)"'
if ($LASTEXITCODE -ne 0) { throw "ssh to $RemoteUserHost failed" }
$name = "$name".Trim()
if ($name -notmatch '^agent-backup-\d{8}-\d{6}\.tar\.gz$') {
    throw "could not resolve remote latest archive (got: '$name')"
}

$target = Join-Path $Dest $name
if (Test-Path $target) {
    Write-Output "already have $name"
} else {
    # Download to a .part name first so an interrupted transfer is never
    # mistaken for a complete archive on the next run.
    $part = "$target.part"
    scp -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -i $KeyPath "${RemoteUserHost}:backups/$name" $part
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -Force $part -ErrorAction SilentlyContinue
        throw "scp failed for $name"
    }
    Move-Item -Force $part $target
    Write-Output "pulled $name ($([math]::Round((Get-Item $target).Length / 1KB)) KB)"
}

# Local rotation: keep the newest $Keep by name (names embed the timestamp).
Get-ChildItem $Dest -Filter 'agent-backup-*.tar.gz' |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep |
    Remove-Item -Force

$count = (Get-ChildItem $Dest -Filter 'agent-backup-*.tar.gz').Count
Write-Output "$count archive(s) in $Dest"
