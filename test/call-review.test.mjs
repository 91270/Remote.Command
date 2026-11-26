import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildCallReviewPreview,
  classifyBlockSource,
  extractManualCommand,
  renderCallReviewHtml
} from '../dist/call-review.js';

test('renderCallReviewHtml injects current project version without stale hardcoded 0.4.1', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const template = await readFile(new URL('../web/call-review.html', import.meta.url), 'utf8');
  const rendered = renderCallReviewHtml(template, pkg.version);

  assert.equal(rendered.includes('__RCM_VERSION__'), false);
  assert.equal(rendered.includes('0.4.1'), false);
  assert.ok(rendered.includes(JSON.stringify(pkg.version)));
  assert.match(rendered, /ui\/notifications\/tool-result/);
  assert.match(rendered, /复制终端命令/);
  assert.match(rendered, /复制调用详情/);
});

test('classifyBlockSource and buildCallReviewPreview handle all 5 review scenarios accurately', () => {
  assert.equal(classifyBlockSource(undefined, undefined), 'none');
  assert.equal(classifyBlockSource('Blocked by safety filter', 'Flagged expression'), 'host_safety');
  assert.equal(classifyBlockSource('Command not allowed: sudo', 'Local block'), 'local_command_policy');
  assert.equal(classifyBlockSource('Error: Path not allowed outside workspace', 'Directory guard'), 'local_path_policy');
  assert.equal(classifyBlockSource('Operation denied by local Agent configuration.', 'Missing write cap'), 'local_capability');

  // 1. Pre-execution preview for start_process
  const preExec = buildCallReviewPreview({
    tool_name: 'start_process',
    arguments: { command: 'npm test', timeout_ms: 5000 },
    summary: 'Run unit tests'
  }, null);
  assert.equal(preExec.after_client_error, false);
  assert.equal(preExec.block_source, 'none');
  assert.equal(preExec.capability, 'exec');
  assert.equal(preExec.manual_command, 'npm test');
  assert.ok(preExec.guidance.length >= 1);

  // 2. Host safety block with interact_with_process
  const hostBlocked = buildCallReviewPreview({
    tool_name: 'interact_with_process',
    arguments: { pid: 123, input: 'ls -la' },
    summary: 'Send shell command',
    client_error: 'This tool call was blocked by safety checks.',
    likely_reason: 'Host flagged the shell input.'
  }, '11111111-1111-4111-8111-111111111111');
  assert.equal(hostBlocked.after_client_error, true);
  assert.equal(hostBlocked.block_source, 'host_safety');
  assert.equal(hostBlocked.manual_command, 'ls -la');
  assert.ok(hostBlocked.guidance.some(g => g.includes('ChatGPT / OpenAI')));
  assert.ok(hostBlocked.guidance.some(g => g.includes('复制下方终端命令')));

  // 3. Local path block on write_file
  const localPathBlocked = buildCallReviewPreview({
    tool_name: 'write_file',
    arguments: { path: '/etc/hosts', content: 'x' },
    summary: 'Write outside workspace',
    client_error: 'Path not allowed',
    likely_reason: 'Target is outside allowedDirectories.'
  }, null);
  assert.equal(localPathBlocked.block_source, 'local_path_policy');
  assert.equal(localPathBlocked.capability, 'write');
  assert.equal(localPathBlocked.manual_command, null);
  assert.equal(extractManualCommand('write_file', { path: '/etc/hosts' }), null);
});
