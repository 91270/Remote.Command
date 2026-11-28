import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectVersion } from './protocol.js';

const releaseRepo = '91270/Remote.Command';

function findBundledAgentTgz(): string | null {
  const filename = `remote-command-${projectVersion}.tgz`;
  const candidates = [
    new URL(`../assets/${filename}`, import.meta.url).pathname,
    new URL(`../releases/${filename}`, import.meta.url).pathname
  ].map(path => process.platform === 'win32' && /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function renderShellInstaller(origin: string, installService = false): string {
  const version = projectVersion;
  const defaultInstallService = installService ? '1' : '0';
  return `#!/usr/bin/env bash
set -euo pipefail

ORIGIN="${origin}"
VERSION="${version}"
BASE_DIR="\${HOME}/.remote-command"
CLIENT_DIR="\${BASE_DIR}/client-\${VERSION}"
NODE_DIR="\${BASE_DIR}/node"
NODE_VERSION="v24.11.1"

check_node() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1 || return 1
  local major
  major="$("$bin" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  [ "$major" -ge 24 ] && [ "$major" -lt 27 ]
}

NODE_BIN=""
if check_node node; then
  NODE_BIN="$(command -v node)"
elif [ -x "\${NODE_DIR}/bin/node" ] && check_node "\${NODE_DIR}/bin/node"; then
  NODE_BIN="\${NODE_DIR}/bin/node"
else
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) node_os="linux" ;;
    Darwin) node_os="darwin" ;;
    *) echo "Unsupported OS: $os" >&2; exit 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) node_arch="x64" ;;
    arm64|aarch64) node_arch="arm64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  pkg="node-\${NODE_VERSION}-\${node_os}-\${node_arch}.tar.gz"
  url="https://nodejs.org/dist/\${NODE_VERSION}/\${pkg}"
  echo "Downloading portable Node.js \${NODE_VERSION}..."
  mkdir -p "\${NODE_DIR}"
  tmp_tar="$(mktemp)"
  curl -fsSL "$url" -o "$tmp_tar"
  tar -xzf "$tmp_tar" -C "\${NODE_DIR}" --strip-components=1
  rm -f "$tmp_tar"
  NODE_BIN="\${NODE_DIR}/bin/node"
fi

export PATH="$(dirname "$NODE_BIN"):\${PATH}"

if [ ! -f "\${CLIENT_DIR}/dist/remote-cli.js" ]; then
  echo "Installing Remote.Command Agent v\${VERSION}..."
  mkdir -p "\${CLIENT_DIR}"
  tmp_tgz="$(mktemp)"
  curl -fsSL "\${ORIGIN}/install/agent.tgz" -o "$tmp_tgz"
  tar -xzf "$tmp_tgz" -C "\${CLIENT_DIR}" --strip-components=1
  rm -f "$tmp_tgz"
  (cd "\${CLIENT_DIR}" && npm ci --omit=dev --ignore-scripts)
fi

INSTALL_SERVICE="${defaultInstallService}"
if [ "\${RCM_INSTALL_SERVICE:-0}" = "1" ]; then
  INSTALL_SERVICE="1"
fi
HAS_INSTALL_SERVICE_FLAG="0"
for arg in "$@"; do
  if [ "$arg" = "--install-service" ]; then
    HAS_INSTALL_SERVICE_FLAG="1"
    break
  fi
done

if [ "$INSTALL_SERVICE" = "1" ] && [ "$HAS_INSTALL_SERVICE_FLAG" != "1" ]; then
  exec "$NODE_BIN" "\${CLIENT_DIR}/dist/remote-cli.js" remote --gateway "\${ORIGIN}" --yes --install-service "$@"
fi
exec "$NODE_BIN" "\${CLIENT_DIR}/dist/remote-cli.js" remote --gateway "\${ORIGIN}" --yes "$@"
`;
}

function renderPowerShellInstaller(origin: string, installService = false): string {
  const version = projectVersion;
  const defaultInstallService = installService ? '$true' : '$false';
  return `$ErrorActionPreference = 'Stop'

$Origin = '${origin}'
$Version = '${version}'
$BaseDir = Join-Path $env:USERPROFILE '.remote-command'
$ClientDir = Join-Path $BaseDir ("client-" + $Version)
$NodeDir = Join-Path $BaseDir 'node'
$NodeVersion = 'v24.11.1'

function Test-NodeVersion($Bin) {
  if (-not (Get-Command $Bin -ErrorAction SilentlyContinue)) { return $false }
  try {
    $major = [int](& $Bin -p "process.versions.node.split('.')[0]")
    return ($major -ge 24 -and $major -lt 27)
  } catch { return $false }
}

$NodeBin = $null
$BundledNode = Join-Path $NodeDir 'node.exe'
if (Test-NodeVersion 'node') {
  $NodeBin = (Get-Command 'node').Source
} elseif ((Test-Path $BundledNode) -and (Test-NodeVersion $BundledNode)) {
  $NodeBin = $BundledNode
} else {
  $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
  $pkg = "node-$NodeVersion-win-$arch"
  $url = "https://nodejs.org/dist/$NodeVersion/$pkg.zip"
  Write-Host "Downloading portable Node.js $NodeVersion..."
  New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
  $zipPath = Join-Path $env:TEMP "$pkg.zip"
  $extractPath = Join-Path $env:TEMP "$pkg-extract"
  if (Test-Path $extractPath) { Remove-Item -Recurse -Force $extractPath }
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Move-Item -Path (Join-Path $extractPath $pkg) -Destination $NodeDir
  Remove-Item -Force $zipPath
  Remove-Item -Recurse -Force $extractPath
  $NodeBin = $BundledNode
}

$env:PATH = (Split-Path $NodeBin -Parent) + ";" + $env:PATH
$CliPath = Join-Path $ClientDir 'dist\\remote-cli.js'

if (-not (Test-Path $CliPath)) {
  Write-Host "Installing Remote.Command Agent v$Version..."
  New-Item -ItemType Directory -Force -Path $ClientDir | Out-Null
  $tgzPath = Join-Path $env:TEMP "remote-command-$Version.tgz"
  Invoke-WebRequest -UseBasicParsing -Uri "$Origin/install/agent.tgz" -OutFile $tgzPath
  tar.exe -xzf $tgzPath -C $ClientDir --strip-components=1
  if ($LASTEXITCODE -ne 0) { throw "Failed to extract Agent package." }
  Remove-Item -Force $tgzPath
  Push-Location $ClientDir
  try {
    & npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  } finally {
    Pop-Location
  }
}

$InstallService = ${defaultInstallService}
if ($env:RCM_INSTALL_SERVICE -eq '1') { $InstallService = $true }
if ($InstallService -and ($args -notcontains '--install-service')) {
  & $NodeBin $CliPath remote --gateway $Origin --yes --install-service @args
} else {
  & $NodeBin $CliPath remote --gateway $Origin --yes @args
}
`;
}

export class Installer {
  constructor(private readonly origin: string) {}

  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method !== 'GET') return false;
    const installService = url.searchParams.get('service') === '1' || url.searchParams.get('install_service') === '1';
    if (url.pathname === '/install.sh') {
      const script = renderShellInstaller(this.origin, installService);
      res.writeHead(200, {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Cache-Control': 'no-store'
      }).end(script);
      return true;
    }
    if (url.pathname === '/install.ps1') {
      const script = renderPowerShellInstaller(this.origin, installService);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      }).end(script);
      return true;
    }
    if (url.pathname === '/install/agent.tgz') {
      const bundled = findBundledAgentTgz();
      if (bundled) {
        const size = statSync(bundled).size;
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': String(size),
          'Content-Disposition': `attachment; filename="remote-command-${projectVersion}.tgz"`,
          'Cache-Control': 'public, max-age=3600'
        });
        createReadStream(bundled).pipe(res);
        return true;
      }
      const fallback = `https://github.com/${releaseRepo}/releases/download/v${projectVersion}/remote-command-${projectVersion}.tgz`;
      res.writeHead(302, { Location: fallback, 'Cache-Control': 'no-store' }).end();
      return true;
    }
    return false;
  }
}
