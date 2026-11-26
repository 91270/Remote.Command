# PowerShell 5.1 and newer.
$ErrorActionPreference = 'Stop'
if (-not $env:NODE_USE_ENV_PROXY) { $env:NODE_USE_ENV_PROXY = '1' }
$ScriptPath = Join-Path $PSScriptRoot 'dev-local.mjs'
& node $ScriptPath @args
exit $LASTEXITCODE
