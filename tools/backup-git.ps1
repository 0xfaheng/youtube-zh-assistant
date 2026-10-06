param([string]$Destination)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($Destination)) {
    $Destination = Join-Path $env:USERPROFILE '.codex\project-backups\youtube-zh-assistant'
}
$backupDirectory = [IO.Path]::GetFullPath($Destination)
if ($backupDirectory -eq $repoRoot -or $backupDirectory.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '备份必须保存到主仓库之外。' }
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
$stamp = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyyMMdd-HHmmss-fff')
$bundle = Join-Path $backupDirectory ("youtube-zh-assistant-$stamp.bundle")
if (Test-Path -LiteralPath $bundle) { throw '备份文件已经存在，不覆盖旧备份。' }
& git -C $repoRoot bundle create $bundle --all
if ($LASTEXITCODE -ne 0) { throw '创建 Git bundle 失败。' }
& git -C $repoRoot bundle verify $bundle
if ($LASTEXITCODE -ne 0) { throw 'Git bundle 校验失败。' }
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
$hashStream = [IO.File]::OpenRead($bundle)
try { $sha256 = [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
finally { $hashStream.Dispose(); $hashAlgorithm.Dispose() }
$commit = & git -C $repoRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw '读取备份提交失败。' }
$report = [ordered]@{
    createdAt = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('o')
    bundle = $bundle
    sha256 = $sha256
    head = [string]$commit
    scope = '所有已提交分支与标签；不包含未提交修改、安装包、运行配置、配对码、密钥与缓存'
}
$json = $report | ConvertTo-Json
[IO.File]::WriteAllText($bundle + '.json', $json, [Text.UTF8Encoding]::new($false))
$json
