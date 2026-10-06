param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$assistantRoot = $PSScriptRoot
$runtimeBase = if ((Split-Path (Split-Path $assistantRoot -Parent) -Leaf) -eq 'outputs') { Join-Path $assistantRoot '..\..' } else { $assistantRoot }
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $runtimeBase 'work\youtube-zh-assistant'))
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
# Desktop apps keep the environment inherited at their own launch time.
# Reuse existing user proxy settings without changing Windows or Clash settings.
foreach ($proxyVariableName in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')) {
    $currentProxyValue = [Environment]::GetEnvironmentVariable($proxyVariableName, 'Process')
    if ([string]::IsNullOrWhiteSpace($currentProxyValue)) {
        $userProxyValue = [Environment]::GetEnvironmentVariable($proxyVariableName, 'User')
        if (-not [string]::IsNullOrWhiteSpace($userProxyValue)) {
            [Environment]::SetEnvironmentVariable($proxyVariableName, $userProxyValue, 'Process')
        }
    }
}
$bypassProxyValue = [Environment]::GetEnvironmentVariable('NO_PROXY', 'Process')
$proxyBypassEntries = @($bypassProxyValue -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($loopbackHost in @('127.0.0.1','localhost','::1')) {
    if ($proxyBypassEntries -notcontains $loopbackHost) { $proxyBypassEntries += $loopbackHost }
}
$env:NO_PROXY = $proxyBypassEntries -join ','
# Supported Node releases can apply these same existing proxies to fetch/API requests.
$nodeHelp = & $nodeExecutable --help
if ($nodeHelp -match '--use-env-proxy') { $env:NODE_USE_ENV_PROXY = '1' }
$env:YTZH_RUNTIME_DIR = $runtimeRoot
[IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
$running = $false
try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:17865/health' -TimeoutSec 3; $running = $response.ok -eq $true } catch {}
if (-not $running) {
    $serviceScript = Join-Path $assistantRoot 'server\main.mjs'
    $stdoutFile = Join-Path $runtimeRoot 'server.stdout.log'
    $stderrFile = Join-Path $runtimeRoot 'server.stderr.log'
    Start-Process -FilePath $nodeExecutable -ArgumentList ('"' + $serviceScript + '"') -WorkingDirectory $assistantRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile | Out-Null
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        Start-Sleep -Milliseconds 200
        try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:17865/health' -TimeoutSec 2; if ($response.ok) { $running = $true; break } } catch {}
    }
}
if (-not $running) { throw '服务未启动，请查看 work\youtube-zh-assistant\server.stderr.log。' }
$pairingFile = Join-Path $runtimeRoot 'pairing-token.txt'
if (-not (Test-Path -LiteralPath $pairingFile)) { throw '此端口运行的服务不属于当前助手，请先停止该服务。' }
$pairingCode = [IO.File]::ReadAllText($pairingFile).Trim()
$expectedVersion = (Get-Content -LiteralPath (Join-Path $assistantRoot 'package.json') -Raw | ConvertFrom-Json).version
try {
    $pairingState = Invoke-RestMethod -Uri 'http://127.0.0.1:17865/pairing' -Headers @{ Authorization = 'Bearer ' + $pairingCode } -TimeoutSec 3
} catch { throw '当前服务与此安装目录的配对码不匹配。请先执行旧目录的 stop.ps1，再启动当前目录。' }
if ($pairingState.ok -ne $true -or $pairingState.service -ne 'youtube-zh-assistant' -or $pairingState.version -ne $expectedVersion) {
    throw ('当前服务版本与安装包 ' + $expectedVersion + ' 不匹配。请先执行旧目录的 stop.ps1，再启动当前目录。')
}
if (-not $NoBrowser) { Start-Process -FilePath ('http://127.0.0.1:17865/#token=' + $pairingCode) }
Write-Output 'YouTube 中文字幕助手已启动。本机设置页：http://127.0.0.1:17865'
Write-Output '加载插件后，在本机设置页点击“一键配对浏览器插件”，再刷新 YouTube。'
