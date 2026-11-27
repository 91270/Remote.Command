import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const first = args[0];
if (first === '--help' || first === '-h') {
  console.log('Usage: ./launch.sh [CONFIG] [--logout|--report] [--no-browser] [--no-persist-session] [--disable-no-sleep] [--debug]');
  console.log('On Windows: .\\launch.ps1 [CONFIG] [options]');
  process.exit(0);
}
function detectLocalGatewayOrigin(projectRoot) {
  const direct = (process.env.RCM_GATEWAY ?? process.env.PUBLIC_ORIGIN ?? '').trim();
  const isUsable = value => value.startsWith('https://') && !value.includes('example.com') && !value.includes('你的域名');
  if (isUsable(direct)) return direct;
  const envFile = join(projectRoot, 'state', 'local-test.env');
  if (!existsSync(envFile)) return undefined;
  try {
    const content = readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?PUBLIC_ORIGIN\s*=\s*(.+)$/.exec(line);
      if (!match) continue;
      let val = match[1].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1).trim();
      }
      if (isUsable(val)) return val;
    }
  } catch {
    // Ignore unreadable local env file.
  }
  return undefined;
}

const hasExplicitConfig = (first && !first.startsWith('-'))
  || args.includes('--config')
  || args.some(arg => arg.startsWith('--config='));
const hasGatewayArg = args.includes('--gateway') || args.some(arg => arg.startsWith('--gateway='));
const isMaintenanceOnly = args.includes('--logout') || args.includes('--report');

const remoteArgs = first && !first.startsWith('-')
  ? ['remote', '--config', resolve(first), ...args.slice(1)]
  : ['remote', ...args];
if (!hasExplicitConfig && !hasGatewayArg && !isMaintenanceOnly) {
  const detectedGateway = detectLocalGatewayOrigin(project);
  if (detectedGateway) remoteArgs.push('--gateway', detectedGateway);
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 24 || major >= 27) throw new Error('Use Node.js 24–26 or start with the platform launcher.');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const desired = json(join(project, 'package-lock.json'));
const installedPath = join(project, 'node_modules', '.package-lock.json');
const installed = existsSync(installedPath) ? json(installedPath) : { packages: {} };
const direct = Object.keys({ ...desired.packages[''].dependencies, ...desired.packages[''].devDependencies });
const compiler = join(project, 'node_modules', 'typescript', 'bin', 'tsc');

function run(program, args) {
  const result = spawnSync(program, args, { cwd: project, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!existsSync(compiler) || direct.some(name => {
  const key = 'node_modules/' + name;
  return installed.packages[key]?.version !== desired.packages[key]?.version;
})) {
  const executableDir = dirname(process.execPath);
  const npmCli = process.platform === 'win32'
    ? join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(executableDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['ci', '--include=dev', '--ignore-scripts'];
  if (existsSync(npmCli)) run(process.execPath, [npmCli, ...args]);
  else if (process.platform === 'win32') {
    run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'npm', ...args]);
  } else run('npm', args);
}

run(process.execPath, [compiler, '-p', 'tsconfig.json']);
const agent = spawn(process.execPath, [join(project, 'dist', 'remote-cli.js'), ...remoteArgs], { stdio: 'inherit' });
process.on('SIGINT', () => { /* the foreground console also signals the Agent */ });
process.on('SIGTERM', () => agent.kill('SIGTERM'));
agent.once('error', error => { console.error(error.message); process.exitCode = 1; });
agent.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
