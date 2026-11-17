# Builds the site, serves it on localhost and publishes it through the vida-3d Cloudflare Tunnel.
# Usage: .\scripts\start.ps1          (add -Rebuild to force a fresh production build)
param([switch]$Rebuild)

. (Join-Path $PSScriptRoot 'tunnel-common.ps1')

function Fail($msg) {
    Write-Host ''
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Write-Host "Logs: $RunDir" -ForegroundColor Yellow
    exit 1
}

function Invoke-Cf([string[]]$cfArgs) {
    # cloudflared logs to stderr; in PS 5.1 that must not count as a terminating error.
    $ErrorActionPreference = 'Continue'
    $out = & $cf @cfArgs 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out -join "`n") }
}

New-Item -ItemType Directory -Force $RunDir | Out-Null
Set-Location $ProjectRoot

# ---------------------------------------------------------------- prerequisites
$cf = Get-Cloudflared
if (-not $cf) {
    Fail "cloudflared is not installed. Install it with:  winget install --id Cloudflare.cloudflared"
}
if (-not (Test-Path $CfCert)) {
    Fail "Cloudflare login missing ($CfCert). Run:  cloudflared tunnel login  and authorize softsuaveai.space."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed.' }

$state = Read-State
$app = $null; $tun = $null
if ($state) {
    $app = Get-OwnedProcess $state.appPid $state.appStart $AppMarker
    $tun = Get-OwnedProcess $state.tunnelPid $state.tunnelStart $TunnelMarker
}

# ---------------------------------------------------------------- tunnel + DNS (idempotent)
$ErrorActionPreference = 'Continue'
$listJson = (& $cf tunnel list --output json --name $TunnelName 2>$null) -join "`n"
$listCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($listCode -ne 0) { Fail 'Could not list tunnels (authentication problem? re-run: cloudflared tunnel login).' }
# Live tunnels report deleted_at as 0001-01-01T00:00:00Z.
$found = @(($listJson | ConvertFrom-Json) | Where-Object {
    $_.name -eq $TunnelName -and (-not $_.deleted_at -or "$($_.deleted_at)" -like '0001-01-01*')
})
if ($found.Count -gt 0) {
    $tunnelId = $found[0].id
} else {
    Write-Host "Creating Cloudflare Tunnel '$TunnelName'..."
    $create = Invoke-Cf @('tunnel', 'create', $TunnelName)
    if ($create.Code -ne 0) { Fail "Tunnel creation failed:`n$($create.Text)" }
    if ($create.Text -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') { $tunnelId = $Matches[1] }
    else { Fail "Could not read the new tunnel id:`n$($create.Text)" }
}
$credFile = Join-Path $CfDir "$tunnelId.json"
if (-not (Test-Path $credFile)) {
    Fail "Tunnel credentials file missing: $credFile. It was created on another machine; copy it here or delete and recreate the tunnel."
}

$yaml = @"
# Managed by scripts/start.ps1 for $AppName. Only this tunnel uses this file.
tunnel: $tunnelId
credentials-file: $credFile
metrics: 127.0.0.1:$MetricsPort
no-autoupdate: true
ingress:
  - hostname: $PublicHost
    service: http://127.0.0.1:$AppPort
    originRequest:
      httpHostHeader: localhost
  - service: http_status:404
"@
$existing = if (Test-Path $CfConfig) { Get-Content $CfConfig -Raw } else { '' }
if ($existing.Trim() -ne $yaml.Trim()) { Set-Content -Path $CfConfig -Value $yaml -Encoding ASCII }

$route = Invoke-Cf @('tunnel', 'route', 'dns', $tunnelId, $PublicHost)
if ($route.Code -ne 0) {
    Fail "DNS route for $PublicHost failed (an existing record may point elsewhere; it was NOT overwritten):`n$($route.Text)"
}

# ---------------------------------------------------------------- application
if ($app) {
    Write-Host "Application already running (PID $($app.Id))."
} else {
    $busy = Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($busy) { Fail "Port $AppPort is already used by another process (PID $($busy.OwningProcess))." }

    if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
        Write-Host 'Installing dependencies (npm install)...'
        & npm install *> (Join-Path $RunDir 'npm-install.log')
        if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. See .run\npm-install.log' }
    }

    $distIndex = Join-Path $ProjectRoot 'dist\index.html'
    $needBuild = $Rebuild -or -not (Test-Path $distIndex)
    if (-not $needBuild) {
        $built = (Get-Item $distIndex).LastWriteTime
        $newer = Get-ChildItem (Join-Path $ProjectRoot 'src'), (Join-Path $ProjectRoot 'public'), (Join-Path $ProjectRoot 'index.html') -Recurse -File |
            Where-Object { $_.LastWriteTime -gt $built } | Select-Object -First 1
        $needBuild = [bool]$newer
    }
    if ($needBuild) {
        Write-Host 'Building production bundle (npm run build)...'
        & npm run build *> (Join-Path $RunDir 'build.log')
        if ($LASTEXITCODE -ne 0) { Fail 'Build failed. See .run\build.log' }
    }

    Write-Host "Starting application on $LocalUrl ..."
    $proc = Start-Process -FilePath (Get-Command node).Source `
        -ArgumentList @("`"$ViteJs`"", 'preview', '--host', '127.0.0.1', '--port', $AppPort, '--strictPort') `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $RunDir 'app.log') -RedirectStandardError (Join-Path $RunDir 'app.err.log')
    $app = Get-Process -Id $proc.Id
    if (-not (Wait-Until { (Test-Http "http://127.0.0.1:$AppPort/" 3) -eq 200 } 40)) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Fail 'Application did not become healthy (GET / on port 4173). See .run\app.log and .run\app.err.log'
    }
}

# ---------------------------------------------------------------- tunnel process
if ($tun) {
    Write-Host "Tunnel already running (PID $($tun.Id))."
} else {
    $metricsBusy = Get-NetTCPConnection -LocalPort $MetricsPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($metricsBusy) { Fail "Tunnel metrics port $MetricsPort is used by another process (PID $($metricsBusy.OwningProcess))." }
    Write-Host "Starting Cloudflare Tunnel '$TunnelName'..."
    $proc = Start-Process -FilePath $cf `
        -ArgumentList @('tunnel', '--config', "`"$CfConfig`"", '--logfile', "`"$(Join-Path $RunDir 'tunnel.log')`"", 'run', $TunnelName) `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $RunDir 'tunnel.out.log') -RedirectStandardError (Join-Path $RunDir 'tunnel.err.log')
    $tun = Get-Process -Id $proc.Id
}

Write-State ([pscustomobject]@{
    appName     = $AppName
    appPid      = $app.Id
    appStart    = $app.StartTime.ToString('o')
    tunnelPid   = $tun.Id
    tunnelStart = $tun.StartTime.ToString('o')
    tunnelName  = $TunnelName
    tunnelId    = $tunnelId
    config      = $CfConfig
    localUrl    = $LocalUrl
    publicUrl   = $PublicUrl
    startedAt   = (Get-Date).ToString('o')
})

# ---------------------------------------------------------------- health checks
$connected = Wait-Until { (Test-Http "http://127.0.0.1:$MetricsPort/ready" 3) -eq 200 } 45 2
if (-not $connected) {
    if (-not (Get-Process -Id $tun.Id -ErrorAction SilentlyContinue)) { Fail 'Tunnel process exited. See .run\tunnel.log' }
    Fail 'Tunnel did not connect to Cloudflare within 45s. See .run\tunnel.log'
}

$dnsOk = Wait-Until { [bool](Resolve-DnsName $PublicHost -Server 1.1.1.1 -ErrorAction SilentlyContinue) } 30 3
$publicCode = 0
if ($dnsOk) {
    Wait-Until { $script:publicCode = Test-Http $PublicUrl 10; $script:publicCode -eq 200 } 60 3 | Out-Null
}

Write-Host ''
Write-Host 'Application: Running' -ForegroundColor Green
Write-Host "Local URL:   $LocalUrl"
Write-Host "Public URL:  $PublicUrl"
Write-Host 'Tunnel:      Connected' -ForegroundColor Green
if (-not $dnsOk) {
    Write-Host "DNS:         $PublicHost does not resolve yet (new records can take a few minutes)." -ForegroundColor Yellow
} elseif ($publicCode -ne 200) {
    Write-Host "Public check: HTTP $publicCode from $PublicUrl (may still be propagating; see .run\tunnel.log)." -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Start command: .\scripts\start.ps1'
Write-Host 'Stop command:  .\scripts\stop.ps1'
