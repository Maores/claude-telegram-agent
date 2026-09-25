# cc-journal-push.ps1: launcher for the hourly Claude Code journal push (DEPLOY.md step 14).
# It exists so the scheduled task can start pwsh with -WindowStyle Hidden; every argument goes
# to cc-journal-push.ts unchanged, and its exit code is passed back. When bun cannot start,
# the launcher logs that itself and exits 3, so the task never records a silent success.
$ErrorActionPreference = 'Stop'
try {
    $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
    if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
    & $bun (Join-Path $PSScriptRoot 'cc-journal-push.ts') @args
    exit $LASTEXITCODE
} catch {
    $log = Join-Path $env:LOCALAPPDATA 'TelegramAgent\cc-journal-push.log'
    try {
        New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
        $why = $_.Exception.Message -replace '\s+', ' '
        Add-Content -Path $log -Encoding utf8 -Value ('{0}  FAILED: the launcher could not start bun: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $why)
    } catch { }
    exit 3
}
