#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(rootDir, 'state', 'local-test.env');
const exampleFile = join(rootDir, 'local-test.env.example');
const installBinDir = join(homedir(), '.local', 'bin');
const isWin = process.platform === 'win32';
const binName = isWin ? 'cloudflared.exe' : 'cloudflared';

function printUsage() {
  console.log(`用法:
  macOS / Linux: ./scripts/dev-local.sh [命令] [选项]
  Windows (PS) : .\\scripts\\dev-local.ps1 [命令] [选项]
  通用 (Node)  : node scripts/dev-local.mjs [命令] [选项]

命令:
  all                       同时启动 Cloudflare Tunnel 与本地 Gateway（默认，Ctrl+C 一并停止）
  tunnel                    仅启动 Cloudflare Tunnel（未安装 cloudflared 时自动安装）
  gateway                   仅启动本地 Gateway
  install-tunnel [--force]  仅安装或强制更新 cloudflared 到 ~/.local/bin（Windows 为 %USERPROFILE%\\.local\\bin）
  -h, --help                显示此帮助信息

前置准备:
  macOS / Linux: install -d -m 0700 state && cp local-test.env.example state/local-test.env && chmod 600 state/local-test.env
  Windows (PS) : New-Item -ItemType Directory -Force state | Out-Null; Copy-Item local-test.env.example state\\local-test.env
  然后编辑 state/local-test.env，填入 PUBLIC_ORIGIN、Google OAuth 与 CLOUDFLARED_TUNNEL_TOKEN。`);
}

function isExecutableFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findCloudflared() {
  const candidates = [
    join(installBinDir, binName),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, binName))
  ];
  return candidates.find(isExecutableFile) ?? null;
}

function readCloudflaredVersion(exePath) {
  const res = spawnSync(exePath, ['--version'], { encoding: 'utf8', windowsHide: true });
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  return text.split(/\r?\n/)[0] || 'unknown version';
}

function resolveReleaseAsset() {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    if (arch === 'x64') return { kind: 'tgz', asset: 'cloudflared-darwin-amd64.tgz', label: 'darwin-amd64' };
    if (arch === 'arm64') return { kind: 'tgz', asset: 'cloudflared-darwin-arm64.tgz', label: 'darwin-arm64' };
  } else if (platform === 'linux') {
    if (arch === 'x64') return { kind: 'bin', asset: 'cloudflared-linux-amd64', label: 'linux-amd64' };
    if (arch === 'arm64') return { kind: 'bin', asset: 'cloudflared-linux-arm64', label: 'linux-arm64' };
  } else if (platform === 'win32') {
    if (arch === 'x64' || arch === 'arm64') return { kind: 'bin', asset: 'cloudflared-windows-amd64.exe', label: 'windows-amd64' };
    if (arch === 'ia32') return { kind: 'bin', asset: 'cloudflared-windows-386.exe', label: 'windows-386' };
  }
  throw new Error(`暂不支持自动安装 cloudflared 到 ${platform}/${arch}，请从 Cloudflare Releases 手动下载安装。`);
}

async function installTunnel(force = false) {
  const existing = findCloudflared();
  if (!force && existing) {
    console.log(`cloudflared 已安装: ${existing} (${readCloudflaredVersion(existing)})`);
    return existing;
  }

  const { kind, asset, label } = resolveReleaseAsset();
  const version = (process.env.CLOUDFLARED_VERSION ?? '').trim();
  const urlBase = version
    ? `https://github.com/cloudflare/cloudflared/releases/download/${encodeURIComponent(version)}`
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download';
  const downloadUrl = `${urlBase}/${asset}`;
  const destPath = join(installBinDir, binName);

  console.log(`正在下载安装 cloudflared (${label}) 到 ${destPath} ...`);
  const tmpDir = mkdtempSync(join(tmpdir(), 'rcm-cloudflared-'));
  try {
    const res = await fetch(downloadUrl, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      throw new Error(`下载 cloudflared 失败 (HTTP ${res.status}): ${downloadUrl}`);
    }
    const payload = Buffer.from(await res.arrayBuffer());
    mkdirSync(installBinDir, { recursive: true, ...(isWin ? {} : { mode: 0o755 }) });

    if (kind === 'tgz') {
      const archivePath = join(tmpDir, asset);
      writeFileSync(archivePath, payload);
      const extract = spawnSync('tar', ['-xzf', archivePath, '-C', tmpDir], { stdio: 'inherit' });
      if (extract.status !== 0) {
        throw new Error('解压 cloudflared 压缩包失败。');
      }
      copyFileSync(join(tmpDir, 'cloudflared'), destPath);
    } else {
      const rawPath = join(tmpDir, binName);
      writeFileSync(rawPath, payload);
      copyFileSync(rawPath, destPath);
    }

    if (!isWin) {
      chmodSync(destPath, 0o755);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`安装完成: ${destPath} (${readCloudflaredVersion(destPath)})`);
  return destPath;
}

function parseEnvFile(filePath) {
  const content = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eqIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.indexOf(' #');
      if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadEnv() {
  if (!existsSync(envFile)) {
    const hint = isWin
      ? '  New-Item -ItemType Directory -Force state | Out-Null; Copy-Item local-test.env.example state\\local-test.env'
      : '  install -d -m 0700 state && cp local-test.env.example state/local-test.env && chmod 600 state/local-test.env';
    throw new Error(
      `未找到本地配置文件: ${envFile}\n` +
      (existsSync(exampleFile) ? `请先执行以下命令从脱敏模板创建并填写配置:\n${hint}` : '')
    );
  }
  const fileVars = parseEnvFile(envFile);
  const merged = { ...process.env, ...fileVars };
  merged.PATH = `${installBinDir}${delimiter}${merged.PATH ?? ''}`;
  return merged;
}

function validateTunnelToken(env) {
  if (!(env.CLOUDFLARED_TUNNEL_TOKEN ?? '').trim()) {
    throw new Error(`请先在 ${envFile} 中填写 CLOUDFLARED_TUNNEL_TOKEN。`);
  }
}

function validateGatewayEnv(env) {
  const origin = (env.PUBLIC_ORIGIN ?? '').trim();
  if (!origin || origin.includes('example.com') || origin.includes('你的域名')) {
    throw new Error(`请先在 ${envFile} 中将 PUBLIC_ORIGIN 修改为你的真实 HTTPS 域名。`);
  }
  if (!(env.GOOGLE_CLIENT_ID ?? '').trim() || !(env.GOOGLE_CLIENT_SECRET ?? '').trim()) {
    throw new Error(`请先在 ${envFile} 中填写 GOOGLE_CLIENT_ID 与 GOOGLE_CLIENT_SECRET。`);
  }
}

function ensureBuild(env) {
  const gatewayEntry = join(rootDir, 'dist', 'gateway.js');
  if (existsSync(gatewayEntry)) return gatewayEntry;
  console.log('未检测到 dist/gateway.js，正在执行 npm run build...');
  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const res = spawnSync(npmCmd, ['run', 'build'], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    shell: isWin,
    windowsHide: true
  });
  if (res.status !== 0) {
    throw new Error('npm run build 执行失败，请检查编译报错。');
  }
  return gatewayEntry;
}

function buildGatewayEnv(env) {
  const next = { ...env };
  delete next.CLOUDFLARED_TUNNEL_TOKEN;
  delete next.CLOUDFLARED_TUNNEL_NAME;
  delete next.TUNNEL_TOKEN;
  return next;
}

function terminateChild(child) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(isWin ? undefined : 'SIGTERM');
  } catch {
    // ignore already-exited child
  }
}

function waitChild(child) {
  return new Promise(resolvePromise => {
    child.once('error', err => resolvePromise({ code: 1, error: err }));
    child.once('exit', (code, signal) => resolvePromise({ code: code ?? (signal ? 0 : 1), signal }));
  });
}

async function runSingle(cmd, args, options) {
  const child = spawn(cmd, args, { ...options, stdio: 'inherit', windowsHide: true });
  const forwardSignal = () => terminateChild(child);
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);
  try {
    const result = await waitChild(child);
    if (result.error) throw result.error;
    return result.code;
  } finally {
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);
  }
}

async function runAll(cloudflaredBin, gatewayEntry, env) {
  const tunnelEnv = { ...env, TUNNEL_TOKEN: env.CLOUDFLARED_TUNNEL_TOKEN };
  const gatewayEnv = buildGatewayEnv(env);
  const tunnelChild = spawn(cloudflaredBin, ['tunnel', 'run'], {
    cwd: rootDir,
    env: tunnelEnv,
    stdio: 'inherit',
    windowsHide: true
  });
  console.log(`已启动 Cloudflare Tunnel (PID: ${tunnelChild.pid ?? 'unknown'})`);
  console.log(`正在启动本地 Gateway (${env.PUBLIC_ORIGIN} -> ${env.BIND_HOST || '127.0.0.1'}:${env.PORT || '8787'})，按 Ctrl+C 一并停止...`);

  const gatewayChild = spawn(process.execPath, [gatewayEntry], {
    cwd: rootDir,
    env: gatewayEnv,
    stdio: 'inherit',
    windowsHide: true
  });

  let shuttingDown = false;
  const stopAll = () => {
    shuttingDown = true;
    terminateChild(gatewayChild);
    terminateChild(tunnelChild);
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  try {
    const first = await Promise.race([
      waitChild(tunnelChild).then(res => ({ name: 'Cloudflare Tunnel', ...res })),
      waitChild(gatewayChild).then(res => ({ name: 'Gateway', ...res }))
    ]);
    if (!shuttingDown) {
      console.error(`${first.name} 已退出 (code=${first.code})，正在停止另一进程...`);
      stopAll();
    }
    await Promise.allSettled([waitChild(tunnelChild), waitChild(gatewayChild)]);
    return shuttingDown && first.signal ? 0 : first.code;
  } finally {
    process.off('SIGINT', stopAll);
    process.off('SIGTERM', stopAll);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? 'all';

  if (mode === '-h' || mode === '--help') {
    printUsage();
    return 0;
  }

  if (mode === 'install-tunnel' || mode === 'install') {
    if (args.length > 2) {
      printUsage();
      return 2;
    }
    const force = args[1] === '--force';
    if (args.length === 2 && !force) {
      console.error(`错误: 未知选项 '${args[1]}'。`);
      printUsage();
      return 2;
    }
    await installTunnel(force);
    return 0;
  }

  if (!['all', 'tunnel', 'gateway'].includes(mode)) {
    console.error(`错误: 未知命令 '${mode}'。`);
    printUsage();
    return 2;
  }
  if (args.length > 1) {
    console.error('错误: 参数过多。');
    printUsage();
    return 2;
  }

  const env = loadEnv();

  if (mode === 'tunnel') {
    validateTunnelToken(env);
    const cloudflaredBin = await installTunnel(false);
    console.log('正在启动 Cloudflare Tunnel...');
    return runSingle(cloudflaredBin, ['tunnel', 'run'], {
      cwd: rootDir,
      env: { ...env, TUNNEL_TOKEN: env.CLOUDFLARED_TUNNEL_TOKEN }
    });
  }

  if (mode === 'gateway') {
    validateGatewayEnv(env);
    const gatewayEntry = ensureBuild(env);
    console.log(`正在启动本地 Gateway (${env.PUBLIC_ORIGIN} -> ${env.BIND_HOST || '127.0.0.1'}:${env.PORT || '8787'})...`);
    return runSingle(process.execPath, [gatewayEntry], {
      cwd: rootDir,
      env: buildGatewayEnv(env)
    });
  }

  validateTunnelToken(env);
  validateGatewayEnv(env);
  const cloudflaredBin = await installTunnel(false);
  const gatewayEntry = ensureBuild(env);
  return runAll(cloudflaredBin, gatewayEntry, env);
}

main()
  .then(code => { process.exitCode = code; })
  .catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
