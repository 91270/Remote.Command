import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const nativeTools = [
  'get_config', 'set_config_value', 'read_file', 'read_multiple_files', 'write_file',
  'write_pdf', 'create_directory', 'list_directory', 'move_file', 'start_search',
  'get_more_search_results', 'stop_search', 'list_searches', 'get_file_info',
  'edit_block', 'start_process', 'read_process_output', 'interact_with_process',
  'force_terminate', 'list_sessions', 'list_processes', 'kill_process',
  'get_usage_stats', 'get_recent_tool_calls', 'give_feedback_to_desktop_commander'
];
const output = result => result.content.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n');
const quote = value => '"' + value.replaceAll('"', '\\"') + '"';

test('full MIT core exposes native tools, resources, sessions, configuration and document formats', { timeout: 90000 }, async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'prm-dc-core-')));
  const workspace = join(folder, 'workspace'), privateState = join(folder, 'core');
  await mkdir(workspace);
  await mkdir(privateState, { mode: 0o700 });
  let chromePath = process.env.PRM_TEST_CHROME_PATH;
  if (!chromePath && process.platform === 'darwin') {
    const candidate = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try { await access(candidate); chromePath = candidate; } catch {}
  }
  const ripgrep = process.env.RIPGREP_PATH ?? (process.platform === 'win32'
    ? execFileSync('where.exe', ['rg.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    : execFileSync('sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).trim());
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('dist/dc-core.js')], cwd: workspace,
    env: { PATH: process.env.PATH, ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }),
      PRM_WORKSPACE: workspace, PRM_CORE_STATE: privateState, PRM_RIPGREP: ripgrep,
      ...(chromePath && { PRM_CHROME_PATH: chromePath }) }, stderr: 'pipe'
  });
  const client = new Client({ name: 'private-remote-core-test', version: '0.2.0' });
  let diagnostics = '';
  transport.stderr?.setEncoding('utf8').on('data', data => { diagnostics = (diagnostics + data).slice(-12000); });
  client.setNotificationHandler(LoggingMessageNotificationSchema, async ({ params }) => {
    if (typeof params.data === 'string' && params.data.startsWith('Could not end every process of PID ')) {
      diagnostics = (diagnostics + params.data + '\n').slice(-12000);
    }
  });
  const invoked = new Set();
  async function call(name, args = {}, options = {}) {
    invoked.add(name);
    const deadline = Date.now() + 12000;
    for (;;) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000, ...options });
      const text = output(result);
      if (result.isError && /still loading|try again in a few seconds/i.test(text) && Date.now() < deadline) { await delay(250); continue; }
      return result;
    }
  }
  function success(result) { assert.equal(result.isError, undefined, output(result)); return output(result); }
  async function untilProcessOutput(pid, expected, initial) {
    const readOutput = async () => success(await call('read_process_output', { pid, offset: -20, length: 20 }));
    let text = initial + '\n' + await readOutput();
    for (const deadline = Date.now() + 5000; !expected.test(text) && Date.now() < deadline;) {
      await delay(100);
      text = initial + '\n' + await readOutput();
    }
    assert.match(text, expected);
    return text;
  }
  try {
    await client.connect(transport, { timeout: 10000 });
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), nativeTools.slice().sort());
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 2);
    for (const resource of resources.resources) {
      const html = await client.readResource({ uri: resource.uri });
      assert.equal(html.contents[0].mimeType, 'text/html;profile=mcp-app');
      assert.ok(html.contents[0].text.includes('<html'));
      assert.ok(html.contents[0].text.includes('Content-Security-Policy'));
    }
    success(await call('write_file', { path: join(workspace, 'hello.txt'), content: 'needle\r\nsecond line\r\n' }));
    assert.match(success(await call('read_file', { path: join(workspace, 'hello.txt'), offset: -1 })), /second line/);
    success(await call('write_file', { path: join(workspace, 'hello.txt'), content: 'last line\r\n', mode: 'append' }));
    assert.match(success(await call('read_multiple_files', { paths: [join(workspace, 'hello.txt')] })), /last line/);
    success(await call('get_file_info', { path: join(workspace, 'hello.txt') }));
    success(await call('create_directory', { path: join(workspace, 'sub') }));
    success(await call('write_file', { path: join(workspace, 'sub', 'original.txt'), content: 'move fixture' }));
    success(await call('move_file', { source: join(workspace, 'sub', 'original.txt'), destination: join(workspace, 'sub', 'moved.txt') }));
    assert.equal(await readFile(join(workspace, 'sub', 'moved.txt'), 'utf8'), 'move fixture');
    success(await call('list_directory', { path: workspace, depth: 3 }));
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cG3sAAAAASUVORK5CYII=';
    const pngPath = join(workspace, 'pixel.png');
    await writeFile(pngPath, Buffer.from(png, 'base64'));
    const imageResult = await call('read_file', { path: pngPath });
    success(imageResult);
    assert.deepEqual(imageResult.content.find(content => content.type === 'image'), { type: 'image', mimeType: 'image/png', data: png });
    let urlRequests = 0;
    const fixture = createServer((_request, response) => {
      urlRequests++;
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Explicit URL fixture');
    }).listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    try {
      const url = 'http://127.0.0.1:' + fixture.address().port + '/fixture';
      assert.equal((await call('read_file', { path: url, isUrl: false })).isError, true);
      assert.equal(urlRequests, 0);
      assert.equal(success(await call('read_file', { path: url, isUrl: true })), 'Explicit URL fixture');
      assert.equal(urlRequests, 1);
    } finally { await new Promise(resolve => fixture.close(resolve)); }
    const outside = join(folder, 'outside.txt');
    await writeFile(outside, 'outside boundary');
    assert.equal((await call('read_file', { path: outside })).isError, true);
    const differentlyCasedSibling = join(folder, 'WORKSPACE');
    const separateCase = await mkdir(differentlyCasedSibling).then(() => true, error => {
      if (error.code === 'EEXIST') return false;
      throw error;
    });
    if (separateCase) {
      const caseFixture = join(differentlyCasedSibling, 'private.txt');
      await writeFile(caseFixture, 'separate case boundary');
      assert.equal((await call('read_file', { path: caseFixture })).isError, true);
    }
    success(await call('edit_block', { file_path: join(workspace, 'hello.txt'), old_string: 'needle', new_string: 'changed' }));
    assert.match(await readFile(join(workspace, 'hello.txt'), 'utf8'), /changed\r\n/);
    const configResult = await call('get_config');
    assert.deepEqual(configResult.structuredContent.config.allowedDirectories, [workspace]);
    success(await call('set_config_value', { key: 'fileReadLineLimit', value: 321 }));
    assert.equal((await call('get_config')).structuredContent.config.fileReadLineLimit, 321);
    assert.equal((await call('set_config_value', { key: 'telemetryEnabled', value: true })).isError, true);
    assert.equal((await call('set_config_value', { key: 'allowedDirectories', value: [process.platform === 'win32' ? 'C:/' : '/'] })).isError, true);
    const searched = success(await call('start_search', { path: workspace, pattern: 'changed', searchType: 'content', timeout_ms: 5000 }));
    assert.match(success(await call('list_searches')), /search_/);
    const searchId = /search_[A-Za-z0-9_]+/.exec(searched)[0];
    let matches = success(await call('get_more_search_results', { sessionId: searchId }));
    for (const deadline = Date.now() + 5000; !/hello\.txt/.test(searched + matches) && Date.now() < deadline;) {
      await delay(100);
      matches = success(await call('get_more_search_results', { sessionId: searchId }));
    }
    assert.match(searched + matches, /hello\.txt/);
    success(await call('stop_search', { sessionId: searchId }));
    const command = quote(process.execPath) + ' -e "console.log(12345);setTimeout(()=>{},20000)"';
    const started = success(await call('start_process', { command, timeout_ms: 100 }));
    const pid = Number(/(?:PID|pid)[^\d]*(\d+)/.exec(started)?.[1]);
    assert.ok(pid > 0, started);
    const session = success(await call('list_sessions'));
    assert.ok(session.includes(String(pid)));
    await untilProcessOutput(pid, /12345/, started);
    success(await call('force_terminate', { pid }));
    success(await call('list_processes'));
    assert.equal((await call('kill_process', { pid: 0 })).isError, true);
    const killScript = join(workspace, 'kill-fixture.cjs');
    await writeFile(killScript, "console.log('kill-ready:' + process.pid); setTimeout(() => {}, 20000);\n");
    const killFixture = success(await call('start_process', {
      command: quote(process.execPath) + ' ' + quote(killScript), timeout_ms: 100
    }));
    const fixturePid = Number(/(?:PID|pid)[^\d]*(\d+)/.exec(killFixture)?.[1]);
    assert.ok(fixturePid > 0, killFixture);
    const fixtureOutput = await untilProcessOutput(fixturePid, /kill-ready:\d+/, killFixture);
    const childPid = Number(/kill-ready:(\d+)/.exec(fixtureOutput)?.[1]);
    assert.ok(childPid > 0, fixtureOutput);
    success(await call('kill_process', { pid: fixturePid }));
    if (process.platform === 'win32') assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    const repl = success(await call('start_process', { command: quote(process.execPath) + ' -i', timeout_ms: 100 }));
    const replPid = Number(/(?:PID|pid)[^\d]*(\d+)/.exec(repl)?.[1]);
    assert.ok(replPid > 0, repl);
    let interaction = success(await call('interact_with_process', { pid: replPid, input: 'console.log(24680)', timeout_ms: 1000 }));
    for (let attempt = 0; attempt < 10 && !interaction.includes('24680'); attempt++) {
      await delay(100);
      interaction += success(await call('read_process_output', { pid: replPid, timeout_ms: 500 }));
    }
    assert.match(interaction, /24680/);
    success(await call('force_terminate', { pid: replPid }));
    const workbook = join(workspace, 'workbook.xlsx');
    success(await call('write_file', { path: workbook, content: JSON.stringify([['Name', 'Value'], ['alpha', 1]]) }));
    assert.match(success(await call('read_file', { path: workbook, range: 'A1:B2' })), /alpha/);
    success(await call('edit_block', { file_path: workbook, range: 'Sheet1!B2', content: [[99]] }));
    assert.match(success(await call('read_file', { path: workbook, range: 'A1:B2' })), /99/);
    const docx = join(workspace, 'note.docx');
    success(await call('write_file', { path: docx, content: '# Native document\n\nBody from private MCP.' }));
    assert.match(success(await call('read_file', { path: docx })), /Body from private MCP/);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([300, 200]).drawText('PDF fixture from private MCP', { x: 10, y: 100, font, size: 12 });
    pdf.addPage([300, 200]).drawText('Second fixture page', { x: 10, y: 100, font, size: 12 });
    const pdfPath = join(workspace, 'document.pdf');
    await writeFile(pdfPath, await pdf.save());
    const pdfText = success(await call('read_file', { path: pdfPath }));
    assert.match(pdfText, /PDF fixture from private MCP/);
    const editedPdf = join(workspace, 'edited.pdf');
    success(await call('write_pdf', { path: pdfPath, content: [{ type: 'delete', pageIndexes: [1] }], outputPath: editedPdf }));
    assert.equal((await PDFDocument.load(await readFile(editedPdf))).getPageCount(), 1);
    await t.test('PDF creation uses the configured local Chrome', { skip: !chromePath }, async () => {
      const rendered = join(workspace, 'rendered.pdf');
      success(await call('write_pdf', { path: rendered, content: '# Rendered privately\n\nLocal browser renderer.' }));
      assert.ok((await readFile(rendered)).subarray(0, 4).equals(Buffer.from('%PDF')));
      assert.match(success(await call('read_file', { path: rendered })), /Rendered privately/);
    });
    success(await call('get_usage_stats'));
    assert.match(success(await call('get_recent_tool_calls', { maxResults: 5 })), /read_file|write_pdf/);
    success(await call('give_feedback_to_desktop_commander'));
    assert.ok((await readFile(join(privateState, 'feedback.jsonl'), 'utf8')).includes('"at"'));
    assert.deepEqual([...invoked].sort(), nativeTools.slice().sort());
  } catch (error) { t.diagnostic(diagnostics); throw error; }
  finally { await client.close(); await rm(folder, { recursive: true, force: true }); }
});
