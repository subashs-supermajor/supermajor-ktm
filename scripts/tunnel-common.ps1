# Shared settings and helpers for start.ps1 / stop.ps1. Windows PowerShell 5.1 compatible.

$ErrorActionPreference = 'Stop'

$AppName      = 'vida-3d'
$TunnelName   = 'vida-3d'
$PublicHost   = 'vida-3d.softsuaveai.space'
$AppPort      = 4173
$MetricsPort  = 41730
$ProjectRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RunDir       = Join-Path $ProjectRoot '.run'
$StateFile    = Join-Path $RunDir 'state.json'
$CfDir        = Join-Path $env:USERPROFILE '.cloudflared'
$CfConfig     = Join-Path $CfDir "$TunnelName.yml"
$CfCert       = Join-Path $CfDir 'cert.pem'
$LocalUrl     = "http://localhost:$AppPort"
$ViteJs       = Join-Path $ProjectRoot 'node_modules\vite\bin\vite.js'
# Command-line fragments that prove a process was started by start.ps1 for this project.
$AppMarker    = $ViteJs
$TunnelMarker = $CfConfig
$PublicUrl    = "https://$PublicHost"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-Cloudflared {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @("$env:ProgramFiles\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Read-State {
    if (-not (Test-Path $StateFile)) { return $null }
    try { return Get-Content $StateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-State($state) {
    New-Item -ItemType Directory -Force $RunDir | Out-Null
    $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

# A PID only counts as ours if the process is alive, started at the recorded time,
# and its command line contains the marker we launched it with (guards against PID reuse).
function Get-OwnedProcess($procId, $startTime, $marker) {
    if (-not $procId) { return $null }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    try { if ($p.StartTime.ToString('o') -ne $startTime) { return $null } } catch { return $null }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    if (-not $cim -or -not $cim.CommandLine -or ($cim.CommandLine -notlike "*$marker*")) { return $null }
    return $p
}

function Test-Http($url, $timeoutSec = 5) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec -MaximumRedirection 0
        return [int]$r.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

function Wait-Until([scriptblock]$check, $timeoutSec, $intervalSec = 1) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $check) { return $true }
        Start-Sleep -Seconds $intervalSec
    }
    return $false
}
