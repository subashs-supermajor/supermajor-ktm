# Stops only the application and tunnel processes started by scripts/start.ps1.
# The tunnel, its DNS record and its config file are left in place.

. (Join-Path $PSScriptRoot 'tunnel-common.ps1')

$state = Read-State
if (-not $state) {
    Write-Host "$AppName is already stopped." -ForegroundColor Green
    exit 0
}

$targets = @(
    @{ Label = 'Tunnel';      Pid = $state.tunnelPid; Start = $state.tunnelStart; Marker = $TunnelMarker },
    @{ Label = 'Application'; Pid = $state.appPid;    Start = $state.appStart;    Marker = $AppMarker }
)

$stoppedAny = $false
foreach ($t in $targets) {
    $p = Get-OwnedProcess $t.Pid $t.Start $t.Marker
    if ($p) {
        Stop-Process -Id $p.Id -Force
        Wait-Until { -not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) } 10 | Out-Null
        Write-Host "$($t.Label): stopped (PID $($p.Id))"
        $stoppedAny = $true
    } else {
        Write-Host "$($t.Label): not running"
    }
}

Remove-Item $StateFile -Force -ErrorAction SilentlyContinue

if ($stoppedAny) {
    Write-Host "$AppName stopped. Tunnel '$TunnelName' and DNS for $PublicHost are kept for next start." -ForegroundColor Green
} else {
    Write-Host "$AppName was already stopped. Cleaned up stale process information." -ForegroundColor Green
}
