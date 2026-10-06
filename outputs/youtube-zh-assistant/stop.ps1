$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$assistantRoot = $PSScriptRoot
$runtimeBase = if ((Split-Path (Split-Path $assistantRoot -Parent) -Leaf) -eq 'outputs') { Join-Path $assistantRoot '..\..' } else { $assistantRoot }
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $runtimeBase 'work\youtube-zh-assistant'))
$pidFile = Join-Path $runtimeRoot 'server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $servicePid = [int][IO.File]::ReadAllText($pidFile)
    $serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid" -ErrorAction SilentlyContinue
    $expectedScript = [IO.Path]::GetFullPath((Join-Path $assistantRoot 'server\main.mjs'))
    if ($serviceProcess -and $serviceProcess.Name -eq 'node.exe' -and $serviceProcess.CommandLine.Contains($expectedScript)) {
        try {
            $pairingFile = Join-Path $runtimeRoot 'pairing-token.txt'
            $pairingCode = [IO.File]::ReadAllText($pairingFile).Trim()
            Invoke-RestMethod -Uri 'http://127.0.0.1:17865/local-asr/stop' -Method Post -ContentType 'application/json' -Headers @{ Authorization = 'Bearer ' + $pairingCode } -Body '{}' -TimeoutSec 15 | Out-Null
        } catch {}
        Stop-Process -Id $servicePid
        Write-Output '字幕助手服务已停止。'
    } else { Write-Output '记录的进程不属于此助手，没有停止其他程序。' }
} else { Write-Output '未找到运行中的助手进程。' }
