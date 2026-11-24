# PowerShell 5.1 and newer.
$ErrorActionPreference = 'Stop'
if ($args.Count -gt 0 -and $args[0] -in '-h','--help') {
    Write-Output 'Usage: .\launch.ps1 [CONFIG] [--logout|--report] [--no-browser] [--no-persist-session] [--disable-no-sleep] [--debug]'
    exit 0
}
$RcmAgentArguments = @($args)
$RcmNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$RcmNode = if ($RcmNodeCommand) { $RcmNodeCommand.Source } else { $null }
$RcmNodeUsable = $false
if ($RcmNode) {
    & $RcmNode -e 'const v=parseInt(process.versions.node,10); process.exit(v>=24 && v<27 ? 0 : 1)'
    $RcmNodeUsable = $LASTEXITCODE -eq 0
}
if (!$RcmNodeUsable) {
    $RcmMachine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $RcmArchitecture = switch ($RcmMachine) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { throw 'Install Node.js 24 LTS for this architecture.' }
    }
    $RcmRuntimeBase = Join-Path $PSScriptRoot 'state\node-runtime'
    $RcmRuntime = Join-Path $RcmRuntimeBase "win-$RcmArchitecture"
    $RcmNode = Join-Path $RcmRuntime 'node.exe'
    if (!(Test-Path -LiteralPath $RcmNode -PathType Leaf)) {
        $RcmAnswer = Read-Host 'Install Node.js 24 in this project only? [y/N]'
        if ($RcmAnswer -notmatch '^(y|yes)$') { exit 1 }
        $RcmDownload = Join-Path $RcmRuntimeBase ('.download-' + [guid]::NewGuid())
        New-Item -Path $RcmDownload -ItemType Directory -Force | Out-Null
        try {
            $RcmBase = 'https://nodejs.org/dist/latest-v24.x'
            $RcmSums = Join-Path $RcmDownload 'SHASUMS256.txt'
            Invoke-WebRequest -UseBasicParsing -Uri "$RcmBase/SHASUMS256.txt" -OutFile $RcmSums
            $RcmPattern = '^(?<hash>[a-f0-9]{64})\s+(?<file>node-v24\.\d+\.\d+-win-' + $RcmArchitecture + '\.zip)$'
            $RcmMatch = Select-String -LiteralPath $RcmSums -Pattern $RcmPattern | Select-Object -First 1
            if (!$RcmMatch) { throw 'No compatible Node.js release found.' }
            $RcmArchiveName = $RcmMatch.Matches[0].Groups['file'].Value
            $RcmArchive = Join-Path $RcmDownload $RcmArchiveName
            Invoke-WebRequest -UseBasicParsing -Uri "$RcmBase/$RcmArchiveName" -OutFile $RcmArchive
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $RcmArchive).Hash -ne $RcmMatch.Matches[0].Groups['hash'].Value) {
                throw 'Node.js checksum did not match.'
            }
            Expand-Archive -LiteralPath $RcmArchive -DestinationPath $RcmDownload
            $RcmExtracted = Join-Path $RcmDownload ([IO.Path]::GetFileNameWithoutExtension($RcmArchiveName))
            if (!(Test-Path -LiteralPath $RcmNode -PathType Leaf)) { Move-Item -LiteralPath $RcmExtracted -Destination $RcmRuntime }
        } finally {
            Remove-Item -LiteralPath $RcmDownload -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
& $RcmNode (Join-Path $PSScriptRoot 'scripts\launch.mjs') @RcmAgentArguments
exit $LASTEXITCODE
