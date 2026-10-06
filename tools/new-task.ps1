param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9-]{1,59}$')]
    [string]$Name,
    [ValidateSet('feat', 'fix', 'chore', 'docs')]
    [string]$Type = 'feat',
    [string]$WorktreeRoot
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
function Invoke-TaskGit {
    param([string[]]$GitArguments)
    $result = & git -C $repoRoot @GitArguments
    if ($LASTEXITCODE -ne 0) { throw ('Git 命令失败：' + ($GitArguments -join ' ')) }
    return $result
}
$top = [string](Invoke-TaskGit @('rev-parse', '--show-toplevel'))
if ([IO.Path]::GetFullPath($top) -ne $repoRoot) { throw '工具必须位于项目仓库的 tools 目录。' }
if ([string](Invoke-TaskGit @('branch', '--show-current')) -ne 'main') { throw '请从 main 主工作目录创建任务。' }
if (Invoke-TaskGit @('status', '--porcelain=v1', '--untracked-files=all')) { throw '主工作目录有未提交内容，请先保存并提交；工具不会自动丢弃或隐藏修改。' }
$branch = "$Type/$Name"
Invoke-TaskGit @('check-ref-format', '--branch', $branch) | Out-Null
if (Invoke-TaskGit @('branch', '--list', $branch)) { throw "分支 $branch 已存在；继续原任务时使用原工作目录。" }
if ([string]::IsNullOrWhiteSpace($WorktreeRoot)) { $WorktreeRoot = $repoRoot + '-worktrees' }
$worktreeBase = [IO.Path]::GetFullPath($WorktreeRoot)
if ($worktreeBase -eq $repoRoot -or $worktreeBase.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '任务工作目录必须放在主仓库之外。' }
$taskDirectory = [IO.Path]::GetFullPath((Join-Path $worktreeBase $Name))
if (-not $taskDirectory.StartsWith($worktreeBase + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '任务路径越界。' }
if (Test-Path -LiteralPath $taskDirectory) { throw "工作目录已存在：$taskDirectory" }
[IO.Directory]::CreateDirectory($worktreeBase) | Out-Null
Invoke-TaskGit @('worktree', 'add', '-b', $branch, $taskDirectory, 'main') | Out-Null
$commit = [string](Invoke-TaskGit @('rev-parse', 'main'))
[pscustomobject]@{
    branch = $branch
    workspace = $taskDirectory
    baseCommit = $commit
    instruction = '新聊天必须使用此工作目录；任务中只修改并提交本任务文件，交给主聊天统一合并。真实服务、GPU集成测试与打包暂时串行执行。'
} | ConvertTo-Json
