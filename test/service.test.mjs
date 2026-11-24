import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serviceDefinition } from '../dist/agent-service.js';

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
