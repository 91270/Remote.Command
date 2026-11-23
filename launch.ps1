# PowerShell 5.1 and newer.
$ErrorActionPreference = 'Stop'
if ($args.Count -gt 0 -and $args[0] -in '-h','--help') {
    Write-Output 'Usage: .\launch.ps1 [CONFIG] [--logout|--report] [--no-upload] [--no-browser] [--no-persist-session] [--disable-no-sleep] [--debug]'
    exit 0
}
$PrmAgentArguments = @($args)
$PrmNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$PrmNode = if ($PrmNodeCommand) { $PrmNodeCommand.Source } else { $null }
$PrmNodeUsable = $false
if ($PrmNode) {
    & $PrmNode -e 'const v=parseInt(process.versions.node,10); process.exit(v>=24 && v<27 ? 0 : 1)'
    $PrmNodeUsable = $LASTEXITCODE -eq 0
}
if (!$PrmNodeUsable) {
    $PrmMachine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $PrmArchitecture = switch ($PrmMachine) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { throw 'Install Node.js 24 LTS for this architecture.' }
    }
    $PrmRuntimeBase = Join-Path $PSScriptRoot 'state\node-runtime'
    $PrmRuntime = Join-Path $PrmRuntimeBase "win-$PrmArchitecture"
    $PrmNode = Join-Path $PrmRuntime 'node.exe'
    if (!(Test-Path -LiteralPath $PrmNode -PathType Leaf)) {
        $PrmAnswer = Read-Host 'Install Node.js 24 in this project only? [y/N]'
        if ($PrmAnswer -notmatch '^(y|yes)$') { exit 1 }
        $PrmDownload = Join-Path $PrmRuntimeBase ('.download-' + [guid]::NewGuid())
        New-Item -Path $PrmDownload -ItemType Directory -Force | Out-Null
        try {
            $PrmBase = 'https://nodejs.org/dist/latest-v24.x'
            $PrmSums = Join-Path $PrmDownload 'SHASUMS256.txt'
            Invoke-WebRequest -UseBasicParsing -Uri "$PrmBase/SHASUMS256.txt" -OutFile $PrmSums
            $PrmPattern = '^(?<hash>[a-f0-9]{64})\s+(?<file>node-v24\.\d+\.\d+-win-' + $PrmArchitecture + '\.zip)$'
            $PrmMatch = Select-String -LiteralPath $PrmSums -Pattern $PrmPattern | Select-Object -First 1
            if (!$PrmMatch) { throw 'No compatible Node.js release found.' }
            $PrmArchiveName = $PrmMatch.Matches[0].Groups['file'].Value
            $PrmArchive = Join-Path $PrmDownload $PrmArchiveName
            Invoke-WebRequest -UseBasicParsing -Uri "$PrmBase/$PrmArchiveName" -OutFile $PrmArchive
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $PrmArchive).Hash -ne $PrmMatch.Matches[0].Groups['hash'].Value) {
                throw 'Node.js checksum did not match.'
            }
            Expand-Archive -LiteralPath $PrmArchive -DestinationPath $PrmDownload
            $PrmExtracted = Join-Path $PrmDownload ([IO.Path]::GetFileNameWithoutExtension($PrmArchiveName))
            if (!(Test-Path -LiteralPath $PrmNode -PathType Leaf)) { Move-Item -LiteralPath $PrmExtracted -Destination $PrmRuntime }
        } finally {
            Remove-Item -LiteralPath $PrmDownload -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
& $PrmNode (Join-Path $PSScriptRoot 'scripts\launch.mjs') @PrmAgentArguments
exit $LASTEXITCODE
