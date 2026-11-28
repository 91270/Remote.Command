import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatServiceCommands, isStableServiceCliPath, serviceDefinition, serviceMetadata } from '../dist/agent-service.js';
import { configureAgent, runRemoteCommand } from '../dist/remote-cli.js';
import { approvalModes, needsLocalApproval } from '../dist/protocol.js';

test('service manifests preserve paths and supervise the Agent as a regular user', () => {
  const unit = serviceDefinition('linux', 'test-unit', '/opt/node', '/opt/rcm cli.js', '/Users/sample %t/$HOME/agent.json');
  assert.match(unit, /ExecStart="\/opt\/node" "\/opt\/rcm cli\.js" "agent" "run" "\/Users\/sample %%t\/\$\$HOME\/agent\.json"/);
  assert.match(unit, /Restart=on-failure/);
  const plist = serviceDefinition('darwin', 'test-agent', '/opt/node', '/opt/agent.js', '/Volumes/Work & Home/agent.json');
  assert.match(plist, /Work &amp; Home/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  const windows = serviceDefinition('win32', 'test-agent', 'C:\\Program Files\\node.exe', 'C:\\O\'Brien\\cli.js', 'C:\\Users\\Example\\Agent\\agent.json');
  assert.match(windows, /O''Brien/);
  assert.match(windows, /-LogonType Interactive -RunLevel Limited/);
  assert.match(windows, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.throws(() => serviceDefinition('linux', 'sample', '/opt/node', '/opt/cli', '/tmp/agent\n.json'), /control characters/);

  const temp = mkdtempSync(join(tmpdir(), 'rcm-service-'));
  try {
    const config = join(temp, 'agent host.json');
    writeFileSync(config, '{}');
    const result = spawnSync(process.execPath, ['dist/remote-cli.js', 'service', 'render', config], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (process.platform !== 'linux') assert.match(result.stdout, /remote-command-agent-[A-Za-z0-9-]{12}/);
    if (process.platform === 'darwin') {
      const path = join(temp, 'agent.plist');
      writeFileSync(path, result.stdout);
      const valid = spawnSync('/usr/bin/plutil', ['-lint', path], { encoding: 'utf8' });
      assert.equal(valid.status, 0, valid.stderr + valid.stdout);
    } else if (process.platform === 'win32') {
      const script = '[scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + Buffer.from(result.stdout).toString('base64') + '\'))) | Out-Null';
      const valid = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
      assert.equal(valid.status, 0, valid.stderr + valid.stdout);
    } else assert.match(result.stdout, /WantedBy=default.target/);
  } finally { rmSync(temp, { force: true, recursive: true }); }
});

test('remote CLI reads only the current default configuration or an explicit path', () => {
  const home = mkdtempSync(join(tmpdir(), 'rcm-config-'));
  try {
    for (const directory of ['.remote-command-mcp', '.private-remote-mcp']) {
      mkdirSync(join(home, directory));
      writeFileSync(join(home, directory, 'agent.json'), 'invalid JSON');
    }
    const local = join(home, 'agent.local.json');
    writeFileSync(local, 'invalid JSON');
    const env = { ...process.env, HOME: home, USERPROFILE: home, PRM_AGENT_CONFIG: local };
    delete env.RCM_AGENT_CONFIG;
    const args = [resolve('dist/remote-cli.js'), 'remote', '--logout'];
    const options = { cwd: home, env, encoding: 'utf8' };
    const implicit = spawnSync(process.execPath, args, options);
    assert.equal(implicit.status, 0, implicit.stderr);
    assert.match(implicit.stdout, /no saved identity/);

    const explicit = spawnSync(process.execPath, [...args, '--config', local], options);
    assert.equal(explicit.status, 1);
    assert.match(explicit.stderr, /JSON/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('needsLocalApproval maps approval modes to capabilities', () => {
  assert.deepEqual(approvalModes, ['client', 'exec-only', 'strict']);
  assert.equal(needsLocalApproval('client', 'read'), false);
  assert.equal(needsLocalApproval('client', 'write'), false);
  assert.equal(needsLocalApproval('client', 'exec'), false);

  assert.equal(needsLocalApproval('exec-only', 'read'), false);
  assert.equal(needsLocalApproval('exec-only', 'write'), false);
  assert.equal(needsLocalApproval('exec-only', 'exec'), true);

  assert.equal(needsLocalApproval('strict', 'read'), false);
  assert.equal(needsLocalApproval('strict', 'write'), true);
  assert.equal(needsLocalApproval('strict', 'exec'), true);
});

test('configureAgent uses safe fallback workspace without local capability configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rcm-onboard-'));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  try {
    process.env.HOME = home;
    process.chdir(resolve('.'));
    const cfgFile = join(home, '.remote-command', 'agent.json');
    await configureAgent(cfgFile, true, { gateway: 'https://mcp.example.com' });
    const parsed = JSON.parse(readFileSync(cfgFile, 'utf8'));
    assert.equal(parsed.gateway, 'https://mcp.example.com');
    assert.ok(parsed.workspace.endsWith('RemoteCommand-Workspace'));
    assert.equal(parsed.capabilities, undefined);

    const customWs = join(home, 'custom-ws');
    mkdirSync(customWs);
    const customCfg = join(home, '.remote-command', 'custom.json');
    await configureAgent(customCfg, false, { gateway: 'https://mcp.example.com', workspace: customWs });
    const parsedCustom = JSON.parse(readFileSync(customCfg, 'utf8'));
    assert.equal(parsedCustom.capabilities, undefined);
    assert.ok(parsedCustom.workspace.endsWith('custom-ws'));
  } finally {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('service helpers validate stable CLI path and format lifecycle commands across platforms', () => {
  assert.equal(isStableServiceCliPath('/Users/alice/.remote-command/client-0.5.3/dist/remote-cli.js'), true);
  assert.equal(isStableServiceCliPath('/Users/alice/.npm/_npx/1234/node_modules/remote-command/dist/remote-cli.js'), false);
  assert.equal(isStableServiceCliPath('C:\\Users\\alice\\AppData\\Local\\npm-cache\\_npx\\123\\remote-cli.js'), false);

  const macMeta = serviceMetadata('darwin', '/Users/alice/.remote-command/agent.json');
  assert.equal(macMeta.backend, 'LaunchAgent');
  assert.ok(macMeta.label.startsWith('io.remote-command-agent-'));
  assert.equal(serviceMetadata('linux', '/home/alice/.remote-command/agent.json').backend, 'systemd --user');
  assert.equal(serviceMetadata('win32', 'C:\\Users\\Alice\\.remote-command\\agent.json').backend, 'Windows Task Scheduler');

  const posixCmds = formatServiceCommands('/opt/rcm/dist/remote-cli.js', '/Users/alice/My Config/agent.json', '/usr/local/bin/node', 'darwin');
  assert.match(posixCmds.status, /^\/usr\/local\/bin\/node \/opt\/rcm\/dist\/remote-cli\.js service status '\/Users\/alice\/My Config\/agent\.json'$/);
  assert.match(posixCmds.stop, /service stop/);
  assert.match(posixCmds.start, /service start/);
  assert.match(posixCmds.remove, /service remove/);

  const winCmds = formatServiceCommands('C:\\rcm\\dist\\remote-cli.js', 'C:\\Users\\Alice\\agent.json', 'C:\\Program Files\\node.exe', 'win32');
  assert.match(winCmds.status, /"C:\\Program Files\\node\.exe" "C:\\rcm\\dist\\remote-cli\.js" service status "C:\\Users\\Alice\\agent\.json"/);
});

test('remote CLI --install-service validates conflicting flags, rejects _npx, and orchestrates login + service install', async () => {
  const helpOut = spawnSync(process.execPath, [resolve('dist/remote-cli.js'), 'remote', '--help'], { encoding: 'utf8' });
  assert.equal(helpOut.status, 0);
  assert.match(helpOut.stdout, /--install-service/);

  const conflictOut = spawnSync(process.execPath, [resolve('dist/remote-cli.js'), 'remote', '--install-service', '--no-persist-session'], { encoding: 'utf8' });
  assert.equal(conflictOut.status, 1);
  assert.match(conflictOut.stderr, /--no-persist-session/);

  await assert.rejects(
    () => runRemoteCommand(['--install-service', '--logout']),
    /--logout or --report/
  );
  await assert.rejects(
    () => runRemoteCommand(['--install-service', '--report']),
    /--logout or --report/
  );
  await assert.rejects(
    () => runRemoteCommand(['--install-service'], { cliPath: '/tmp/_npx/abc/dist/remote-cli.js' }),
    /stable local path/
  );

  // Unpaired config: configures, logs in (preserving --no-browser), then installs service without entering foreground loop
  const home = mkdtempSync(join(tmpdir(), 'rcm-remote-svc-'));
  try {
    const calls = [];
    const fakeCfgPath = join(home, '.remote-command', 'agent.json');
    const fakeStateDir = join(home, '.remote-command', 'device');
    mkdirSync(fakeStateDir, { recursive: true });
    let configPresent = false;
    await runRemoteCommand(['--gateway', 'https://mcp.example.com', '--install-service', '--no-browser'], {
      homeDir: home,
      cliPath: '/Users/alice/.remote-command/client/dist/remote-cli.js',
      exists: async () => configPresent,
      configure: async (file, isDefault, preset) => {
        calls.push(['configure', file, isDefault, preset.gateway]);
        configPresent = true;
      },
      loadConfig: async (file) => ({
        gateway: 'https://mcp.example.com',
        origin: 'https://mcp.example.com',
        workspace: join(home, 'RemoteCommand-Workspace'),
        stateDir: fakeStateDir,
        approvals: join(fakeStateDir, 'approvals'),
        pendingResults: join(fakeStateDir, 'pending-results'),
        allowInsecureLoopback: false,
        noSleep: true,
        logToFile: false
      }),
      runAgent: async (argv) => { calls.push(['agent', ...argv]); },
      runService: async (argv) => { calls.push(['service', ...argv]); }
    });
    assert.deepEqual(calls, [
      ['configure', fakeCfgPath, true, 'https://mcp.example.com'],
      ['agent', 'login', fakeCfgPath, '--no-browser'],
      ['service', 'install', fakeCfgPath]
    ]);

    // Already paired to matching origin: skips login and registers service directly
    const pairedCalls = [];
    writeFileSync(join(fakeStateDir, 'identity.json'), JSON.stringify({
      origin: 'https://mcp.example.com',
      id: '11111111-1111-4111-8111-111111111111',
      credential: 'A'.repeat(43)
    }));
    await runRemoteCommand(['--install-service'], {
      homeDir: home,
      cliPath: '/Users/alice/.remote-command/client/dist/remote-cli.js',
      exists: async () => true,
      loadConfig: async () => ({
        gateway: 'https://mcp.example.com',
        origin: 'https://mcp.example.com',
        workspace: join(home, 'RemoteCommand-Workspace'),
        stateDir: fakeStateDir,
        approvals: join(fakeStateDir, 'approvals'),
        pendingResults: join(fakeStateDir, 'pending-results'),
        allowInsecureLoopback: false,
        noSleep: true,
        logToFile: false
      }),
      runAgent: async (argv) => { pairedCalls.push(['agent', ...argv]); },
      runService: async (argv) => { pairedCalls.push(['service', ...argv]); }
    });
    assert.deepEqual(pairedCalls, [
      ['service', 'install', fakeCfgPath]
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
