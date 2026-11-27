import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentUi,
  formatDuration,
  formatTime,
  formatToolOutputPreview,
  redactAndFormatArgs,
  redactSensitive,
  stripAnsi
} from '../dist/agent-ui.js';

test('formatTime, stripAnsi, and formatDuration format values cleanly', () => {
  const date = new Date(2026, 10, 27, 9, 5, 3);
  assert.equal(formatTime(date), '09:05:03');
  assert.equal(stripAnsi('\x1b[32mhello\x1b[0m \x1b[90mworld\x1b[0m'), 'hello world');
  assert.equal(formatDuration(42), '42ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(125_000), '2m 5s');
});

test('redactSensitive and redactAndFormatArgs mask credentials and bound argument length', () => {
  const redacted = redactSensitive({
    path: '/tmp/a.txt',
    token: 'secret-token',
    nested: { apiKey: 'k-123', Authorization: 'Bearer abc', safe: 'ok' }
  });
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.nested.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.Authorization, '[REDACTED]');
  assert.equal(redacted.nested.safe, 'ok');

  const large = { credential: 'hidden', command: 'x'.repeat(500) };
  const concise = redactAndFormatArgs(large, false);
  assert.ok(concise.includes('[REDACTED]'));
  assert.ok(concise.endsWith('…'));
  assert.ok(concise.length <= 301);

  const verbose = redactAndFormatArgs(large, true);
  assert.ok(verbose.includes('[REDACTED]'));
  assert.ok(!verbose.endsWith('…'));
});

test('formatToolOutputPreview respects concise and verbose limits', () => {
  assert.equal(formatToolOutputPreview('   ', false), '(empty output)');
  const tenLines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n');
  const conciseLines = formatToolOutputPreview(tenLines, false);
  assert.match(conciseLines, /line-1/);
  assert.match(conciseLines, /line-6/);
  assert.ok(!conciseLines.includes('line-7'));
  assert.match(conciseLines, /10 lines/);

  const longOutput = 'a'.repeat(8500);
  const verboseOutput = formatToolOutputPreview(longOutput, true);
  assert.ok(verboseOutput.length > 8000);
  assert.match(verboseOutput, /\+500 chars/);
});

test('createAgentUi renders interactive banner, ready summary, and suppresses colors in serviceMode', () => {
  const out = [];
  const err = [];
  const fixedNow = new Date(2026, 10, 27, 14, 15, 16);
  const ui = createAgentUi({
    color: true,
    serviceMode: false,
    writeOut: line => out.push(line),
    writeErr: line => err.push(line),
    now: () => fixedNow
  });
  ui.banner();
  ui.ready({
    userEmail: 'owner@example.com',
    deviceId: '11111111-1111-4111-8111-111111111111',
    deviceName: 'TestMac',
    gateway: 'https://mcp.example.com',
    workspace: '/srv/work',
    capabilities: ['read', 'exec'],
    approvalMode: 'exec-only',
    version: '0.5.3',
    logDir: '/tmp/logs'
  });
  const plain = out.map(stripAnsi).join('\n');
  assert.match(plain, /\[14:15:16\]/);
  assert.match(plain, /Remote Connection/);
  assert.match(plain, /Device ready:/);
  assert.match(plain, /owner@example\.com/);
  assert.match(plain, /TestMac/);
  assert.match(plain, /read, exec/);
  assert.match(plain, /exec-only/);
  assert.match(plain, /Next/);
  assert.match(plain, /Commands/);
  assert.equal(err.length, 0);

  const svcOut = [];
  const svcUi = createAgentUi({
    color: true,
    serviceMode: true,
    writeOut: line => svcOut.push(line),
    writeErr: line => err.push(line),
    now: () => fixedNow
  });
  svcUi.banner();
  svcUi.ready({
    deviceId: '11111111-1111-4111-8111-111111111111',
    deviceName: 'ServerNode',
    gateway: 'https://mcp.example.com',
    workspace: '/srv/work',
    capabilities: ['read'],
    approvalMode: 'client',
    version: '0.5.3'
  });
  const svcJoined = svcOut.join('\n');
  assert.ok(!/\x1b\[/.test(svcJoined), 'serviceMode must not emit ANSI escapes');
  assert.ok(!svcJoined.includes('┌─ Next'), 'serviceMode must omit interactive boxes');
  assert.ok(!svcJoined.includes('User:'), 'User row should be omitted when userEmail is absent');
});

test('gatewayUnreachable throttles repeated retry notices and resets on reconnect', () => {
  let clock = 1_000_000;
  const out = [];
  const ui = createAgentUi({
    color: false,
    writeOut: line => out.push(line),
    now: () => new Date(clock)
  });

  ui.gatewayUnreachable('fetch failed', 700, 1);
  clock += 2000;
  ui.gatewayUnreachable('fetch failed', 1400, 2);
  clock += 5000;
  ui.gatewayUnreachable('fetch failed', 2800, 3);
  assert.equal(out.length, 1);

  clock += 30_000;
  ui.gatewayUnreachable('fetch failed', 5600, 4);
  assert.equal(out.length, 2);
  assert.match(out[1], /attempt #4/);

  ui.gatewayReconnected(37_000);
  assert.equal(out.length, 3);
  assert.match(out[2], /Reconnected to Gateway \(offline for 37\.0s\)/);
});

test('optional rotating file logging writes plain text without ANSI and leaves disk untouched when disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcm-agent-ui-log-'));
  try {
    const offOut = [];
    const uiOff = createAgentUi({ color: false, writeOut: line => offOut.push(line) });
    uiOff.info('console only');
    assert.equal(readdirSync(dir).length, 0);

    const logDir = join(dir, 'logs');
    const uiOn = createAgentUi({
      color: true,
      logDir,
      writeOut: () => {},
      writeErr: () => {}
    });
    uiOn.info('hello file logger');
    uiOn.toolReceived('job-1', 'read_file', { path: 'a.txt', secret: 'xyz' });
    uiOn.toolFinished('job-1', 'read_file', 'succeeded', 15, 'ok');

    const files = readdirSync(logDir);
    assert.equal(files.length, 1);
    const logPath = join(logDir, files[0]);
    const content = readFileSync(logPath, 'utf8');
    assert.ok(!/\x1b\[/.test(content), 'log file must strip ANSI codes');
    assert.match(content, /hello file logger/);
    assert.match(content, /\[REDACTED\]/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(logPath).mode & 0o077, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
