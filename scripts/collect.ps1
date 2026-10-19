# omem 定时采集：跑一次 omem run（幂等，未变化的会话会被跳过）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File collect.ps1 [-Since 7d] [-DryRun]
# 它只是 omem run 的薄封装——真正的幂等性由 omem 的 content-hash 对账保证，脚本不做任何判断。
param(
    [string]$Since = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$omem = Get-Command omem -ErrorAction SilentlyContinue
if (-not $omem) {
    Write-Error 'omem not found on PATH. Install it first: npm install -g @jeeinn/omem@beta'
    exit 2
}

$runArgs = @('run')
if ($Since) { $runArgs += @('--since', $Since) }
if ($DryRun) { $runArgs += '--dry-run' }

$stamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
Write-Output "[$stamp] omem $($runArgs -join ' ')"

& $omem.Source @runArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Error "omem run failed with exit code $code"
    exit $code
}
