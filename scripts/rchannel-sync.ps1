# rchannel-sync.ps1: launcher for the routine channel's PC side (DEPLOY.md step 15). The scheduled
# task "TelegramAgent routine channel" starts it through a headless console host with the argument
# "sync"; every argument goes to rchannel-pc.ts unchanged, and its exit code is passed back. When bun
# cannot start, the launcher logs that itself and exits 3, so a dead run is never silent.
$ErrorActionPreference = 'Stop'
try {
    $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
    if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
    & $bun (Join-Path $PSScriptRoot 'rchannel-pc.ts') @args
    exit $LASTEXITCODE
} catch {
    $channel = if ($env:RCHANNEL_HOME) { $env:RCHANNEL_HOME } else { Join-Path $env:USERPROFILE '.claude\tools\routine-channel' }
    $log = Join-Path $channel 'sync.log'
    try {
        New-Item -ItemType Directory -Force $channel | Out-Null
        $why = $_.Exception.Message -replace '\s+', ' '
        Add-Content -Path $log -Encoding utf8 -Value ('{0}  FAILED: the launcher could not start bun: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $why)
    } catch { }
    exit 3
}
